import { normalizeCompanyName, normalizeDomain, normalizeText } from "./normalize.js";
import type { LookupContext, PlannedQuery, QueryShape } from "./types.js";

/**
 * Query planning (documented in docs/ACCURACY_POLICY.md):
 *  - Every query is restricted to LinkedIn company pages.
 *  - The name is always quoted as an exact phrase; supplied facts only narrow it.
 *  - At most four queries per lookup to bound provider cost.
 *  - A differently shaped second query is added for short/ambiguous names or when
 *    no domain/country was supplied, so corroboration is possible without guessing.
 */

export const MAX_QUERIES_PER_LOOKUP = 4;
export const MAX_QUERY_LENGTH = 400;
const MAX_PHRASE_LENGTH = 120;
const SITE_RESTRICTION = "site:linkedin.com/company/";

export function sanitizePhrase(value: string): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PHRASE_LENGTH)
    .trim();
}

function quote(phrase: string): string {
  return `"${phrase}"`;
}

export function planQueries(input: LookupContext & { companyName: string }): PlannedQuery[] {
  const name = sanitizePhrase(input.companyName);
  if (!name || !normalizeText(name)) return [];

  const aliasRaw = sanitizePhrase(input.alias ?? "");
  const normalizedName = normalizeCompanyName(input.companyName);
  const normalizedAlias = normalizeCompanyName(aliasRaw);
  const domain = normalizeDomain(input.officialDomain ?? input.officialWebsite ?? "");
  const country = sanitizePhrase(input.country ?? "");

  const planned: PlannedQuery[] = [];
  const seen = new Set<string>();
  const add = (query: string, shape: QueryShape, rationale: string): void => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > MAX_QUERY_LENGTH || seen.has(trimmed)) return;
    if (planned.length >= MAX_QUERIES_PER_LOOKUP) return;
    seen.add(trimmed);
    planned.push({ query: trimmed, shape, rationale });
  };

  add(
    `${SITE_RESTRICTION} ${quote(name)}`,
    "primary",
    "Exact company name restricted to LinkedIn company pages.",
  );

  if (normalizedAlias.core && normalizedAlias.core !== normalizedName.core) {
    add(
      `${SITE_RESTRICTION} ${quote(aliasRaw)}`,
      "alias",
      "User-supplied alias, queried separately so it can corroborate the primary name.",
    );
  }

  if (domain) {
    add(
      `${SITE_RESTRICTION} ${quote(name)} ${quote(domain)}`,
      "domain",
      "Adds the supplied official domain as a narrowing constraint.",
    );
  }

  if (country) {
    add(
      `${SITE_RESTRICTION} ${quote(name)} ${quote(country)}`,
      "country",
      "Adds the supplied country as a narrowing constraint.",
    );
  }

  const needsSecondShape = normalizedName.isShortOrCommon || (!domain && !country);
  if (needsSecondShape) {
    add(
      `${quote(name)} ${SITE_RESTRICTION}`,
      "reshaped",
      "Differently shaped query used only to corroborate the same candidate.",
    );
  }

  return planned;
}

/** Defense in depth: a candidate must have come from a company-restricted query. */
export function isCompanyRestrictedQuery(query: string): boolean {
  return /(^|\s)site:linkedin\.com\/company\/?(\s|$)/i.test(query);
}

/** Defense in depth: a person candidate must have come from a profile-restricted query. */
export function isProfileRestrictedQuery(query: string): boolean {
  return /(^|\s)site:linkedin\.com\/in\/?(\s|$)/i.test(query);
}
