import { describe, expect, it } from "vitest";
import { FIXTURE_TIME, fixtureResultsFor, personFixtureResultsFor } from "@clf/fixtures";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { MemoryRepository } from "../src/storage/repository.js";
import { EngineError, JobEngine, type EngineClient } from "../src/job/engine.js";
import type { ApiLookup } from "@clf/matching";
import type { AppSettings, RawRow } from "../src/types.js";

function inputName(lookup: ApiLookup): string {
  return lookup.kind === "person" ? lookup.fullName : lookup.companyName;
}

function inputDomain(lookup: ApiLookup): string | undefined {
  return lookup.kind === "person" ? undefined : lookup.officialDomain;
}

const TOKEN_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  accessToken: "test-token-0123456789abcdef",
  operatorName: "Test Operator",
  batchSize: 10,
};

class TestClient implements EngineClient {
  public calls: Array<{ keys: string[]; idempotencyKey: string; lookups: number }> = [];
  private readonly handler: (
    lookups: Parameters<EngineClient["search"]>[0],
    call: number,
  ) => Promise<Awaited<ReturnType<EngineClient["search"]>>>;

  constructor(
    handler: (
      lookups: Parameters<EngineClient["search"]>[0],
      call: number,
    ) => Promise<Awaited<ReturnType<EngineClient["search"]>>>,
  ) {
    this.handler = handler;
  }

  public async search(
    lookups: Parameters<EngineClient["search"]>[0],
    idempotencyKey: string,
  ): ReturnType<EngineClient["search"]> {
    this.calls.push({
      keys: lookups.map(inputName),
      idempotencyKey,
      lookups: lookups.length,
    });
    return this.handler(lookups, this.calls.length);
  }
}

function responseFor(
  lookups: Parameters<EngineClient["search"]>[0],
  resultsFor: (
    lookup: Parameters<EngineClient["search"]>[0][number],
    query: string,
  ) => ReturnType<typeof fixtureResultsFor>,
) {
  return {
    schemaVersion: 1 as const,
    provider: "fake",
    generatedAt: FIXTURE_TIME,
    results: lookups.map((lookup) => {
      const query = `site:linkedin.com/company/ "${inputName(lookup)}"`;
      return {
        id: lookup.id,
        queries: [{ query, shape: "primary" as const, rationale: "test" }],
        results: resultsFor(lookup, query),
        errors: [],
        cached: false,
      };
    }),
  };
}

function generatedClient(): TestClient {
  return new TestClient(async (lookups) =>
    responseFor(lookups, (lookup, query) => {
      const slug = inputName(lookup)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      return [
        {
          originalUrl: `https://www.linkedin.com/company/${slug}/`,
          title: `${inputName(lookup)} | LinkedIn`,
          snippet: inputDomain(lookup) ?? "",
          provider: "fake",
          query,
          shape: "primary",
          retrievedAt: FIXTURE_TIME,
        },
      ];
    }),
  );
}

function acmeClient(): TestClient {
  return new TestClient(async (lookups) =>
    responseFor(lookups, (_lookup, query) => fixtureResultsFor("Acme", query, "primary", FIXTURE_TIME)),
  );
}

function personClient(fullName = "Ada Lovelace"): TestClient {
  return new TestClient(async (lookups) => {
    const queryFor = (lookup: ApiLookup) => `site:linkedin.com/in/ "${inputName(lookup)}"`;
    return {
      schemaVersion: 1 as const,
      provider: "fake",
      generatedAt: FIXTURE_TIME,
      results: lookups.map((lookup) => {
        const query = queryFor(lookup);
        return {
          id: lookup.id,
          queries: [{ query, shape: "primary" as const, rationale: "test" }],
          results: personFixtureResultsFor(fullName, query, "primary", FIXTURE_TIME),
          errors: [],
          cached: false,
        };
      }),
    };
  });
}

function names(count: number): RawRow[] {
  return Array.from({ length: count }, (_, index) => ({ companyName: `Company ${index + 1}` }));
}

