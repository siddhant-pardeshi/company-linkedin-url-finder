/** Strict, dependency-free LinkedIn URL validation and canonicalization. */

export const CANONICAL_ORIGIN = "https://www.linkedin.com";

export const URL_REJECT_REASONS = {
  empty: "url_empty",
  tooLong: "url_too_long",
  invalid: "url_invalid",
  protocol: "url_protocol",
  credentials: "url_has_credentials",
  port: "url_unexpected_port",
  backslash: "url_has_backslash",
  host: "url_untrusted_host",
  encoding: "url_malformed_encoding",
  path: "url_not_company_path",
  profilePath: "url_not_profile_path",
  segmentCount: "url_extra_path_segments",
  slug: "url_invalid_slug",
} as const;

export type UrlRejectReason = (typeof URL_REJECT_REASONS)[keyof typeof URL_REJECT_REASONS];

export type ParsedCompanyUrl = {
  ok: true;
  /** Exactly what the provider returned, trimmed only. */
  discoveredUrl: string;
  /** Normalized form of an already-discovered URL. Never built from a name. */
  canonicalUrl: string;
  slug: string;
  host: string;
};

export type RejectedCompanyUrl = {
  ok: false;
  reason: UrlRejectReason;
  discoveredUrl: string;
};

export type CompanyUrlParseResult = ParsedCompanyUrl | RejectedCompanyUrl;

/** Profile URLs have the same shape; the canonical path is `/in/<slug>/`. */
export type ParsedProfileUrl = ParsedCompanyUrl;
export type ProfileUrlParseResult = CompanyUrlParseResult;

function reject(reason: UrlRejectReason, discoveredUrl: string): RejectedCompanyUrl {
  return { ok: false, reason, discoveredUrl };
}

const SLUG_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]{0,98}[\p{L}\p{N}_-])?$/u;

export function isLinkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

export function isValidCompanySlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > 100) return false;
  if (slug === "." || slug === "..") return false;
  if (slug.includes("..")) return false;
  if (slug.includes("%") || slug.includes("/") || slug.includes("\\") || slug.includes(".")) return false;
  return SLUG_PATTERN.test(slug);
}

export const isValidProfileSlug = isValidCompanySlug;

/**
 * Accept only http(s) URLs on linkedin.com whose path is exactly
 * `/<segment>/<slug>` (optional trailing slash). Query strings and fragments
 * are stripped only after validation; the canonical URL is a normalization of
 * a discovered URL, never a URL constructed from a name.
 */
function parseEntityUrl(
  raw: string,
  segment: "company" | "in",
  pathReason: UrlRejectReason,
): CompanyUrlParseResult {
  const discoveredUrl = String(raw ?? "").trim();
  if (!discoveredUrl) return reject(URL_REJECT_REASONS.empty, discoveredUrl);
  if (discoveredUrl.length > 2048) return reject(URL_REJECT_REASONS.tooLong, discoveredUrl);
  if (discoveredUrl.includes("\\")) return reject(URL_REJECT_REASONS.backslash, discoveredUrl);

  let url: URL;
  try {
    url = new URL(discoveredUrl);
  } catch {
    return reject(URL_REJECT_REASONS.invalid, discoveredUrl);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return reject(URL_REJECT_REASONS.protocol, discoveredUrl);
  }
  if (url.username || url.password) {
    return reject(URL_REJECT_REASONS.credentials, discoveredUrl);
  }
  if (url.port) {
    return reject(URL_REJECT_REASONS.port, discoveredUrl);
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isLinkedInHost(host)) return reject(URL_REJECT_REASONS.host, discoveredUrl);

  const path = url.pathname;
  if (/%2f|%5c/i.test(path)) return reject(URL_REJECT_REASONS.encoding, discoveredUrl);
  if (path.includes("//")) return reject(pathReason, discoveredUrl);

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return reject(URL_REJECT_REASONS.encoding, discoveredUrl);
  }
  if (decodedPath.includes("\\") || decodedPath.includes("%")) {
    return reject(URL_REJECT_REASONS.encoding, discoveredUrl);
  }

  const segments = decodedPath.split("/").filter((entry) => entry.length > 0);
  if (segments.length === 0) return reject(pathReason, discoveredUrl);
  if (segments[0]?.toLowerCase() !== segment) return reject(pathReason, discoveredUrl);
  if (segments.length > 2) return reject(URL_REJECT_REASONS.segmentCount, discoveredUrl);
  const slug = segments[1];
  if (!slug) return reject(pathReason, discoveredUrl);
  if (!isValidCompanySlug(slug)) return reject(URL_REJECT_REASONS.slug, discoveredUrl);

  return {
    ok: true,
    discoveredUrl,
    canonicalUrl: `${CANONICAL_ORIGIN}/${segment}/${slug}/`,
    slug,
    host,
  };
}

export function parseLinkedInCompanyUrl(raw: string): CompanyUrlParseResult {
  return parseEntityUrl(raw, "company", URL_REJECT_REASONS.path);
}

export function parseLinkedInProfileUrl(raw: string): ProfileUrlParseResult {
  return parseEntityUrl(raw, "in", URL_REJECT_REASONS.profilePath);
}
