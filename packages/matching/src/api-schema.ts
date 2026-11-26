import {
  MAX_API_BODY_BYTES,
  MAX_COMPANY_NAME_LENGTH,
  MAX_CONTEXT_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LOOKUPS_PER_REQUEST,
  SEARCH_SCHEMA_VERSION,
  type ApiLookup,
  type LookupSearchResult,
  type PlannedQuery,
  type ProviderError,
  type ProviderErrorCode,
  type QueryShape,
  type RawSearchResult,
  type SearchRequest,
  type SearchResponse,
} from "./types.js";
import { normalizePersonName, sanitizePersonExtraQuery } from "./person.js";

export { MAX_API_BODY_BYTES };

/**
 * Hand-written runtime validation for the narrow resolver contract.
 * No third-party schema dependency: the wire format is small and strictly
 * bounded, and both the server and the extension share these checks.
 */

export class ApiSchemaError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] ?? "Invalid payload");
    this.name = "ApiSchemaError";
    this.issues = issues;
  }
}

const QUERY_SHAPES: ReadonlySet<string> = new Set([
  "primary",
  "company",
  "domain",
  "country",
  "alias",
  "title",
  "location",
  "ai",
  "reshaped",
]);
const ERROR_CODES: ReadonlySet<string> = new Set([
  "provider_not_configured",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_timeout",
  "provider_bad_response",
  "lookup_failed",
  "request_invalid",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string, issues: string[]): UnknownRecord {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function text(
  value: unknown,
  path: string,
  issues: string[],
  options: { min?: number; max: number; trim?: boolean },
): string {
  if (typeof value !== "string") {
    issues.push(`${path} must be a string`);
    return "";
  }
  const result = options.trim === false ? value : value.trim();
  if (result.length < (options.min ?? 1)) issues.push(`${path} is required`);
  if (result.length > options.max) issues.push(`${path} must be at most ${options.max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    issues.push(`${path} contains control characters`);
  }
  return result;
}

function optionalText(
  source: UnknownRecord,
  key: string,
  path: string,
  issues: string[],
  max = MAX_CONTEXT_LENGTH,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === "") return undefined;
  const result = text(value, `${path}.${key}`, issues, { min: 1, max });
  return result || undefined;
}

function isoDate(value: unknown, path: string, issues: string[]): string {
  const result = text(value, path, issues, { max: 64 });
  if (result && Number.isNaN(Date.parse(result))) issues.push(`${path} must be an ISO date`);
  return result;
}

function boolean(value: unknown, path: string, issues: string[]): boolean {
  if (typeof value !== "boolean") {
    issues.push(`${path} must be a boolean`);
    return false;
  }
  return value;
}

function arrayValue(value: unknown, path: string, issues: string[]): unknown[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return value;
}

function parseLookup(value: unknown, index: number, issues: string[]): ApiLookup {
  const path = `lookups[${index}]`;
  const source = record(value, path, issues);
  const id = text(source["id"], `${path}.id`, issues, { min: 1, max: 100 });
  const kind = source["kind"];

  if (kind !== undefined && kind !== "company" && kind !== "person") {
    issues.push(`${path}.kind must be "company" or "person"`);
  }

  if (kind === "person") {
    const fullName = text(source["fullName"], `${path}.fullName`, issues, {
      min: 1,
      max: MAX_COMPANY_NAME_LENGTH,
    });
    const normalized = normalizePersonName(fullName);
    const person: ApiLookup = { id, kind: "person", fullName };
    const company = optionalText(source, "company", path, issues, 200);
    const jobTitle = optionalText(source, "jobTitle", path, issues, 200);
    const location = optionalText(source, "location", path, issues, 200);
    const email = optionalText(source, "email", path, issues, 254);
    const phone = optionalText(source, "phone", path, issues, 40);
    const notes = optionalText(source, "notes", path, issues, 500);
    if (company) person.company = company;
    if (jobTitle) person.jobTitle = jobTitle;
    if (location) person.location = location;
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        issues.push(`${path}.email is not a valid email address`);
      else person.email = email;
    }
    if (phone) person.phone = phone;
    if (notes) person.notes = notes;

    const extraRaw = source["extraQueries"];
    const extraQueries = extraRaw === undefined ? [] : arrayValue(extraRaw, `${path}.extraQueries`, issues);
    if (extraQueries.length > 2) issues.push(`${path}.extraQueries must contain at most 2 items`);
    const accepted: string[] = [];
    for (const [queryIndex, queryValue] of extraQueries.slice(0, 2).entries()) {
      const query = text(queryValue, `${path}.extraQueries[${queryIndex}]`, issues, { min: 10, max: 400 });
      const cleaned = sanitizePersonExtraQuery(query, normalized);
      if (!cleaned) {
        issues.push(
          `${path}.extraQueries[${queryIndex}] must be a site:linkedin.com/in/ query containing the person name and no URL`,
        );
      } else {
        accepted.push(cleaned);
      }
    }
    if (accepted.length > 0) person.extraQueries = accepted;
    return person;
  }

  const lookup: ApiLookup = {
    id,
    kind: "company",
    companyName: text(source["companyName"], `${path}.companyName`, issues, {
      min: 1,
      max: MAX_COMPANY_NAME_LENGTH,
    }),
  };
  const country = optionalText(source, "country", path, issues);
  const region = optionalText(source, "region", path, issues);
  const city = optionalText(source, "city", path, issues);
  const officialDomain = optionalText(source, "officialDomain", path, issues, 253);
  const officialWebsite = optionalText(source, "officialWebsite", path, issues, 400);
  const alias = optionalText(source, "alias", path, issues);
  const notes = optionalText(source, "notes", path, issues, 500);
  if (country) lookup.country = country;
  if (region) lookup.region = region;
  if (city) lookup.city = city;
  if (officialDomain) lookup.officialDomain = officialDomain;
  if (officialWebsite) lookup.officialWebsite = officialWebsite;
  if (alias) lookup.alias = alias;
  if (notes) lookup.notes = notes;
  return lookup;
}

export function parseSearchRequest(value: unknown): SearchRequest {
  const issues: string[] = [];
  const source = record(value, "request", issues);
  if (source["schemaVersion"] !== SEARCH_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${SEARCH_SCHEMA_VERSION}`);
  }
  const idempotencyKey = text(source["idempotencyKey"], "idempotencyKey", issues, {
    min: 8,
    max: MAX_IDEMPOTENCY_KEY_LENGTH,
  });
  if (idempotencyKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(idempotencyKey)) {
    issues.push("idempotencyKey must use only letters, digits, dot, underscore, colon, or hyphen");
  }
  const lookupsRaw = arrayValue(source["lookups"], "lookups", issues);
  if (lookupsRaw.length === 0) issues.push("lookups must contain at least one item");
  if (lookupsRaw.length > MAX_LOOKUPS_PER_REQUEST) {
    issues.push(`lookups must contain at most ${MAX_LOOKUPS_PER_REQUEST} items`);
  }
  const lookups = lookupsRaw.map((lookup, index) => parseLookup(lookup, index, issues));
  const ids = new Set<string>();
  for (const lookup of lookups) {
    if (ids.has(lookup.id)) issues.push("lookup ids must be unique");
    ids.add(lookup.id);
  }
  if (issues.length > 0) throw new ApiSchemaError(issues);
  return { schemaVersion: SEARCH_SCHEMA_VERSION, idempotencyKey, lookups };
}

function parseQuery(value: unknown, path: string, issues: string[]): PlannedQuery {
  const source = record(value, path, issues);
  const shape = text(source["shape"], `${path}.shape`, issues, { max: 20 });
  if (!QUERY_SHAPES.has(shape)) issues.push(`${path}.shape is not a supported query shape`);
  return {
    query: text(source["query"], `${path}.query`, issues, { min: 1, max: 400 }),
    shape: shape as QueryShape,
    rationale: text(source["rationale"], `${path}.rationale`, issues, { max: 300 }),
  };
}

function parseProviderError(value: unknown, path: string, issues: string[]): ProviderError {
  const source = record(value, path, issues);
  const code = text(source["code"], `${path}.code`, issues, { max: 40 });
  if (!ERROR_CODES.has(code)) issues.push(`${path}.code is not a supported error code`);
  const result: ProviderError = {
    code: code as ProviderErrorCode,
    message: text(source["message"], `${path}.message`, issues, { min: 1, max: 300 }),
    retryable: boolean(source["retryable"], `${path}.retryable`, issues),
  };
  const retryAfter = source["retryAfterSeconds"];
  if (retryAfter !== undefined) {
    if (
      typeof retryAfter !== "number" ||
      !Number.isFinite(retryAfter) ||
      retryAfter < 0 ||
      retryAfter > 3600
    ) {
      issues.push(`${path}.retryAfterSeconds must be a number between 0 and 3600`);
    } else {
      result.retryAfterSeconds = Math.ceil(retryAfter);
    }
  }
  return result;
}

function parseRawResult(value: unknown, path: string, issues: string[]): RawSearchResult {
  const source = record(value, path, issues);
  const shape = text(source["shape"], `${path}.shape`, issues, { max: 20 });
  if (!QUERY_SHAPES.has(shape)) issues.push(`${path}.shape is not a supported query shape`);
  return {
    originalUrl: text(source["originalUrl"], `${path}.originalUrl`, issues, { min: 1, max: 2048 }),
    title: text(source["title"], `${path}.title`, issues, { min: 1, max: 300, trim: true }),
    snippet: text(source["snippet"], `${path}.snippet`, issues, { min: 0, max: 1200, trim: true }),
    provider: text(source["provider"], `${path}.provider`, issues, { min: 1, max: 40 }),
    query: text(source["query"], `${path}.query`, issues, { min: 1, max: 400 }),
    shape: shape as QueryShape,
    retrievedAt: isoDate(source["retrievedAt"], `${path}.retrievedAt`, issues),
  };
}

function parseLookupResult(value: unknown, path: string, issues: string[]): LookupSearchResult {
  const source = record(value, path, issues);
  return {
    id: text(source["id"], `${path}.id`, issues, { min: 1, max: 100 }),
    queries: arrayValue(source["queries"], `${path}.queries`, issues).map((query, index) =>
      parseQuery(query, `${path}.queries[${index}]`, issues),
    ),
    results: arrayValue(source["results"], `${path}.results`, issues).map((result, index) =>
      parseRawResult(result, `${path}.results[${index}]`, issues),
    ),
    errors: arrayValue(source["errors"], `${path}.errors`, issues).map((error, index) =>
      parseProviderError(error, `${path}.errors[${index}]`, issues),
    ),
    cached: boolean(source["cached"], `${path}.cached`, issues),
  };
}

export function parseSearchResponse(value: unknown): SearchResponse {
  const issues: string[] = [];
  const source = record(value, "response", issues);
  if (source["schemaVersion"] !== SEARCH_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${SEARCH_SCHEMA_VERSION}`);
  }
  const provider = text(source["provider"], "provider", issues, { min: 1, max: 40 });
  const generatedAt = isoDate(source["generatedAt"], "generatedAt", issues);
  const resultsRaw = arrayValue(source["results"], "results", issues);
  if (resultsRaw.length > MAX_LOOKUPS_PER_REQUEST) issues.push("results contains too many items");
  const results = resultsRaw.map((result, index) => parseLookupResult(result, `results[${index}]`, issues));
  if (issues.length > 0) throw new ApiSchemaError(issues);
  return { schemaVersion: SEARCH_SCHEMA_VERSION, provider, generatedAt, results };
}
