import { describe, expect, it } from "vitest";
import { FIXTURE_TIME, fixtureResultsFor, personFixtureResultsFor } from "@clf/fixtures";
import type { ApiLookup, RawSearchResult, SearchRequest, SearchResponse } from "@clf/matching";
import { IdempotencyCache } from "../src/cache.js";
import { silentLogger } from "./helpers.js";
import type { SearchContext, SearchProvider } from "../src/providers/types.js";
import { ProviderSearchError } from "../src/providers/types.js";
import { Semaphore } from "../src/semaphore.js";
import { ResolverError, ResolverService, type ResolverServiceOptions } from "../src/service.js";

class FakeProvider implements SearchProvider {
  public readonly name = "fake";
  public calls: Array<{ query: string; shape: string }> = [];
  private readonly handler: (
    query: string,
    context: SearchContext,
    call: number,
  ) => Promise<RawSearchResult[]>;

  constructor(handler: (query: string, context: SearchContext, call: number) => Promise<RawSearchResult[]>) {
    this.handler = handler;
  }

  public async search(query: string, context: SearchContext): Promise<RawSearchResult[]> {
    this.calls.push({ query, shape: context.shape });
    return this.handler(query, context, this.calls.length);
  }
}

function microsoftProvider(): FakeProvider {
  return new FakeProvider(async (query, context) =>
    fixtureResultsFor("Microsoft", query, context.shape, context.retrievedAt),
  );
}

type Harness = {
  service: ResolverService;
  provider: FakeProvider;
  clock: { now: number };
  sleeps: number[];
};

function harness(
  provider: FakeProvider,
  overrides: Partial<ResolverServiceOptions> = {},
  clock: { now: number } = { now: Date.parse(FIXTURE_TIME) },
): Harness {
  const sleeps: number[] = [];
  const service = new ResolverService({
    provider,
    cache: new IdempotencyCache<SearchResponse>({ ttlMs: 60_000, now: () => clock.now }),
    logger: silentLogger(),
    semaphore: new Semaphore(2),
    now: () => new Date(clock.now),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 4000, jitterRatio: 0 },
    batchTimeoutMs: 5000,
    ...overrides,
  });
  return { service, provider, clock, sleeps };
}

function request(lookups: ApiLookup[], key = "idem-key-123456"): SearchRequest {
  return { schemaVersion: 1, idempotencyKey: key, lookups };
}

