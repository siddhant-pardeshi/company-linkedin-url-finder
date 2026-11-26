import {
  companyNamesEquivalent,
  computeLookupKey,
  countryMentioned,
  domainMentioned,
  extractTitleEntity,
  normalizeCompanyName,
  normalizeCountry,
  normalizeDomain,
  normalizeText,
  slugNameScore,
  type NormalizedName,
} from "./normalize.js";
import { isCompanyRestrictedQuery } from "./query.js";
import { parseLinkedInCompanyUrl, type ParsedCompanyUrl } from "./url.js";
import type {
  CandidateEvaluation,
  CandidateSignals,
  CandidateVerdict,
  Evaluation,
  ExcludedResult,
  LookupContext,
  QueryShape,
  RawSearchResult,
} from "./types.js";

/**
 * The deterministic rule evaluator. No network, no clock, no randomness, no AI:
 * the same inputs always produce the same decision and the same explanation.
 *
 * Auto-selection requires ALL of:
 *  1. exactly one surviving candidate whose provider title matches the
 *     company name (or a user-supplied alias) after normalization;
 *  2. that candidate came from company-restricted provider queries;
 *  3. it has at least one corroborating signal when the name is short,
 *     generic, or otherwise ambiguous.
 *
 * Anything else is REVIEW_REQUIRED / NOT_FOUND, with the candidates and
 * evidence retained.
 */

const SHAPE_PRIORITY: Record<QueryShape, number> = {
  primary: 0,
  alias: 1,
  company: 2,
  domain: 3,
  country: 4,
  title: 5,
  location: 6,
  ai: 7,
  reshaped: 8,
};

const MAX_EXCLUDED_RESULTS = 25;
const MAX_SNIPPET_LENGTH = 400;

export const REASON_CODES = {
  uniqueExactMatch: "unique_exact_match",
  noValidCompanyUrl: "no_valid_company_url",
  noExactTitleMatch: "no_exact_title_match",
  competingExactMatches: "competing_exact_matches",
  corroborationRequired: "corroboration_required",
  aliasExactMatch: "alias_exact_match",
  exactNameMatch: "exact_name_match",
  invariantViolation: "invariant_violation",
} as const;

type CandidateGroup = {
  parsed: ParsedCompanyUrl;
  entries: RawSearchResult[];
};

function byShapeThenTitle(a: RawSearchResult, b: RawSearchResult): number {
  const shapeDelta = SHAPE_PRIORITY[a.shape] - SHAPE_PRIORITY[b.shape];
  if (shapeDelta !== 0) return shapeDelta;
  return a.title.localeCompare(b.title);
}

function maxIso(values: string[], fallback: string): string {
  let best = "";
  for (const value of values) {
    if (typeof value === "string" && value.length > best.length) best = value;
  }
  return best || fallback;
}

