import type { BaseStatus, RowStatus } from "./types.js";

export const STATUS_LABELS: Record<RowStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "Searching",
  MATCHED: "High-confidence match",
  USER_CONFIRMED: "User confirmed",
  REVIEW_REQUIRED: "Review required",
  NOT_FOUND: "Not found",
  ERROR: "Error",
};

export const STATUS_SHORT_LABELS: Record<RowStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "Searching",
  MATCHED: "Matched",
  USER_CONFIRMED: "Confirmed",
  REVIEW_REQUIRED: "Review",
  NOT_FOUND: "Not found",
  ERROR: "Error",
};

export const STATUS_DESCRIPTIONS: Record<RowStatus, string> = {
  PENDING: "Waiting to be searched.",
  IN_PROGRESS: "A provider search is running for this row.",
  MATCHED:
    "Exactly one provider-returned company page matched the name and no competing candidate exists. Evidence is stored with the row.",
  USER_CONFIRMED: "A human explicitly accepted a provider-returned candidate. The audit trail records when.",
  REVIEW_REQUIRED:
    "Valid candidate pages exist, but the deterministic rules could not safely choose one. No URL is selected.",
  NOT_FOUND: "The search completed and returned no valid LinkedIn /company/ page.",
  ERROR: "The search or validation failed. Retry after fixing the cause; a failure never becomes a match.",
};

export const BASE_STATUS_LABELS: Record<BaseStatus, string> = {
  MATCHED: STATUS_LABELS.MATCHED,
  REVIEW_REQUIRED: STATUS_LABELS.REVIEW_REQUIRED,
  NOT_FOUND: STATUS_LABELS.NOT_FOUND,
};

const REASON_LABELS: Record<string, string> = {
  // URL rejection reasons
  url_empty: "Empty URL",
  url_too_long: "URL is too long",
  url_invalid: "Not a parseable URL",
  url_protocol: "Not an http(s) URL",
  url_has_credentials: "URL contains credentials",
  url_unexpected_port: "URL uses a non-standard port",
  url_has_backslash: "URL contains a backslash",
  url_untrusted_host: "Not a linkedin.com host",
  url_malformed_encoding: "Malformed percent-encoding",
  url_not_company_path: "Not a company page path",
  url_extra_path_segments: "Extra path segments after the company slug",
  url_invalid_slug: "Invalid company slug",
  untrusted_query: "Result did not come from a company-restricted query",
  // Candidate rules
  title_name_mismatch: "Provider title does not match the name exactly",
  corroboration_required: "Needs a domain, country, or second-query corroboration",
  // Evaluator outcomes
  unique_exact_match: "Exactly one exact candidate",
  no_valid_company_url: "No valid company URL in the results",
  no_exact_title_match: "No exact title match",
  competing_exact_matches: "Multiple exact candidates",
  alias_exact_match: "Matched the supplied alias exactly",
  exact_name_match: "Matched the company name exactly",
  invariant_violation: "Internal safety invariant violated",
  // Exports / audit
  rejected_by_user: "Rejected by the user",
  accepted_by_user: "Accepted by the user",
};

export function describeReason(code: string): string {
  return REASON_LABELS[code] ?? code.replace(/_/g, " ");
}

export const QUERY_SHAPE_LABELS: Record<string, string> = {
  primary: "Primary exact-name query",
  alias: "Alias query",
  domain: "Domain-constrained query",
  country: "Country-constrained query",
  reshaped: "Reshaped corroboration query",
};
