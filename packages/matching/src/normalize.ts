import type { LookupContext } from "./types.js";

/**
 * Deterministic text normalization.
 *
 * Rules (documented in docs/ACCURACY_POLICY.md):
 *  - NFKD, strip combining marks (accents), lowercase.
 *  - Ampersand becomes "and".
 *  - Any run of characters that is not a Unicode letter or number becomes a space.
 *    This keeps non-Latin company names intact.
 *  - Trailing legal-form tokens are removed from the *comparison* form only;
 *    raw values are always preserved for audit and export.
 */

export const LEGAL_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "plc",
  "pvt",
  "private",
  "gmbh",
  "mbh",
  "ag",
  "sa",
  "sas",
  "sarl",
  "bv",
  "nv",
  "oy",
  "oyj",
  "ab",
  "as",
  "pte",
  "srl",
  "spa",
  "kk",
  "corp",
  "corporation",
  "co",
  "company",
  "lp",
  "llp",
  "sdn",
  "bhd",
  "kft",
  "zrt",
  "kg",
  "se",
  "ug",
  "sro",
  "ooo",
  "oao",
  "jsc",
  "pjsc",
]);

/**
 * Generic words that alone do not identify a company. Used only to decide
 * whether an *additional* corroborating signal is required before auto-match.
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "global",
  "international",
  "solutions",
  "solution",
  "services",
  "service",
  "systems",
  "system",
  "group",
  "holdings",
  "holding",
  "industries",
  "industry",
  "technologies",
  "technology",
  "tech",
  "labs",
  "lab",
  "ventures",
  "capital",
  "partners",
  "consulting",
  "digital",
  "media",
  "software",
  "data",
  "cloud",
  "energy",
  "health",
  "care",
  "financial",
  "finance",
  "insurance",
  "logistics",
  "retail",
  "markets",
  "trading",
  "enterprises",
  "enterprise",
  "associates",
  "agency",
  "studio",
  "studios",
  "works",
  "network",
  "networks",
  "communications",
  "telecom",
  "motors",
  "foods",
  "food",
  "pharma",
  "chemicals",
  "engineering",
  "construction",
  "realty",
  "estate",
  "properties",
  "investment",
  "investments",
]);

/** Names that are commonly shared by unrelated businesses. */
const AMBIGUOUS_NAMES: ReadonlySet<string> = new Set([
  "acme",
  "apex",
  "vertex",
  "summit",
  "horizon",
  "pioneer",
  "united",
  "standard",
  "first",
  "general",
  "national",
  "american",
  "global",
  "premier",
  "prime",
  "elite",
  "dynamic",
  "innovative",
  "advanced",
  "smart",
  "next",
  "star",
  "sun",
  "sky",
  "blue",
  "green",
  "red",
  "alpha",
  "beta",
  "delta",
  "omega",
  "core",
  "base",
  "link",
  "connect",
  "axis",
  "nova",
  "zenith",
  "atlas",
  "orion",
  "titan",
  "phoenix",
  "meridian",
]);

/**
 * Country spelling variants used for the (non-decisive) country signal.
 * Deliberately excludes collision-prone two-letter codes such as "us", "in", "it".
 */
const COUNTRY_ALIAS_GROUPS: readonly string[][] = [
  ["united states", "united states of america", "usa", "u s a"],
  ["united kingdom", "uk", "great britain", "england", "scotland", "wales", "northern ireland"],
  ["united arab emirates", "uae"],
  ["india", "bharat"],
  ["germany", "deutschland"],
  ["france"],
  ["canada"],
  ["australia"],
  ["singapore"],
  ["japan"],
  ["china", "prc"],
  ["brazil", "brasil"],
  ["mexico"],
  ["spain", "espana"],
  ["italy", "italia"],
  ["netherlands", "holland"],
  ["sweden"],
  ["switzerland"],
  ["ireland"],
  ["israel"],
  ["south korea", "korea", "republic of korea"],
  ["new zealand"],
  ["south africa"],
  ["nigeria"],
  ["kenya"],
  ["pakistan"],
  ["bangladesh"],
  ["indonesia"],
  ["malaysia"],
  ["philippines"],
  ["vietnam"],
  ["thailand"],
  ["turkey", "turkiye"],
  ["poland"],
  ["portugal"],
  ["norway"],
  ["denmark"],
  ["finland"],
  ["belgium"],
  ["austria"],
  ["saudi arabia"],
  ["qatar"],
  ["egypt"],
  ["argentina"],
  ["chile"],
  ["colombia"],
];

export function normalizeText(value: string): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

/** Remove trailing legal-form tokens, never reducing a name to nothing. */
export function stripLegalSuffixes(tokens: readonly string[]): string[] {
  const result = [...tokens];
  while (result.length > 1) {
    const last = result[result.length - 1];
    if (last !== undefined && LEGAL_SUFFIX_TOKENS.has(last)) {
      result.pop();
      continue;
    }
    const beforeLast = result[result.length - 2];
    if (last === "and" && beforeLast !== undefined && LEGAL_SUFFIX_TOKENS.has(beforeLast)) {
      result.pop();
      continue;
    }
    break;
  }
  // A connector left dangling after removing "& Co." is not part of the name.
  if (result.length > 1 && result[result.length - 1] === "and") result.pop();
  return result;
}

