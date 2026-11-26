import type { AuditRecord, Job, LookupRecord, LookupStatus, ResultRow } from "../types.js";
import type { Repository } from "./repository.js";

/**
 * IndexedDB persistence for the MV3 service worker and extension pages.
 *
 * IndexedDB is used because a job can hold thousands of rows, evidence objects,
 * and audit entries; chrome.storage.local is reserved for small settings. The
 * service worker is disposable, so every batch is checkpointed here.
 */

const DB_NAME = "companyPageFinder";
const DB_VERSION = 1;

const STORE_JOBS = "jobs";
const STORE_ROWS = "rows";
const STORE_LOOKUPS = "lookups";
const STORE_AUDIT = "audit";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_JOBS)) {
    db.createObjectStore(STORE_JOBS, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(STORE_ROWS)) {
    const rows = db.createObjectStore(STORE_ROWS, { keyPath: "id" });
    rows.createIndex("jobId", "jobId");
    rows.createIndex("jobId_status", ["jobId", "status"]);
    rows.createIndex("jobId_lookupKey", ["jobId", "lookupKey"]);
  }
  if (!db.objectStoreNames.contains(STORE_LOOKUPS)) {
    const lookups = db.createObjectStore(STORE_LOOKUPS, { keyPath: "key" });
    lookups.createIndex("jobId", "jobId");
    lookups.createIndex("jobId_status", ["jobId", "status"]);
  }
  if (!db.objectStoreNames.contains(STORE_AUDIT)) {
    const audit = db.createObjectStore(STORE_AUDIT, { keyPath: "id" });
    audit.createIndex("jobId", "jobId");
  }
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open the local database"));
    request.onblocked = () =>
      reject(new Error("The local database is blocked by another tab. Close it and retry."));
  });
}

export class IdbRepository implements Repository {
  private constructor(private readonly db: IDBDatabase) {}

  public static async create(): Promise<IdbRepository> {
    return new IdbRepository(await openDatabase());
  }

  private async putAll<T>(storeName: string, values: readonly T[]): Promise<void> {
    if (values.length === 0) return;
    const transaction = this.db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    for (const value of values) store.put(value);
    await transactionDone(transaction);
  }

  public async putJob(job: Job): Promise<void> {
    await this.putAll(STORE_JOBS, [job]);
  }

  public async getJob(id: string): Promise<Job | null> {
    const transaction = this.db.transaction(STORE_JOBS, "readonly");
    const value = await requestResult<Job | undefined>(transaction.objectStore(STORE_JOBS).get(id));
    return value ?? null;
  }