type Harness = {
  repo: MemoryRepository;
  clock: { now: number };
  makeEngine: (
    client: EngineClient,
    settings?: AppSettings,
    assist?: (
      inputs: Array<{ lookupKey: string; input: import("@clf/matching").PersonInput }>,
    ) => Promise<Record<string, string[]>>,
  ) => JobEngine;
};

function harness(): Harness {
  const repo = new MemoryRepository();
  const clock = { now: Date.parse(FIXTURE_TIME) };
  const makeEngine = (
    client: EngineClient,
    settings: AppSettings = TOKEN_SETTINGS,
    assist?: (
      inputs: Array<{ lookupKey: string; input: import("@clf/matching").PersonInput }>,
    ) => Promise<Record<string, string[]>>,
  ) =>
    new JobEngine({
      repository: repo,
      client,
      getSettings: async () => settings,
      now: () => new Date(clock.now),
      ...(assist ? { assistPersonQueries: assist } : {}),
    });
  return { repo, clock, makeEngine };
}

describe("JobEngine — batch execution", () => {
  it("processes 100 rows in batches and completes", async () => {
    const { repo, makeEngine } = harness();
    const client = generatedClient();
    const engine = makeEngine(client);
    const job = await engine.createJob(names(100), { batchSize: 10 });
    await engine.run(job.id);

    expect(client.calls).toHaveLength(10);
    expect(client.calls.every((call) => call.lookups === 10)).toBe(true);
    const rows = await repo.getRows(job.id);
    expect(rows).toHaveLength(100);
    expect(rows.every((row) => row.status === "MATCHED")).toBe(true);
    expect(
      rows.every((row) => row.selectedUrl?.startsWith("https://www.linkedin.com/company/company-")),
    ).toBe(true);
    const snapshot = await engine.snapshot(job.id);
    expect(snapshot?.job.state).toBe("completed");
    expect(snapshot?.stats.MATCHED).toBe(100);
  });

  it("uses one lookup for duplicate rows while preserving every original row", async () => {
    const { repo, makeEngine } = harness();
    const client = generatedClient();
    const engine = makeEngine(client);
    const rows: RawRow[] = [];
    for (let index = 0; index < 100; index += 1) rows.push({ companyName: `Company ${(index % 10) + 1}` });
    const job = await engine.createJob(rows, { batchSize: 10 });
    expect(job.totalLookups).toBe(10);
    await engine.run(job.id);
    expect(client.calls).toHaveLength(1);
    const stored = await repo.getRows(job.id);
    expect(stored).toHaveLength(100);
    expect(new Set(stored.map((row) => row.selectedUrl)).size).toBe(10);
  });

  it("continues a 100-row job after the engine is recreated", async () => {
    const { repo, makeEngine } = harness();
    const firstClient = new TestClient(async (lookups, call) => {
      if (call > 4)
        throw { code: "provider_unavailable", message: "down", status: 503, retryable: true, kind: "http" };
      const good = generatedClient();
      return good.search(lookups, "ignored");
    });
    const first = makeEngine(firstClient);
    const job = await first.createJob(names(100), { batchSize: 10 });
    await first.run(job.id);
    expect((await repo.getJob(job.id))?.state).toBe("paused");

    const secondClient = generatedClient();
    const second = makeEngine(secondClient);
    await second.resume(job.id);
    await second.retryFailed(job.id);
    await second.run(job.id);

    const rows = await repo.getRows(job.id);
    expect(rows.every((row) => row.status === "MATCHED")).toBe(true);
    expect((await repo.getJob(job.id))?.state).toBe("completed");
    expect(secondClient.calls.length).toBeGreaterThan(0);
  });

  it("recovers lookups left IN_PROGRESS by a terminated service worker", async () => {
    const { repo, makeEngine } = harness();
    const client = generatedClient();
    const engine = makeEngine(client);
    const job = await engine.createJob(names(4), { batchSize: 2 });
    const lookups = await repo.getLookupsByStatus(job.id, ["PENDING"], 10);
    await repo.putLookups(lookups.map((lookup) => ({ ...lookup, status: "IN_PROGRESS" as const })));
    const rows = await repo.getRows(job.id);
    await repo.putRows(rows.map((row) => ({ ...row, status: "IN_PROGRESS" as const })));

    await engine.run(job.id);
    const stored = await repo.getRows(job.id);
    expect(stored.every((row) => row.status === "MATCHED")).toBe(true);
    expect((await repo.getJob(job.id))?.state).toBe("completed");
  });

  it("keeps ambiguous results in review with no selected URL", async () => {
    const { repo, makeEngine } = harness();
    const engine = makeEngine(acmeClient());
    const job = await engine.createJob([{ companyName: "Acme" }]);
    await engine.run(job.id);
    const [row] = await repo.getRows(job.id);
    expect(row?.status).toBe("REVIEW_REQUIRED");
    expect(row?.selectedUrl).toBeNull();
    expect(row?.evaluation?.candidates).toHaveLength(2);
  });

  it("records provider failures as retryable errors and never as matches", async () => {
    const { repo, makeEngine } = harness();
    const client = new TestClient(async () => {
      throw { code: "provider_unavailable", message: "down", status: 503, retryable: true, kind: "http" };
    });
    const engine = makeEngine(client);
    const job = await engine.createJob([{ companyName: "Company 1" }]);
    await engine.run(job.id);
    const [row] = await repo.getRows(job.id);
    expect(row?.status).toBe("ERROR");
    expect(row?.selectedUrl).toBeNull();
    expect(row?.error).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect((await repo.getJob(job.id))?.pauseReason).toBe("network");
  });

  it("pauses on an access-token failure and keeps the batch queued", async () => {
    const { repo, makeEngine } = harness();
    const client = new TestClient(async () => {
      throw { code: "unauthorized", message: "bad token", status: 401, retryable: false, kind: "http" };
    });
    const engine = makeEngine(client);
    const job = await engine.createJob([{ companyName: "Company 1" }]);
    await engine.run(job.id);
    const [row] = await repo.getRows(job.id);
    expect(row?.status).toBe("PENDING");
    expect((await repo.getJob(job.id))?.state).toBe("paused");
    expect((await repo.getJob(job.id))?.pauseReason).toBe("auth");
  });

  it("honours a rate-limit cooldown and resumes automatically", async () => {
    const { repo, clock, makeEngine } = harness();
    let limited = true;
    const client = new TestClient(async (lookups) => {
      if (limited) {
        limited = false;
        throw {
          code: "provider_rate_limited",
          message: "slow down",
          status: 429,
          retryable: true,
          retryAfterSeconds: 30,
          kind: "http",
        };
      }
      return generatedClient().search(lookups, "x");
    });
    const engine = makeEngine(client);
    const job = await engine.createJob([{ companyName: "Company 1" }]);
    await engine.run(job.id);
    const paused = await repo.getJob(job.id);
    expect(paused?.state).toBe("paused");
    expect(paused?.pauseReason).toBe("rate_limit");
    expect(paused?.cooldownUntil).toBeTruthy();

    expect(await engine.autoResumeIfReady(job.id)).toBe(false);
    clock.now += 31_000;
    expect(await engine.autoResumeIfReady(job.id)).toBe(true);

    const [row] = await repo.getRows(job.id);
    expect(row?.status).toBe("MATCHED");
  });

  it("pauses and resumes on user request", async () => {
    const { repo, makeEngine } = harness();
    const engine = makeEngine(generatedClient());
    const job = await engine.createJob(names(10), { batchSize: 5 });
    await engine.pause(job.id);
    await engine.run(job.id);
    expect((await repo.getJob(job.id))?.state).toBe("paused");
    expect((await repo.getJob(job.id))?.pauseReason).toBe("user");
    await engine.resume(job.id);
    await engine.run(job.id);
    expect((await repo.getJob(job.id))?.state).toBe("completed");
  });

  it("cancels a job and refuses to resume it", async () => {
    const { repo, makeEngine } = harness();
    const engine = makeEngine(generatedClient());
    const job = await engine.createJob(names(10));
    await engine.cancel(job.id);
    await engine.run(job.id);
    expect((await repo.getJob(job.id))?.state).toBe("cancelled");
    await expect(engine.resume(job.id)).rejects.toBeInstanceOf(EngineError);
  });

  it("rejects empty and oversized batches", async () => {
    const { makeEngine } = harness();
    const engine = makeEngine(generatedClient());
    await expect(engine.createJob([])).rejects.toMatchObject({ code: "invalid_rows" });
    await expect(
      engine.createJob(Array.from({ length: 5001 }, () => ({ companyName: "A" }))),
    ).rejects.toMatchObject({ code: "invalid_rows" });
    await expect(engine.createJob([{ companyName: "   " }])).rejects.toMatchObject({ code: "invalid_rows" });
  });

  it("processes a person batch and selects only a validated /in/ profile", async () => {
    const { repo, makeEngine } = harness();
    const client = personClient();
    const engine = makeEngine(client);
    const job = await engine.createJob([
      {
        kind: "person",
        fullName: "Ada Lovelace",
        company: "Analytical Engines",
        jobTitle: "Mathematician",
        location: "London",
      },
    ]);
    await engine.run(job.id);
    const [row] = await repo.getRows(job.id);
    expect(job.mode).toBe("person");
    expect(row?.kind).toBe("person");
    expect(row?.status).toBe("MATCHED");
    expect(row?.selectedUrl).toBe("https://www.linkedin.com/in/ada-lovelace/");
  });

  it("sends validated AI queries to the resolver and surfaces AI failure without failing the batch", async () => {
    const { repo, makeEngine } = harness();
    const seen: ApiLookup[] = [];
    const client = new TestClient(async (lookups) => {
      seen.push(...lookups);
      const query = 'site:linkedin.com/in/ "Ada Lovelace"';
      return {
        schemaVersion: 1 as const,
        provider: "fake",
        generatedAt: FIXTURE_TIME,
        results: lookups.map((lookup) => ({
          id: lookup.id,
          queries: [{ query, shape: "primary" as const, rationale: "test" }],
          results: personFixtureResultsFor("Ada Lovelace", query, "primary", FIXTURE_TIME),
          errors: [],
          cached: false,
        })),
      };
    });
    const assist = async (items: Array<{ lookupKey: string }>) => ({
      [items[0]?.lookupKey ?? ""]: ['site:linkedin.com/in/ "Ada Lovelace" "Countess of Lovelace"'],
    });
    const engine = makeEngine(client, TOKEN_SETTINGS, assist);
    const job = await engine.createJob([
      { kind: "person", fullName: "Ada Lovelace", company: "Analytical Engines" },
    ]);
    await engine.run(job.id);
    expect(seen[0]?.kind).toBe("person");
    expect(seen[0]?.kind === "person" ? seen[0]?.extraQueries?.[0] : undefined).toContain("Countess");
    const [row] = await repo.getRows(job.id);
    expect(row?.status).toBe("MATCHED");

    const failing = makeEngine(personClient(), TOKEN_SETTINGS, async () => {
      throw new Error("quota exhausted");
    });
    const second = await failing.createJob([
      { kind: "person", fullName: "Ada Lovelace", company: "Analytical Engines" },
    ]);
    await failing.run(second.id);
    expect((await repo.getJob(second.id))?.aiNote).toContain("AI provider request failed");
    const [secondRow] = await repo.getRows(second.id);
    expect(secondRow?.status).toBe("MATCHED");
  });

  it("refuses to mix companies and people in one batch", async () => {
    const { makeEngine } = harness();
    const engine = makeEngine(generatedClient());
    await expect(
      engine.createJob([{ companyName: "Acme" }, { kind: "person", fullName: "Ada Lovelace" }]),
    ).rejects.toMatchObject({ code: "invalid_rows" });
  });
});

