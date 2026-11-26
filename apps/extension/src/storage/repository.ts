import type { AuditRecord, Job, LookupRecord, LookupStatus, ResultRow } from "../types.js";

export interface Repository {
  putJob(job: Job): Promise<void>;
  getJob(id: string): Promise<Job | null>;
  getLatestJob(): Promise<Job | null>;
  deleteJob(id: string): Promise<void>;

  putRows(rows: ResultRow[]): Promise<void>;
  getRows(jobId: string): Promise<ResultRow[]>;
  getRow(id: string): Promise<ResultRow | null>;
  getRowsByLookupKeys(jobId: string, lookupKeys: readonly string[]): Promise<ResultRow[]>;

  putLookups(lookups: LookupRecord[]): Promise<void>;
  getLookup(jobId: string, lookupKey: string): Promise<LookupRecord | null>;
  getLookupsByStatus(
    jobId: string,
    statuses: readonly LookupStatus[],
    limit: number,
  ): Promise<LookupRecord[]>;
  deleteLookup(jobId: string, lookupKey: string): Promise<void>;

  putAudit(entry: AuditRecord): Promise<void>;
  listAudit(jobId: string, rowId?: string): Promise<AuditRecord[]>;

  clearAll(): Promise<void>;
  deleteJobsOlderThan(cutoffIso: string): Promise<number>;
}

/**
 * In-memory repository used by unit tests. It mirrors the IndexedDB
 * implementation's semantics, including sorted reads and cascade deletes.
 */
export class MemoryRepository implements Repository {
  private readonly jobs = new Map<string, Job>();
  private readonly rows = new Map<string, ResultRow>();
  private readonly lookups = new Map<string, LookupRecord>();
  private readonly audit: AuditRecord[] = [];

  public async putJob(job: Job): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  public async getJob(id: string): Promise<Job | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  public async getLatestJob(): Promise<Job | null> {
    const sorted = [...this.jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sorted[0] ? structuredClone(sorted[0]!) : null;
  }

  public async deleteJob(id: string): Promise<void> {
    this.jobs.delete(id);
    for (const [key, row] of this.rows) if (row.jobId === id) this.rows.delete(key);
    for (const [key, lookup] of this.lookups) if (lookup.jobId === id) this.lookups.delete(key);
    for (let index = this.audit.length - 1; index >= 0; index -= 1) {
      if (this.audit[index]?.jobId === id) this.audit.splice(index, 1);
    }
  }

  public async putRows(rows: ResultRow[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
  }

  public async getRows(jobId: string): Promise<ResultRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.jobId === jobId)
      .sort((a, b) => a.rowIndex - b.rowIndex)
      .map((row) => structuredClone(row));
  }

  public async getRow(id: string): Promise<ResultRow | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  public async getRowsByLookupKeys(jobId: string, lookupKeys: readonly string[]): Promise<ResultRow[]> {
    const keys = new Set(lookupKeys);
    return [...this.rows.values()]
      .filter((row) => row.jobId === jobId && keys.has(row.lookupKey))
      .sort((a, b) => a.rowIndex - b.rowIndex)
      .map((row) => structuredClone(row));
  }

  public async putLookups(lookups: LookupRecord[]): Promise<void> {
    for (const lookup of lookups) this.lookups.set(lookup.key, structuredClone(lookup));
  }

  public async getLookup(jobId: string, lookupKey: string): Promise<LookupRecord | null> {
    const lookup = this.lookups.get(`${jobId}|${lookupKey}`);
    return lookup ? structuredClone(lookup) : null;
  }

  public async getLookupsByStatus(
    jobId: string,
    statuses: readonly LookupStatus[],
    limit: number,
  ): Promise<LookupRecord[]> {
    const wanted = new Set(statuses);
    return [...this.lookups.values()]
      .filter((lookup) => lookup.jobId === jobId && wanted.has(lookup.status))
      .sort((a, b) => a.lookupKey.localeCompare(b.lookupKey))
      .slice(0, Math.max(0, limit))
      .map((lookup) => structuredClone(lookup));
  }

  public async deleteLookup(jobId: string, lookupKey: string): Promise<void> {
    this.lookups.delete(`${jobId}|${lookupKey}`);
  }

  public async putAudit(entry: AuditRecord): Promise<void> {
    this.audit.push(structuredClone(entry));
  }

  public async listAudit(jobId: string, rowId?: string): Promise<AuditRecord[]> {
    return this.audit
      .filter((entry) => entry.jobId === jobId && (rowId === undefined || entry.rowId === rowId))
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((entry) => structuredClone(entry));
  }

  public async clearAll(): Promise<void> {
    this.jobs.clear();
    this.rows.clear();
    this.lookups.clear();
    this.audit.length = 0;
  }

  public async deleteJobsOlderThan(cutoffIso: string): Promise<number> {
    const victims = [...this.jobs.values()].filter((job) => job.createdAt < cutoffIso).map((job) => job.id);
    for (const id of victims) await this.deleteJob(id);
    return victims.length;
  }
}