  public async getLatestJob(): Promise<Job | null> {
    const transaction = this.db.transaction(STORE_JOBS, "readonly");
    const jobs = await requestResult<Job[]>(transaction.objectStore(STORE_JOBS).getAll());
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  public async deleteJob(id: string): Promise<void> {
    const rows = await this.rowsByJob(id);
    const lookups = await this.lookupsByJob(id);
    const audit = await this.auditByJob(id);
    const transaction = this.db.transaction(
      [STORE_JOBS, STORE_ROWS, STORE_LOOKUPS, STORE_AUDIT],
      "readwrite",
    );
    transaction.objectStore(STORE_JOBS).delete(id);
    const rowStore = transaction.objectStore(STORE_ROWS);
    for (const row of rows) rowStore.delete(row.id);
    const lookupStore = transaction.objectStore(STORE_LOOKUPS);
    for (const lookup of lookups) lookupStore.delete(lookup.key);
    const auditStore = transaction.objectStore(STORE_AUDIT);
    for (const entry of audit) auditStore.delete(entry.id);
    await transactionDone(transaction);
  }

  public async putRows(rows: ResultRow[]): Promise<void> {
    await this.putAll(STORE_ROWS, rows);
  }

  public async getRows(jobId: string): Promise<ResultRow[]> {
    const rows = await this.rowsByJob(jobId);
    return rows.sort((a, b) => a.rowIndex - b.rowIndex);
  }

  public async getRow(id: string): Promise<ResultRow | null> {
    const transaction = this.db.transaction(STORE_ROWS, "readonly");
    const value = await requestResult<ResultRow | undefined>(transaction.objectStore(STORE_ROWS).get(id));
    return value ?? null;
  }

  public async getRowsByLookupKeys(jobId: string, lookupKeys: readonly string[]): Promise<ResultRow[]> {
    if (lookupKeys.length === 0) return [];
    const byId = new Map<string, ResultRow>();
    for (const lookupKey of new Set(lookupKeys)) {
      const transaction = this.db.transaction(STORE_ROWS, "readonly");
      const index = transaction.objectStore(STORE_ROWS).index("jobId_lookupKey");
      const rows = await requestResult<ResultRow[]>(index.getAll(IDBKeyRange.only([jobId, lookupKey])));
      for (const row of rows) byId.set(row.id, row);
    }
    return [...byId.values()].sort((a, b) => a.rowIndex - b.rowIndex);
  }

  public async putLookups(lookups: LookupRecord[]): Promise<void> {
    await this.putAll(STORE_LOOKUPS, lookups);
  }

  public async getLookup(jobId: string, lookupKey: string): Promise<LookupRecord | null> {
    const transaction = this.db.transaction(STORE_LOOKUPS, "readonly");
    const value = await requestResult<LookupRecord | undefined>(
      transaction.objectStore(STORE_LOOKUPS).get(`${jobId}|${lookupKey}`),
    );
    return value ?? null;
  }

  public async getLookupsByStatus(
    jobId: string,
    statuses: readonly LookupStatus[],
    limit: number,
  ): Promise<LookupRecord[]> {
    const collected: LookupRecord[] = [];
    for (const status of statuses) {
      const transaction = this.db.transaction(STORE_LOOKUPS, "readonly");
      const index = transaction.objectStore(STORE_LOOKUPS).index("jobId_status");
      const records = await requestResult<LookupRecord[]>(index.getAll(IDBKeyRange.only([jobId, status])));
      collected.push(...records);
      if (collected.length >= limit) break;
    }
    return collected.sort((a, b) => a.lookupKey.localeCompare(b.lookupKey)).slice(0, Math.max(0, limit));
  }

  public async deleteLookup(jobId: string, lookupKey: string): Promise<void> {
    const transaction = this.db.transaction(STORE_LOOKUPS, "readwrite");
    transaction.objectStore(STORE_LOOKUPS).delete(`${jobId}|${lookupKey}`);
    await transactionDone(transaction);
  }

  public async putAudit(entry: AuditRecord): Promise<void> {
    await this.putAll(STORE_AUDIT, [entry]);
  }

  public async listAudit(jobId: string, rowId?: string): Promise<AuditRecord[]> {
    const entries = await this.auditByJob(jobId);
    return entries
      .filter((entry) => rowId === undefined || entry.rowId === rowId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  public async clearAll(): Promise<void> {
    const transaction = this.db.transaction(
      [STORE_JOBS, STORE_ROWS, STORE_LOOKUPS, STORE_AUDIT],
      "readwrite",
    );
    transaction.objectStore(STORE_JOBS).clear();
    transaction.objectStore(STORE_ROWS).clear();
    transaction.objectStore(STORE_LOOKUPS).clear();
    transaction.objectStore(STORE_AUDIT).clear();
    await transactionDone(transaction);
  }

  public async deleteJobsOlderThan(cutoffIso: string): Promise<number> {
    const transaction = this.db.transaction(STORE_JOBS, "readonly");
    const jobs = await requestResult<Job[]>(transaction.objectStore(STORE_JOBS).getAll());
    const victims = jobs.filter((job) => job.createdAt < cutoffIso);
    for (const job of victims) await this.deleteJob(job.id);
    return victims.length;
  }

  private async rowsByJob(jobId: string): Promise<ResultRow[]> {
    const transaction = this.db.transaction(STORE_ROWS, "readonly");
    return requestResult<ResultRow[]>(
      transaction.objectStore(STORE_ROWS).index("jobId").getAll(IDBKeyRange.only(jobId)),
    );
  }

  private async lookupsByJob(jobId: string): Promise<LookupRecord[]> {
    const transaction = this.db.transaction(STORE_LOOKUPS, "readonly");
    return requestResult<LookupRecord[]>(
      transaction.objectStore(STORE_LOOKUPS).index("jobId").getAll(IDBKeyRange.only(jobId)),
    );
  }

  private async auditByJob(jobId: string): Promise<AuditRecord[]> {
    const transaction = this.db.transaction(STORE_AUDIT, "readonly");
    return requestResult<AuditRecord[]>(
      transaction.objectStore(STORE_AUDIT).index("jobId").getAll(IDBKeyRange.only(jobId)),
    );
  }
}
