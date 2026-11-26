/**
 * Shared contracts for Company Page Finder.
 *
 * These types are the single source of truth for the resolver API and the
 * extension. Statuses are deliberately conservative: a URL is only ever
 * present for MATCHED (automatic, evidence-backed) or USER_CONFIRMED
 * (a human explicitly accepted a provider-returned candidate).
 */

export const SEARCH_SCHEMA_VERSION = 1 as const;

export const MAX_LOOKUPS_PER_REQUEST = 25;
export const MAX_COMPANY_NAME_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_CONTEXT_LENGTH = 120;
export const MAX_API_BODY_BYTES = 64 * 1024;

/** Base statuses produced by the deterministic engine. */
export const BASE_STATUSES = ["MATCHED", "REVIEW_REQUIRED", "NOT_FOUND"] as const;
export type BaseStatus = (typeof BASE_STATUSES)[number];

/** Statuses persisted per input row (adds user + transport outcomes). */
export const ROW_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "MATCHED",
  "USER_CONFIRMED",
  "REVIEW_REQUIRED",
  "NOT_FOUND",
  "ERROR",
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export const TERMINAL_ROW_STATUSES: readonly RowStatus[] = [
  "MATCHED",
  "USER_CONFIRMED",
  "REVIEW_REQUIRED",
  "NOT_FOUND",
];

export type QueryShape =
  "primary" | "company" | "domain" | "country" | "alias" | "title" | "location" | "ai" | "reshaped";

export type PlannedQuery = {
  query: string;
  shape: QueryShape;
  /** Why the planner added this query. Shown in the review drawer. */
  rationale: string;
};

/** Optional disambiguation facts supplied by the user. */
export type LookupContext = {
  country?: string;
  region?: string;
  city?: string;
  officialDomain?: string;
  officialWebsite?: string;
  alias?: string;
  notes?: string;
};

export type CompanyInput = LookupContext & {
  companyName: string;
  kind?: "company";
};

/**
 * Person lookup input. Email/phone are local context for export only: they are
 * never sent to the search provider or to an AI provider.
 */
export type PersonInput = {
  kind: "person";
  fullName: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  email?: string;
  phone?: string;
  notes?: string;
  /** Optional AI-generated queries; validated and restricted to /in/ search. */
  extraQueries?: string[];
};

export type LookupInput = CompanyInput | PersonInput;

export type ApiLookup = LookupInput & {
  id: string;
};

/** One provider result, verbatim, before any filtering. */
export type RawSearchResult = {
  originalUrl: string;
  title: string;
  snippet: string;
  provider: string;
  query: string;
  shape: QueryShape;
  retrievedAt: string;
};

export type ProviderErrorCode =
  | "provider_not_configured"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_bad_response"
  | "lookup_failed"
  | "request_invalid";

export type ProviderError = {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  /** Present for provider rate limits, in whole seconds. */
  retryAfterSeconds?: number;
};

export type LookupSearchResult = {
  id: string;
  queries: PlannedQuery[];
  results: RawSearchResult[];
  errors: ProviderError[];
  cached: boolean;
};

export type SearchRequest = {
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  idempotencyKey: string;
  lookups: ApiLookup[];
};

export type SearchResponse = {
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  provider: string;
  generatedAt: string;
  results: LookupSearchResult[];
};

export type ExcludedResult = {
  originalUrl: string;
  reason: string;
  title: string;
  query: string;
};

export type CandidateSignals = {
  /** Exact normalized company/alias name match in the provider title. */
  titleMatch: boolean;
  /** The matched name came from the user-supplied alias, not the primary name. */
  matchedAlias: boolean;
  domainMentioned: boolean;
  countryMentioned: boolean;
  cityMentioned: boolean;
  /** Person-specific corroboration signals. */
  companyMentioned?: boolean;
  jobTitleMentioned?: boolean;
  locationMentioned?: boolean;
  /** Same canonical URL returned by a differently shaped query. */
  corroboratedBySecondQuery: boolean;
  /** 0..1 token overlap between slug and name. Ordering/audit only — never auto-selects. */
  slugNameScore: number;
};

export type CandidateVerdict = "selectable" | "review" | "excluded";

export type CandidateEvaluation = {
  canonicalUrl: string;
  /** Exactly as returned by the provider (never constructed by us). */
  discoveredUrl: string;
  slug: string;
  title: string;
  titleEntity: string;
  snippets: string[];
  provider: string;
  queries: Array<{ query: string; shape: QueryShape }>;
  retrievedAt: string;
  signals: CandidateSignals;
  verdict: CandidateVerdict;
  /** Stable machine-readable explanation codes. */
  reasonCodes: string[];
  /** Human-readable explanation for the review drawer and exports. */
  notes: string[];
  disqualifiers: string[];
};

export type EvaluationStats = {
  rawResults: number;
  validCompanyUrls: number;
  distinctCandidates: number;
  exactTitleMatches: number;
  selectableCandidates: number;
};

export type Evaluation = {
  kind: "company" | "person";
  status: BaseStatus;
  selectedUrl: string | null;
  confidence: "high" | "low" | "none";
  lookupKey: string;
  normalizedName: string;
  provider: string;
  checkedAt: string;
  candidates: CandidateEvaluation[];
  excludedResults: ExcludedResult[];
  reasonCodes: string[];
  reasons: string[];
  stats: EvaluationStats;
};

export type AuditAction =
  | "job_created"
  | "job_started"
  | "job_paused"
  | "job_resumed"
  | "job_cancelled"
  | "job_completed"
  | "rows_retried"
  | "candidate_accepted"
  | "candidate_rejected"
  | "row_context_updated"
  | "export_generated"
  | "data_cleared";

export type AuditEntry = {
  id: string;
  jobId: string;
  rowId?: string;
  action: AuditAction;
  actor: string;
  at: string;
  detail: string;
};