describe("JobEngine — human decisions", () => {
  it("accepts and rejects only provider-returned candidates with an audit trail", async () => {
    const { repo, makeEngine } = harness();
    const engine = makeEngine(acmeClient());
    const job = await engine.createJob([{ companyName: "Acme" }]);
    await engine.run(job.id);
    const [row] = await repo.getRows(job.id);
    const candidate = row?.evaluation?.candidates[0];
    expect(candidate).toBeTruthy();
    if (!row || !candidate) throw new Error("fixture setup failed");

    const confirmed = await engine.acceptCandidate(job.id, row.id, candidate.canonicalUrl);
    expect(confirmed.status).toBe("USER_CONFIRMED");
    expect(confirmed.selectedUrl).toBe(candidate.canonicalUrl);
    expect(confirmed.confirmedBy?.actor).toBe("Test Operator");

    const rejected = await engine.rejectCandidate(job.id, row.id, candidate.canonicalUrl);
    expect(rejected.status).toBe("REVIEW_REQUIRED");
    expect(rejected.selectedUrl).toBeNull();

    const audit = await engine.listAudit(job.id, row.id);
    expect(audit.map((entry) => entry.action)).toContain("candidate_accepted");
    expect(audit.map((entry) => entry.action)).toContain("candidate_rejected");
  });

  it("refuses a URL that the provider never returned", async () => {
    const { makeEngine } = harness();
    const engine = makeEngine(acmeClient());
    const job = await engine.createJob([{ companyName: "Acme" }]);
    await engine.run(job.id);
    const [row] = await engine.listRows(job.id);
    if (!row) throw new Error("missing row");
    await expect(
      engine.acceptCandidate(job.id, row.id, "https://www.linkedin.com/company/guessed-slug/"),
    ).rejects.toMatchObject({ code: "candidate_not_found" });
  });

  it("re-queues a row after context is added and preserves the raw company name", async () => {
    const { repo, makeEngine } = harness();
    const client = new TestClient(async (lookups) => {
      const hasDomain = lookups.every((lookup) => inputDomain(lookup) === "acme.com");
      if (!hasDomain) {
        return responseFor(lookups, (_lookup, query) =>
          fixtureResultsFor("Acme", query, "primary", FIXTURE_TIME),
        );
      }
      return responseFor(lookups, (_lookup, query) => [
        {
          originalUrl: "https://www.linkedin.com/company/acme/",
          title: "Acme | LinkedIn",
          snippet: "acme.com",
          provider: "fake",
          query,
          shape: "primary",
          retrievedAt: FIXTURE_TIME,
        },
      ]);
    });
    const engine = makeEngine(client);
    const job = await engine.createJob([{ companyName: "Acme" }]);
    await engine.run(job.id);
    const [before] = await repo.getRows(job.id);
    if (!before) throw new Error("missing row");
    const oldKey = before.lookupKey;

    await engine.updateRowContext(job.id, before.id, { officialDomain: "acme.com" });
    await engine.run(job.id);
    const [after] = await repo.getRows(job.id);
    expect(after?.raw.kind).not.toBe("person");
    expect(after?.raw.kind === "person" ? "" : after?.raw.companyName).toBe("Acme");
    expect(after?.raw.kind === "person" ? "" : after?.raw.officialDomain).toBe("acme.com");
    expect(after?.status).toBe("MATCHED");
    expect(after?.lookupKey).not.toBe(oldKey);
    expect(await repo.getLookup(job.id, oldKey)).toBeNull();
  });

  it("retries failed rows with a stable idempotency key", async () => {
    const { repo, makeEngine } = harness();
    let failing = true;
    const client = new TestClient(async (lookups) => {
      if (failing) {
        failing = false;
        throw { code: "provider_unavailable", message: "down", status: 503, retryable: true, kind: "http" };
      }
      return generatedClient().search(lookups, "x");
    });
    const engine = makeEngine(client);
    const job = await engine.createJob([{ companyName: "Company 1" }]);
    await engine.run(job.id);
    const [failed] = await repo.getRows(job.id);
    expect(failed?.status).toBe("ERROR");

    expect(await engine.retryFailed(job.id)).toBe(1);
    await engine.run(job.id);
    const [row] = await repo.getRows(job.id);
    expect(row?.status).toBe("MATCHED");
    expect(new Set(client.calls.map((call) => call.idempotencyKey)).size).toBe(1);
  });
});