describe("ResolverService", () => {
  it("plans company-restricted queries and returns verbatim evidence", async () => {
    const provider = microsoftProvider();
    const { service } = harness(provider);
    const response = await service.resolve(request([{ id: "r1", companyName: "Microsoft" }]), "fp1");

    expect(response.provider).toBe("fake");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.queries.map((query) => query.shape)).toEqual(["primary", "reshaped"]);
    expect(
      response.results[0]?.queries.every((query) => query.query.includes("site:linkedin.com/company/")),
    ).toBe(true);
    expect(response.results[0]?.results).toHaveLength(2);
    expect(response.results[0]?.errors).toEqual([]);
    expect(response.results[0]?.results[0]?.provider).toBe("fixture");
    expect(provider.calls).toHaveLength(2);
  });

  it("plans person-profile queries and returns /in/ evidence", async () => {
    const provider = new FakeProvider(async (query, context) =>
      personFixtureResultsFor("Ada Lovelace", query, context.shape, context.retrievedAt),
    );
    const { service } = harness(provider);
    const response = await service.resolve(
      request([
        {
          id: "p1",
          kind: "person",
          fullName: "Ada Lovelace",
          company: "Analytical Engines",
          jobTitle: "Mathematician",
          location: "London",
        },
      ]),
      "fp-person",
    );
    const queryShapes = response.results[0]?.queries.map((query) => query.shape);
    expect(queryShapes).toEqual(expect.arrayContaining(["primary", "company", "title"]));
    expect(response.results[0]?.queries.every((query) => query.query.includes("site:linkedin.com/in/"))).toBe(
      true,
    );
    expect(response.results[0]?.results[0]?.originalUrl).toContain("linkedin.com/in/ada-lovelace");
  });

  it("stops the batch on a provider rate limit and does not cache the failure", async () => {
    const provider = new FakeProvider(async () => {
      throw new ProviderSearchError("provider_rate_limited", "quota", true, 30_000);
    });
    const { service } = harness(provider);
    const response = await service.resolve(
      request([
        { id: "r1", companyName: "Microsoft" },
        { id: "r2", companyName: "Acme" },
      ]),
      "fp1",
    );
    expect(provider.calls).toHaveLength(1);
    expect(response.results.map((result) => result.errors[0]?.code)).toEqual([
      "provider_rate_limited",
      "provider_rate_limited",
    ]);
    expect(response.results[0]?.errors[0]?.retryAfterSeconds).toBe(30);

    await service.resolve(
      request([
        { id: "r1", companyName: "Microsoft" },
        { id: "r2", companyName: "Acme" },
      ]),
      "fp1",
    );
    expect(provider.calls).toHaveLength(2);
  });

  it("stops the batch on provider credential failure", async () => {
    const provider = new FakeProvider(async () => {
      throw new ProviderSearchError("provider_auth_failed", "bad key", false);
    });
    const { service } = harness(provider);
    const response = await service.resolve(
      request([
        { id: "r1", companyName: "Microsoft" },
        { id: "r2", companyName: "Acme" },
      ]),
      "fp1",
    );
    expect(provider.calls).toHaveLength(1);
    expect(response.results.every((result) => result.errors[0]?.code === "provider_auth_failed")).toBe(true);
  });

  it("retries transient failures with bounded backoff", async () => {
    const provider = new FakeProvider(async (query, context, call) => {
      if (call <= 2) throw new ProviderSearchError("provider_unavailable", "down", true);
      return fixtureResultsFor("Microsoft", query, context.shape, context.retrievedAt);
    });
    const { service, sleeps } = harness(provider);
    const response = await service.resolve(request([{ id: "r1", companyName: "Microsoft" }]), "fp1");
    expect(provider.calls).toHaveLength(4);
    expect(sleeps).toEqual([10, 20]);
    expect(response.results[0]?.errors).toEqual([]);
    expect(response.results[0]?.results.length).toBeGreaterThan(0);
  });

  it("records unexpected provider failures as retryable lookup errors", async () => {
    const provider = new FakeProvider(async () => {
      throw new Error("boom");
    });
    const { service } = harness(provider);
    const response = await service.resolve(
      request([
        { id: "r1", companyName: "Microsoft" },
        { id: "r2", companyName: "Acme" },
      ]),
      "fp1",
    );
    expect(response.results[0]?.errors[0]).toMatchObject({ code: "lookup_failed", retryable: true });
    expect(response.results[1]?.errors).toHaveLength(1);
  });

  it("enforces a batch time budget", async () => {
    const clock = { now: Date.parse(FIXTURE_TIME) };
    const slowProvider = new FakeProvider(async (query, context) => {
      clock.now += 10_000;
      return fixtureResultsFor("Microsoft", query, context.shape, context.retrievedAt);
    });
    const { service } = harness(slowProvider, { batchTimeoutMs: 5000 }, clock);
    const response = await service.resolve(
      request([
        { id: "r1", companyName: "Microsoft" },
        { id: "r2", companyName: "Acme" },
      ]),
      "fp1",
    );
    expect(slowProvider.calls).toHaveLength(1);
    expect(response.results[1]?.errors[0]?.code).toBe("provider_timeout");
  });

  it("serves an idempotent replay from cache and rejects key reuse with a different payload", async () => {
    const provider = microsoftProvider();
    const { service } = harness(provider);
    const first = await service.resolve(
      request([{ id: "r1", companyName: "Microsoft" }], "same-key-123456"),
      "fp1",
    );
    const second = await service.resolve(
      request([{ id: "r1", companyName: "Microsoft" }], "same-key-123456"),
      "fp1",
    );
    expect(provider.calls).toHaveLength(2);
    expect(second.results[0]?.cached).toBe(true);
    expect(second.results[0]?.results).toEqual(first.results[0]?.results);

    await expect(
      service.resolve(request([{ id: "r1", companyName: "Acme" }], "same-key-123456"), "fp2"),
    ).rejects.toBeInstanceOf(ResolverError);
  });
});
