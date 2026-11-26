import { evaluateLookup } from "./evaluate.js";
import { computeLookupKey, extractTitleEntity, normalizeText, slugNameScore } from "./normalize.js";
import { isProfileRestrictedQuery, planQueries, sanitizePhrase } from "./query.js";
import { parseLinkedInProfileUrl, type ParsedProfileUrl } from "./url.js";
import type {
  CandidateEvaluation,
  CandidateSignals,
  CandidateVerdict,
  Evaluation,
  ExcludedResult,
  LookupInput,
  PersonInput,
  PlannedQuery,
  QueryShape,
  RawSearchResult,
} from "./types.js";

/**
 * Person-profile lookup is deliberately stricter than company lookup: a name
 * alone is never enough, because names are shared. A profile can auto-match
 * only when the provider title matches the name exactly AND at least one
 * supplied fact (company, job title, or location) appears in the evidence.
 *
 * AI may contribute additional site-restricted queries for a person, but it
 * never supplies a URL and never selects a result.
 */

const PERSON_QUERY_CAP = 5;
const MAX_EXTRA_QUERIES = 2;
const MAX_EXCLUDED_RESULTS = 25;
const MAX_SNIPPET_LENGTH = 400;
const MAX_QUERY_LENGTH = 400;

const SHAPE_PRIORITY: Record<QueryShape, number> = {
  primary: 0,
  company: 1,
  ai: 2,
  title: 3,
  location: 4,
  domain: 5,
  country: 6,
  alias: 7,
  reshaped: 8,
};

const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  "mba",
  "phd",
  "md",
  "jd",
  "cpa",
  "pmp",
  "cfa",
  "msc",
  "bsc",
  "ms",
  "ma",
  "ba",
  "bs",
  "pe",
  "cissp",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
]);

export type NormalizedPersonName = {
  raw: string;
  normalized: string;
  core: string;
  tokens: string[];
  isShortOrCommon: boolean;
};

function stripCredentialSuffix(value: string): string {
  const comma = value.indexOf(",");
  if (comma <= 0) return value;
  const namePart = value.slice(0, comma).trim();
  const suffixTokens = normalizeText(value.slice(comma + 1))
    .split(" ")
    .filter(Boolean);
  if (suffixTokens.length > 0 && suffixTokens.every((token) => CREDENTIAL_TOKENS.has(token))) {
    return namePart;
  }
  return value;
}

/** Normalize a person name, including `Last, First` and credential suffixes. */
export function normalizePersonName(value: string): NormalizedPersonName {
  let cleaned = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  const comma = cleaned.indexOf(",");
  if (comma > 0) {
    const left = cleaned.slice(0, comma).trim();
    const right = cleaned.slice(comma + 1).trim();
    const rightTokens = normalizeText(right).split(" ").filter(Boolean);
    const credentialsOnly =
      rightTokens.length > 0 && rightTokens.every((token) => CREDENTIAL_TOKENS.has(token));
    cleaned = credentialsOnly ? left : `${right} ${left}`;
  }

  const normalized = normalizeText(cleaned);
  const tokens = normalized ? normalized.split(" ") : [];
  return {
    raw: String(value ?? "").trim(),
    normalized,
    core: tokens.join(" "),
    tokens,
    isShortOrCommon: tokens.length < 2,
  };
}

/** Extract the display name from a profile title such as "Ada Lovelace - CTO - Acme | LinkedIn". */
export function extractProfileName(title: string): string {
  let value = extractTitleEntity(title).replace(/\s*\([^)]*\)\s*$/, "");
  value = stripCredentialSuffix(value);
  return value.trim();
}

export function personNamesEquivalent(a: NormalizedPersonName, b: NormalizedPersonName): boolean {
  return a.core.length > 0 && a.core === b.core;
}

export function phraseMentioned(phrase: string | undefined, haystack: string): boolean {
  const normalized = normalizeText(phrase ?? "");
  if (!normalized) return false;
  return ` ${normalizeText(haystack)} `.includes(` ${normalized} `);
}

export function computePersonLookupKey(input: PersonInput): string {
  const name = normalizePersonName(input.fullName);
  return JSON.stringify([
    name.core,
    normalizeText(input.company ?? ""),
    normalizeText(input.jobTitle ?? ""),
    normalizeText(input.location ?? ""),
  ]);
}