export type NormalizedName = {
  raw: string;
  normalized: string;
  core: string;
  tokens: string[];
  coreTokens: string[];
  /**
   * True when the name alone is too weak to auto-match without an additional
   * corroborating signal (single token, very short, generic, or known-ambiguous).
   */
  isShortOrCommon: boolean;
};

export function normalizeCompanyName(name: string): NormalizedName {
  const raw = String(name ?? "").trim();
  const normalized = normalizeText(raw);
  const tokens = normalized ? normalized.split(" ") : [];
  const coreTokens = stripLegalSuffixes(tokens);
  const core = coreTokens.join(" ");
  const allGeneric = coreTokens.length > 0 && coreTokens.every((token) => GENERIC_TOKENS.has(token));
  const isShortOrCommon =
    core.length === 0 ||
    coreTokens.length <= 1 ||
    core.length <= 4 ||
    allGeneric ||
    AMBIGUOUS_NAMES.has(core);
  return { raw, normalized, core, tokens, coreTokens, isShortOrCommon };
}

/** Exact comparison of normalized core names (legal suffixes removed). */
export function companyNamesEquivalent(a: NormalizedName, b: NormalizedName): boolean {
  return a.core.length > 0 && a.core === b.core;
}

/**
 * Normalize a user-supplied domain or website into a bare lowercase host.
 * Returns null when the value is not a plausible public hostname.
 */
export function normalizeDomain(value: string | undefined | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let host: string;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (host.length < 4 || host.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return null;
  }
  if (!/\.[a-z]{2,}$/.test(host)) return null;
  return host;
}

export function normalizeCountry(value: string | undefined | null): string | null {
  const normalized = normalizeText(String(value ?? ""));
  return normalized ? normalized : null;
}

const COUNTRY_INPUT_ALIASES: Readonly<Record<string, string>> = {
  us: "united states",
  usa: "united states",
  "u s a": "united states",
  america: "united states",
  uk: "united kingdom",
  "great britain": "united kingdom",
  uae: "united arab emirates",
  holland: "netherlands",
  deutschland: "germany",
  espana: "spain",
  italia: "italy",
  brasil: "brazil",
  turkiye: "turkey",
};

function countryAliases(country: string): string[] {
  const normalized = normalizeText(country);
  if (!normalized) return [];
  const canonical = COUNTRY_INPUT_ALIASES[normalized] ?? normalized;
  for (const group of COUNTRY_ALIAS_GROUPS) {
    if (group.includes(canonical)) return group;
  }
  return [canonical];
}

/** True when any spelling of the supplied country appears as a whole phrase. */
export function countryMentioned(country: string | undefined | null, haystack: string): boolean {
  const aliases = countryAliases(String(country ?? ""));
  if (aliases.length === 0) return false;
  const padded = ` ${normalizeText(haystack)} `;
  return aliases.some((alias) => padded.includes(` ${alias} `));
}

/** True when the supplied domain appears as a real host, not as a substring. */
export function domainMentioned(domain: string | null, haystack: string): boolean {
  if (!domain) return false;
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutWww = escaped.replace(/^www\\\./, "");
  const pattern = new RegExp(
    `(?:^|[^a-z0-9.-])(?:www\\.)?${withoutWww}(?::\\d+)?(?:[/?#]|[^a-z0-9.-]|$)`,
    "i",
  );
  return pattern.test(haystack);
}

/**
 * Provider titles look like "Acme Corp | LinkedIn" or
 * "Acme Corp - Overview | LinkedIn". Extract the entity portion so an exact
 * normalized comparison is meaningful.
 */
export function extractTitleEntity(title: string): string {
  let value = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  value = value.replace(/\s*[|•·]\s*linkedin(?:\.com)?\s*$/i, "");
  value = value.replace(/\s*[-–—]\s*linkedin(?:\.com)?\s*$/i, "");
  value = value.replace(/\s+on\s+linkedin\s*$/i, "");
  value = value.replace(/\s*\((?:formerly|fka|now)\s[^)]*\)\s*$/i, "");
  const parts = value.split(/\s+[|–—]\s+|\s+-\s+/);
  const first = parts[0]?.trim();
  if (parts.length > 1 && first) value = first;
  return value.trim();
}

/** Dice coefficient over slug tokens and name tokens. Audit/order only. */
export function slugNameScore(slug: string, nameTokens: readonly string[]): number {
  const slugTokens = String(slug)
    .toLowerCase()
    .split(/[-_.\s]+/)
    .filter(Boolean);
  const left = new Set(slugTokens);
  const right = new Set(nameTokens.filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

/**
 * Stable de-duplication key: every row sharing this key can share one lookup,
 * while the original rows are all preserved.
 */
export function computeLookupKey(input: LookupContext & { companyName: string }): string {
  const name = normalizeCompanyName(input.companyName);
  const alias = normalizeCompanyName(input.alias ?? "");
  const domain = normalizeDomain(input.officialDomain ?? input.officialWebsite ?? "");
  const country = normalizeCountry(input.country);
  return JSON.stringify([name.core || name.normalized, alias.core, country, domain]);
}
