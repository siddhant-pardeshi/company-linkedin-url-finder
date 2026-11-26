import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_TIME } from "@clf/fixtures";
import type { AuditRecord, Job, LookupRecord, ResultRow } from "../src/types.js";
import { IdbRepository } from "../src/storage/idb.js";

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    state: "running",
    totalRows: 2,
    totalLookups: 2,
    batchSize: 5,
    operatorName: "Tester",
    pauseReason: null,
    lastError: null,
    cooldownUntil: null,
    startedAt: FIXTURE_TIME,
    finishedAt: null,
    ...overrides,
  };
}

function row(
  jobId: string,
  index: number,
  lookupKey: string,
  status: ResultRow["status"] = "PENDING",
): ResultRow {
  return {
    id: `${jobId}:${index}`,
    jobId,
    rowIndex: index,
    raw: { companyName: `Company ${index}` },
    lookupKey,
    status,
    selectedUrl: null,
    confidence: "none",
    evaluation: null,
    provider: null,
    checkedAt: null,
    error: null,
    confirmedBy: null,
    rejectedCandidates: [],
    updatedAt: FIXTURE_TIME,
  };
}

function lookup(jobId: string, key: string, status: LookupRecord["status"] = "PENDING"): LookupRecord {
  return {
    key: `${jobId}|${key}`,
    jobId,
    lookupKey: key,
    input: { companyName: `Company ${key}` },
    status,
    queries: [],
    evaluation: null,
    provider: null,
    checkedAt: null,
    error: null,
    updatedAt: FIXTURE_TIME,
  };
}

function auditEntry(jobId: string, id: string): AuditRecord {
  return {
    id,
    jobId,
    action: "job_created",
    actor: "Tester",
    at: FIXTURE_TIME,
    detail: "created",
  };
}

let repo: IdbRepository;

beforeEach(async () => {
  repo = await IdbRepository.create();
  await repo.clearAll();
});

describe("IdbRepository", () => {
  it("stores jobs and returns the most recently updated one", async () => {
    await repo.putJob(job("a", { updatedAt: "2026-11-20T09:00:00.000Z" }));
    await repo.putJob(job("b", { updatedAt: "2026-11-20T11:00:00.000Z" }));
    expect(await repo.getJob("a")).toMatchObject({ id: "a", batchSize: 5 });
    expect((await repo.getLatestJob())?.id).toBe("b");
    expect(await repo.getJob("missing")).toBeNull();
  });

  it("round-trips rows, sorts them, and filters by lookup key", async () => {
    await repo.putRows([row("job", 2, "k2"), row("job", 1, "k1"), row("job2", 1, "k1")]);
    const rows = await repo.getRows("job");
    expect(rows.map((entry) => entry.rowIndex)).toEqual([1, 2]);
    expect(rows[0]?.raw.companyName).toBe("Company 1");

    const byLookup = await repo.getRowsByLookupKeys("job", ["k1", "k2", "k1"]);
    expect(byLookup).toHaveLength(2);
    expect(byLookup.every((entry) => entry.jobId === "job")).toBe(true);
    expect(await repo.getRowsByLookupKeys("job", [])).toEqual([]);

    expect((await repo.getRow("job:1"))?.rowIndex).toBe(1);
    expect(await repo.getRow("missing")).toBeNull();
  });

  it("queries lookups by status with a limit", async () => {
    await repo.putLookups([
      lookup("job", "a"),
      lookup("job", "b"),
      lookup("job", "c", "RESOLVED"),
      lookup("job2", "a"),
    ]);
    const pending = await repo.getLookupsByStatus("job", ["PENDING"], 1);
    expect(pending).toHaveLength(1);
    const all = await repo.getLookupsByStatus("job", ["PENDING", "RESOLVED"], 10);
    expect(all).toHaveLength(3);
    expect((await repo.getLookup("job", "b"))?.lookupKey).toBe("b");
    expect(await repo.getLookup("job", "missing")).toBeNull();

    await repo.deleteLookup("job", "b");
    expect(await repo.getLookup("job", "b")).toBeNull();
  });

  it("filters audit entries by job and row", async () => {
    await repo.putAudit(auditEntry("job", "a1"));
    await repo.putAudit({ ...auditEntry("job", "a2"), rowId: "job:1", action: "candidate_accepted" });
    await repo.putAudit(auditEntry("other", "a3"));
    expect(await repo.listAudit("job")).toHaveLength(2);
    expect(await repo.listAudit("job", "job:1")).toEqual([
      expect.objectContaining({ id: "a2", action: "candidate_accepted" }),
    ]);
  });

  it("cascades deletes across rows, lookups, and audit", async () => {
    await repo.putJob(job("job"));
    await repo.putRows([row("job", 1, "k1")]);
    await repo.putLookups([lookup("job", "k1")]);
    await repo.putAudit(auditEntry("job", "a1"));
    await repo.deleteJob("job");
    expect(await repo.getJob("job")).toBeNull();
    expect(await repo.getRows("job")).toEqual([]);
    expect(await repo.getLookup("job", "k1")).toBeNull();
    expect(await repo.listAudit("job")).toEqual([]);
  });

  it("deletes jobs older than a cutoff", async () => {
    await repo.putJob(job("old", { createdAt: "2026-10-01T00:00:00.000Z" }));
    await repo.putJob(job("new", { createdAt: "2026-11-20T00:00:00.000Z" }));
    await repo.putRows([row("old", 1, "k1")]);
    expect(await repo.deleteJobsOlderThan("2026-11-01T00:00:00.000Z")).toBe(1);
    expect(await repo.getJob("old")).toBeNull();
    expect(await repo.getJob("new")).not.toBeNull();
    expect(await repo.getRows("old")).toEqual([]);
  });

  it("clears everything", async () => {
    await repo.putJob(job("job"));
    await repo.putRows([row("job", 1, "k1")]);
    await repo.putLookups([lookup("job", "k1")]);
    await repo.putAudit(auditEntry("job", "a1"));
    await repo.clearAll();
    expect(await repo.getLatestJob()).toBeNull();
    expect(await repo.getRows("job")).toEqual([]);
    expect(await repo.getLookupsByStatus("job", ["PENDING"], 10)).toEqual([]);
    expect(await repo.listAudit("job")).toEqual([]);
  });
});
