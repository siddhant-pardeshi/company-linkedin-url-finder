import type {
  AuditEntry,
  CandidateEvaluation,
  Evaluation,
  LookupInput,
  PlannedQuery,
  RowStatus,
} from "@clf/matching";

/** Compile-time values injected by tools/build-extension.mjs. */
declare const __APP_VERSION__: string;
declare const __BUILD_ENV__: "development" | "production";
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __RESOLVER_ENDPOINT__: string;

export const APP_VERSION = __APP_VERSION__;
export const BUILD_ENV = __BUILD_ENV__;
export const BUILD_COMMIT = __BUILD_COMMIT__;
export const BUILD_TIME = __BUILD_TIME__;
export const RESOLVER_ENDPOINT = __RESOLVER_ENDPOINT__.replace(/\/+$/, "");
export const IS_DEV_BUILD = BUILD_ENV === "development";
export const SEARCH_PATH = "/v1/search";
export const WHOAMI_PATH = "/v1/whoami";

export const APP_NAME = "Company Page Finder";
export const MAX_ROWS_PER_JOB = 5000;
export const MAX_BATCH_SIZE = 10;
export const DEFAULT_BATCH_SIZE = 5;

import type { AiSettings } from "./ai/settings.js";

export type RawRow = LookupInput;
export type RowKind = "company" | "person";

export type RowError = {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  at: string;
};

export type RowConfirmation = {
  actor: string;
  at: string;
  canonicalUrl: string;
};

export const JOB_STATES = ["running", "paused", "cancelled", "completed"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const PAUSE_REASONS = [
  "user",
  "auth",
  "rate_limit",
  "network",
  "missing_token",
  "request_error",
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export type Job = {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: JobState;
  mode?: RowKind;
  totalRows: number;
  totalLookups: number;
  batchSize: number;
  operatorName: string;
  pauseReason: PauseReason | null;
  lastError: { code: string; message: string; retryable: boolean; at: string } | null;
  cooldownUntil: string | null;
  /** Safe, user-facing note when optional AI query assistance failed. */
  aiNote?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ResultRow = {
  id: string;
  jobId: string;
  rowIndex: number;
  kind?: RowKind;
  raw: RawRow;
  /** Normalized de-duplication key; rows sharing it share one lookup. */
  lookupKey: string;
  status: RowStatus;
  selectedUrl: string | null;
  confidence: "high" | "low" | "none";
  evaluation: Evaluation | null;
  provider: string | null;
  checkedAt: string | null;
  error: RowError | null;
  confirmedBy: RowConfirmation | null;
  rejectedCandidates: string[];
  updatedAt: string;
};

export type LookupStatus = "PENDING" | "IN_PROGRESS" | "RESOLVED" | "ERROR";

export type LookupRecord = {
  /** `${jobId}|${lookupKey}` */
  key: string;
  jobId: string;
  lookupKey: string;
  input: RawRow;
  status: LookupStatus;
  queries: PlannedQuery[];
  evaluation: Evaluation | null;
  provider: string | null;
  checkedAt: string | null;
  error: RowError | null;
  updatedAt: string;
};

export type AuditRecord = AuditEntry & { id: string };

export type RowCounts = Record<RowStatus, number> & { total: number };

export type JobSnapshot = {
  job: Job;
  stats: RowCounts;
};

export type AppSettings = {
  accessToken: string;
  operatorName: string;
  batchSize: number;
  retentionDays: number;
};

export type AppInfo = {
  version: string;
  buildEnv: "development" | "production";
  buildCommit: string;
  buildTime: string;
  endpoint: string;
};

export type CandidateView = CandidateEvaluation & {
  rejectedByUser: boolean;
  auditLabel: string;
};

/** Message protocol between extension pages and the service worker. */
export type ExtensionRequest =
  | { type: "job:start"; rows: RawRow[]; batchSize?: number }
  | { type: "job:latest" }
  | { type: "job:snapshot"; jobId: string }
  | { type: "job:rows"; jobId: string }
  | { type: "job:audit"; jobId: string }
  | { type: "job:pause"; jobId: string }
  | { type: "job:resume"; jobId: string }
  | { type: "job:cancel"; jobId: string }
  | { type: "job:retry-failed"; jobId: string }
  | { type: "job:retry-rows"; jobId: string; rowIds: string[] }
  | { type: "job:clear"; jobId: string }
  | { type: "row:update-context"; jobId: string; rowId: string; context: Partial<RawRow> }
  | { type: "row:accept-candidate"; jobId: string; rowId: string; canonicalUrl: string }
  | { type: "row:reject-candidate"; jobId: string; rowId: string; canonicalUrl: string }
  | { type: "row:audit"; jobId: string; rowId: string }
  | { type: "settings:get" }
  | { type: "settings:save"; patch: Partial<AppSettings> }
  | { type: "settings:test" }
  | { type: "ai:get" }
  | { type: "ai:save"; patch: Partial<AiSettings> }
  | { type: "ai:test" }
  | { type: "data:clear-all" }
  | { type: "app:info" };

export type ExtensionResponse<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