/** Whole-phrase match for a city name (non-decisive corroboration only). */
function cityMentioned(city: string | null, haystack: string): boolean {
  const normalized = normalizeText(city ?? "");
  if (!normalized) return false;
  return ` ${normalizeText(haystack)} `.includes(` ${normalized} `);
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

function buildCandidate(
  group: CandidateGroup,
  input: NormalizedName,
  alias: NormalizedName | null,
  country: string | null,
  city: string | null,
  domain: string | null,
  checkedAt: string,
): CandidateEvaluation {
  const entries = [...group.entries].sort(byShapeThenTitle);
  const slug = group.parsed.slug;

  let match: {
    entry: RawSearchResult;
    entity: string;
    normalized: NormalizedName;
    matchedAlias: boolean;
  } | null = null;
  for (const entry of entries) {
    const entity = extractTitleEntity(entry.title);
    const normalized = normalizeCompanyName(entity);
    if (companyNamesEquivalent(normalized, input)) {
      match = { entry, entity, normalized, matchedAlias: false };
      break;
    }
    if (alias && companyNamesEquivalent(normalized, alias)) {
      match = { entry, entity, normalized, matchedAlias: true };
      break;
    }
  }

  const queryMap = new Map<string, QueryShape>();
  for (const entry of entries) {
    if (!queryMap.has(entry.query)) queryMap.set(entry.query, entry.shape);
  }

  const snippets = uniqueSnippets(entries);
  const displayTitle = (match?.entry.title ?? entries[0]?.title ?? "").trim();
  const titleEntity = match?.entity ?? extractTitleEntity(displayTitle);
  const haystack = [displayTitle, ...snippets].join(" \n ");

  const signals: CandidateSignals = {
    titleMatch: match !== null,
    matchedAlias: match?.matchedAlias ?? false,
    domainMentioned: domainMentioned(domain, haystack),
    countryMentioned: countryMentioned(country, haystack),
    cityMentioned: cityMentioned(city, haystack),
    corroboratedBySecondQuery: queryMap.size >= 2 && new Set(queryMap.values()).size >= 2,
    slugNameScore: slugNameScore(slug, match?.normalized.coreTokens ?? input.coreTokens),
  };

  const reasonCodes: string[] = [];
  const notes: string[] = [];
  const disqualifiers: string[] = [];

  notes.push(`Provider title: “${displayTitle || "(missing title)"}”.`);
  if (match) {
    notes.push(
      match.matchedAlias
        ? `Title matches the supplied alias exactly after normalization (“${match.normalized.core}”).`
        : `Title matches the company name exactly after normalization and legal-suffix removal (“${match.normalized.core}”).`,
    );
  } else {
    disqualifiers.push("title_name_mismatch");
    notes.push("The provider title does not match the company name or alias exactly.");
  }

  if (signals.domainMentioned) notes.push("The supplied official domain appears in the result text.");
  if (signals.countryMentioned) notes.push("The supplied country appears in the result text.");
  if (signals.cityMentioned) notes.push("The supplied city appears in the result text.");
  if (signals.corroboratedBySecondQuery) {
    notes.push("The same canonical URL was returned by a second, differently shaped query.");
  }
  notes.push(`Slug/name token overlap: ${signals.slugNameScore.toFixed(2)} (ordering only, never decisive).`);

  let verdict: CandidateVerdict;
  if (!match) {
    verdict = "excluded";
  } else {
    const relevantName = match.normalized;
    const hasCorroboration =
      signals.domainMentioned ||
      signals.countryMentioned ||
      signals.cityMentioned ||
      signals.corroboratedBySecondQuery;
    if (relevantName.isShortOrCommon && !hasCorroboration) {
      verdict = "review";
      reasonCodes.push(REASON_CODES.corroborationRequired);
      notes.push(
        "The name is short, generic, or commonly shared. Add an official domain or country (or let a second query corroborate) before this can auto-match.",
      );
    } else {
      verdict = "selectable";
      reasonCodes.push(match.matchedAlias ? REASON_CODES.aliasExactMatch : REASON_CODES.exactNameMatch);
    }
  }

  return {
    canonicalUrl: group.parsed.canonicalUrl,
    discoveredUrl: group.parsed.discoveredUrl,
    slug,
    title: displayTitle,
    titleEntity,
    snippets,
    provider: entries[0]?.provider ?? "",
    queries: [...queryMap.entries()].map(([query, shape]) => ({ query, shape })),
    retrievedAt: maxIso(
      entries.map((entry) => entry.retrievedAt),
      checkedAt,
    ),
    signals,
    verdict,
    reasonCodes,
    notes,
    disqualifiers,
  };
}

function sortCandidates(candidates: CandidateEvaluation[]): CandidateEvaluation[] {
  const order: Record<CandidateVerdict, number> = { selectable: 0, review: 1, excluded: 2 };
  return [...candidates].sort((a, b) => {
    const verdictDelta = order[a.verdict] - order[b.verdict];
    if (verdictDelta !== 0) return verdictDelta;
    const scoreDelta = b.signals.slugNameScore - a.signals.slugNameScore;
    if (scoreDelta !== 0) return scoreDelta;
    return a.canonicalUrl.localeCompare(b.canonicalUrl);
  });
}

export function evaluateLookup(
  input: LookupContext & { companyName: string },
  rawResults: readonly RawSearchResult[],
  meta: { provider: string; checkedAt: string },
): Evaluation {
  const name = normalizeCompanyName(input.companyName);
  const aliasSource = String(input.alias ?? "").trim();
  const alias = aliasSource ? normalizeCompanyName(aliasSource) : null;
  const country = normalizeCountry(input.country);
  const city = normalizeText(String(input.city ?? "")) || null;
  const domain = normalizeDomain(input.officialDomain ?? input.officialWebsite ?? "");

  const groups = new Map<string, CandidateGroup>();
  const excludedByKey = new Map<string, ExcludedResult>();
  let validUrlCount = 0;

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
    if (!isCompanyRestrictedQuery(result.query)) {
      addExcluded(result, "untrusted_query");
      continue;
    }
    const parsed = parseLinkedInCompanyUrl(result.originalUrl);
    if (!parsed.ok) {
      addExcluded(result, parsed.reason);
      continue;
    }
    validUrlCount += 1;
    const key = parsed.canonicalUrl.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(result);
    } else {
      groups.set(key, { parsed, entries: [result] });
    }
  }

  const candidates = sortCandidates(
    [...groups.values()].map((group) =>
      buildCandidate(group, name, alias, country, city, domain, meta.checkedAt),
    ),
  );

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
    kind: "company" as const,
    lookupKey: computeLookupKey(input),
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
      reasonCodes: [REASON_CODES.noValidCompanyUrl],
      reasons: [
        `The search completed, but no URL in the results was a valid LinkedIn /company/ page.` +
          (excluded.length > 0 ? ` ${excluded.length} non-company result(s) were rejected.` : ""),
      ],
    };
  }

  const onlySelectable = selectable.length === 1 ? selectable[0] : undefined;
  if (onlySelectable && exactMatches.length === 1) {
    const corroboration = onlySelectable.signals.corroboratedBySecondQuery
      ? " A second, differently shaped query returned the same page."
      : "";
    return {
      ...base,
      status: "MATCHED",
      selectedUrl: onlySelectable.canonicalUrl,
      confidence: "high",
      reasonCodes: [
        REASON_CODES.uniqueExactMatch,
        ...(onlySelectable.signals.matchedAlias ? [REASON_CODES.aliasExactMatch] : []),
      ],
      reasons: [
        `Exactly one provider-returned LinkedIn company page matches “${input.companyName.trim()}” exactly, and no competing exact match exists.${corroboration}`,
      ],
    };
  }

  let reasonCode: string;
  let reason: string;
  if (exactMatches.length > 1) {
    reasonCode = REASON_CODES.competingExactMatches;
    reason = `${exactMatches.length} provider-returned company pages match the name exactly. A human must choose; the tool will not guess.`;
  } else if (exactMatches.length === 0) {
    reasonCode = REASON_CODES.noExactTitleMatch;
    reason = `The search returned ${candidates.length} valid LinkedIn company URL(s), but none had a title matching the company name exactly.`;
  } else {
    reasonCode = REASON_CODES.corroborationRequired;
    reason =
      "One exact candidate exists, but the name is short, generic, or ambiguous and no corroborating signal was found. Add an official domain or country, or review the candidate manually.";
  }

  return {
    ...base,
    status: "REVIEW_REQUIRED",
    selectedUrl: null,
    confidence: "low",
    reasonCodes: [reasonCode],
    reasons: [reason],
  };
}

/** Defense in depth against any future code path that could invent a URL. */
export function assertSelectedUrlWasDiscovered(evaluation: Evaluation): void {
  if (!evaluation.selectedUrl) return;
  const found = evaluation.candidates.some(
    (candidate) =>
      candidate.canonicalUrl === evaluation.selectedUrl &&
      candidate.discoveredUrl.length > 0 &&
      candidate.verdict === "selectable",
  );
  if (!found) {
    throw new Error(REASON_CODES.invariantViolation);
  }
}