function cleanQuery(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

/**
 * AI-provided queries are untrusted input. A query is accepted only when it
 * starts with the profile-site restriction, contains the exact person name,
 * has no URL, and does not smuggle a profile slug into the site restriction.
 */
export function sanitizePersonExtraQuery(value: unknown, name: NormalizedPersonName): string | null {
  const query = cleanQuery(value);
  if (!query) return null;
  if (!/^site:linkedin\.com\/in\/\s+/i.test(query)) return null;
  if (/\bhttps?:\/\//i.test(query)) return null;
  if (/site:linkedin\.com\/in\/[^\s"]/i.test(query)) return null;
  if (!normalizeText(query).includes(name.core)) return null;
  return query;
}

export function planPersonQueries(input: PersonInput): PlannedQuery[] {
  const name = sanitizePhrase(input.fullName);
  if (!name || !normalizeText(name)) return [];

  const normalized = normalizePersonName(input.fullName);
  const company = sanitizePhrase(input.company ?? "");
  const jobTitle = sanitizePhrase(input.jobTitle ?? "");
  const location = sanitizePhrase(input.location ?? "");
  const planned: PlannedQuery[] = [];
  const seen = new Set<string>();

  const add = (query: string, shape: QueryShape, rationale: string): void => {
    const value = query.trim();
    if (!value || value.length > MAX_QUERY_LENGTH || seen.has(value)) return;
    if (planned.length >= PERSON_QUERY_CAP) return;
    seen.add(value);
    planned.push({ query: value, shape, rationale });
  };

  add(
    `site:linkedin.com/in/ ${JSON.stringify(name)}`,
    "primary",
    "Exact person name restricted to LinkedIn profile pages.",
  );

  if (company) {
    add(
      `site:linkedin.com/in/ ${JSON.stringify(name)} ${JSON.stringify(company)}`,
      "company",
      "Adds the supplied employer as a narrowing constraint.",
    );
  }

  for (const candidate of input.extraQueries ?? []) {
    if (planned.filter((entry) => entry.shape === "ai").length >= MAX_EXTRA_QUERIES) break;
    const query = sanitizePersonExtraQuery(candidate, normalized);
    if (query) {
      add(
        query,
        "ai",
        "AI-assisted search angle; validated to stay on LinkedIn profiles and include the exact name.",
      );
    }
  }

  if (jobTitle) {
    add(
      `site:linkedin.com/in/ ${JSON.stringify(name)} ${JSON.stringify(jobTitle)}`,
      "title",
      "Adds the supplied job title as a narrowing constraint.",
    );
  }

  if (location) {
    add(
      `site:linkedin.com/in/ ${JSON.stringify(name)} ${JSON.stringify(location)}`,
      "location",
      "Adds the supplied location as a narrowing constraint.",
    );
  }

  add(
    company
      ? `${JSON.stringify(name)} ${JSON.stringify(company)} site:linkedin.com/in/`
      : `${JSON.stringify(name)} site:linkedin.com/in/`,
    "reshaped",
    "Differently shaped query used only to corroborate the same profile.",
  );

  return planned;
}

function maxIso(values: string[], fallback: string): string {
  let best = "";
  for (const value of values) if (typeof value === "string" && value.length > best.length) best = value;
  return best || fallback;
}

function uniqueSnippets(entries: RawSearchResult[]): string[] {
  const snippets: string[] = [];
  for (const entry of entries) {
    const snippet = String(entry.snippet ?? "")
      .trim()
      .slice(0, MAX_SNIPPET_LENGTH);
    if (snippet && !snippets.includes(snippet)) snippets.push(snippet);
    if (snippets.length >= 3) break;
  }
  return snippets;
}

type Group = { parsed: ParsedProfileUrl; entries: RawSearchResult[] };

export function evaluatePersonLookup(
  input: PersonInput,
  rawResults: readonly RawSearchResult[],
  meta: { provider: string; checkedAt: string },
): Evaluation {
  const name = normalizePersonName(input.fullName);
  const company = normalizeText(input.company ?? "");
  const jobTitle = normalizeText(input.jobTitle ?? "");
  const location = normalizeText(input.location ?? "");
  const hasContext = Boolean(company || jobTitle || location);

  const groups = new Map<string, Group>();
  const excludedByKey = new Map<string, ExcludedResult>();

  const addExcluded = (result: RawSearchResult, reason: string): void => {
    const key = `${result.originalUrl}|${reason}`;
    if (excludedByKey.has(key) || excludedByKey.size >= MAX_EXCLUDED_RESULTS) return;
    excludedByKey.set(key, {
      originalUrl: String(result.originalUrl ?? "").slice(0, 2048),
      reason,
      title: String(result.title ?? "").slice(0, 300),
      query: String(result.query ?? "").slice(0, 400),
    });
  };

  for (const result of rawResults) {
    if (!isProfileRestrictedQuery(result.query)) {
      addExcluded(result, "untrusted_query");
      continue;
    }
    const parsed = parseLinkedInProfileUrl(result.originalUrl);
    if (!parsed.ok) {
      addExcluded(result, parsed.reason);
      continue;
    }
    const key = parsed.canonicalUrl.toLowerCase();
    const existing = groups.get(key);
    if (existing) existing.entries.push(result);
    else groups.set(key, { parsed, entries: [result] });
  }

  const candidates: CandidateEvaluation[] = [];
  let validUrlCount = 0;
  for (const group of groups.values()) {
    validUrlCount += group.entries.length;
    const entries = [...group.entries].sort(
      (a, b) => SHAPE_PRIORITY[a.shape] - SHAPE_PRIORITY[b.shape] || a.title.localeCompare(b.title),
    );

    let match: { entry: RawSearchResult; entity: string; normalized: NormalizedPersonName } | null = null;
    for (const entry of entries) {
      const entity = extractProfileName(entry.title);
      const normalized = normalizePersonName(entity);
      if (personNamesEquivalent(normalized, name)) {
        match = { entry, entity, normalized };
        break;
      }
    }

    const queryMap = new Map<string, QueryShape>();
    for (const entry of entries) if (!queryMap.has(entry.query)) queryMap.set(entry.query, entry.shape);

    const snippets = uniqueSnippets(entries);
    const displayTitle = (match?.entry.title ?? entries[0]?.title ?? "").trim();
    const titleEntity = match?.entity ?? extractProfileName(displayTitle);
    const haystack = [displayTitle, ...snippets].join("\n");

    const signals: CandidateSignals = {
      titleMatch: match !== null,
      matchedAlias: false,
      domainMentioned: false,
      countryMentioned: false,
      cityMentioned: false,
      companyMentioned: phraseMentioned(company, haystack),
      jobTitleMentioned: phraseMentioned(jobTitle, haystack),
      locationMentioned: phraseMentioned(location, haystack),
      corroboratedBySecondQuery: queryMap.size >= 2 && new Set(queryMap.values()).size >= 2,
      slugNameScore: slugNameScore(group.parsed.slug, name.tokens),
    };

    const notes: string[] = [`Provider title: “${displayTitle || "(missing title)"}”.`];
    const disqualifiers: string[] = [];
    const reasonCodes: string[] = [];
    if (match) {
      notes.push(`Title matches the person name exactly after normalization (“${match.normalized.core}”).`);
    } else {
      disqualifiers.push("title_name_mismatch");
      notes.push("The provider title does not match the person name exactly.");
    }
    if (signals.companyMentioned) notes.push("The supplied company appears in the result text.");
    if (signals.jobTitleMentioned) notes.push("The supplied job title appears in the result text.");
    if (signals.locationMentioned) notes.push("The supplied location appears in the result text.");
    if (signals.corroboratedBySecondQuery) {
      notes.push("The same profile URL was returned by a second, differently shaped query.");
    }
    notes.push(
      `Slug/name token overlap: ${signals.slugNameScore.toFixed(2)} (ordering only, never decisive).`,
    );

    let verdict: CandidateVerdict;
    if (!match) {
      verdict = "excluded";
    } else if (name.isShortOrCommon) {
      verdict = "review";
      reasonCodes.push("full_name_too_short");
      notes.push("A single-token name is too ambiguous for automatic matching.");
    } else if (!hasContext) {
      verdict = "review";
      reasonCodes.push("context_required");
      notes.push("Add a company, job title, or location; a name alone is never enough to auto-match.");
    } else if (!signals.companyMentioned && !signals.jobTitleMentioned && !signals.locationMentioned) {
      verdict = "review";
      reasonCodes.push("corroboration_required");
      notes.push("None of the supplied company, job title, or location appears in the evidence.");
    } else {
      verdict = "selectable";
      reasonCodes.push("exact_name_match");
    }

    candidates.push({
      canonicalUrl: group.parsed.canonicalUrl,
      discoveredUrl: group.parsed.discoveredUrl,
      slug: group.parsed.slug,
      title: displayTitle,
      titleEntity,
      snippets,
      provider: entries[0]?.provider ?? "",
      queries: [...queryMap.entries()].map(([query, shape]) => ({ query, shape })),
      retrievedAt: maxIso(
        entries.map((entry) => entry.retrievedAt),
        meta.checkedAt,
      ),
      signals,
      verdict,
      reasonCodes,
      notes,
      disqualifiers,
    });
  }

  const order: Record<CandidateVerdict, number> = { selectable: 0, review: 1, excluded: 2 };
  candidates.sort((a, b) => {
    const verdictDelta = order[a.verdict] - order[b.verdict];
    if (verdictDelta !== 0) return verdictDelta;
    const scoreDelta = b.signals.slugNameScore - a.signals.slugNameScore;
    if (scoreDelta !== 0) return scoreDelta;
    return a.canonicalUrl.localeCompare(b.canonicalUrl);
  });

  const exactMatches = candidates.filter((candidate) => candidate.signals.titleMatch);
  const selectable = candidates.filter((candidate) => candidate.verdict === "selectable");
  const excluded = [...excludedByKey.values()];
  const stats = {
    rawResults: rawResults.length,
    validCompanyUrls: validUrlCount,
    distinctCandidates: candidates.length,
    exactTitleMatches: exactMatches.length,
    selectableCandidates: selectable.length,
  };

  const base = {
    kind: "person" as const,
    lookupKey: computePersonLookupKey(input),
    normalizedName: name.core,
    provider: meta.provider,
    checkedAt: meta.checkedAt,
    candidates,
    excludedResults: excluded,
    stats,
  };

  if (candidates.length === 0) {
    return {
      ...base,
      status: "NOT_FOUND",
      selectedUrl: null,
      confidence: "none",
      reasonCodes: ["no_valid_profile_url"],
      reasons: [
        `The search completed, but no URL in the results was a valid LinkedIn profile page.` +
          (excluded.length > 0 ? ` ${excluded.length} non-profile result(s) were rejected.` : ""),
      ],
    };
  }

  const onlySelectable = selectable.length === 1 ? selectable[0] : undefined;
  if (onlySelectable && exactMatches.length === 1) {
    return {
      ...base,
      status: "MATCHED",
      selectedUrl: onlySelectable.canonicalUrl,
      confidence: "high",
      reasonCodes: ["unique_exact_match"],
      reasons: [
        `Exactly one provider-returned LinkedIn profile matches “${input.fullName.trim()}” exactly and includes a supplied corroborating fact.`,
      ],
    };
  }

  let code: string;
  let reason: string;
  if (exactMatches.length > 1) {
    code = "competing_exact_names";
    reason = `${exactMatches.length} provider-returned profiles match the name exactly. A human must choose; the tool will not guess.`;
  } else if (exactMatches.length === 0) {
    code = "no_exact_name_match";
    reason = `The search returned ${candidates.length} valid LinkedIn profile URL(s), but none had a title matching the name exactly.`;
  } else if (name.isShortOrCommon) {
    code = "full_name_too_short";
    reason = "The name has fewer than two tokens and is too ambiguous for automatic matching.";
  } else if (!hasContext) {
    code = "context_required";
    reason = "A name alone is not enough. Add a company, job title, or location and review the candidates.";
  } else {
    code = "corroboration_required";
    reason =
      "One exact profile exists, but none of the supplied company, title, or location appears in the evidence. Add context or review manually.";
  }

  return {
    ...base,
    status: "REVIEW_REQUIRED",
    selectedUrl: null,
    confidence: "low",
    reasonCodes: [code],
    reasons: [reason],
  };
}

/** Dispatch helpers shared by the resolver and the extension. */
export function planQueriesFor(input: LookupInput): PlannedQuery[] {
  return input.kind === "person" ? planPersonQueries(input) : planQueries(input);
}

export function computeLookupKeyFor(input: LookupInput): string {
  return input.kind === "person" ? computePersonLookupKey(input) : computeLookupKey(input);
}

export function evaluateLookupFor(
  input: LookupInput,
  rawResults: readonly RawSearchResult[],
  meta: { provider: string; checkedAt: string },
): Evaluation {
  return input.kind === "person"
    ? evaluatePersonLookup(input, rawResults, meta)
    : evaluateLookup(input, rawResults, meta);
}

// Re-export helpers used by callers that only import the person module.
