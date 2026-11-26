import { describe, expect, it } from "vitest";
import { parseLinkedInCompanyUrl, URL_REJECT_REASONS } from "../src/index.js";

describe("parseLinkedInCompanyUrl", () => {
  it("accepts a canonical company URL and normalizes it", () => {
    const parsed = parseLinkedInCompanyUrl("https://www.linkedin.com/company/acme");
    expect(parsed).toMatchObject({
      ok: true,
      canonicalUrl: "https://www.linkedin.com/company/acme/",
      slug: "acme",
      discoveredUrl: "https://www.linkedin.com/company/acme",
    });
  });

  it("strips query strings and fragments only after validation", () => {
    const parsed = parseLinkedInCompanyUrl("https://www.linkedin.com/company/acme/?trk=public#about");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.canonicalUrl).toBe("https://www.linkedin.com/company/acme/");
  });

  it("accepts locale subdomains, http, trailing slash, and uppercase hosts", () => {
    for (const url of [
      "https://uk.linkedin.com/company/acme/",
      "http://linkedin.com/company/acme/",
      "https://WWW.LINKEDIN.COM/company/acme/",
      "https://de.linkedin.com/company/acme",
    ]) {
      const parsed = parseLinkedInCompanyUrl(url);
      expect(parsed.ok, url).toBe(true);
      if (parsed.ok) expect(parsed.canonicalUrl).toBe("https://www.linkedin.com/company/acme/");
    }
  });

  it("preserves slug case in the canonical form", () => {
    const parsed = parseLinkedInCompanyUrl("https://www.linkedin.com/company/Acme-Global/");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.slug).toBe("Acme-Global");
      expect(parsed.canonicalUrl).toBe("https://www.linkedin.com/company/Acme-Global/");
    }
  });

  const rejected: Array<[string, string]> = [
    ["", URL_REJECT_REASONS.empty],
    ["   ", URL_REJECT_REASONS.empty],
    ["not a url", URL_REJECT_REASONS.invalid],
    ["ftp://linkedin.com/company/acme", URL_REJECT_REASONS.protocol],
    ["javascript:alert(1)", URL_REJECT_REASONS.protocol],
    ["https://user:pass@linkedin.com/company/acme", URL_REJECT_REASONS.credentials],
    ["https://linkedin.com:8443/company/acme", URL_REJECT_REASONS.port],
    ["https://linkedin.com\\company\\acme", URL_REJECT_REASONS.backslash],
    ["https://linkedin.com.evil.example/company/acme", URL_REJECT_REASONS.host],
    ["https://evil-linkedin.com/company/acme", URL_REJECT_REASONS.host],
    ["https://www.linkedin.com.evil.example/company/acme", URL_REJECT_REASONS.host],
    ["https://notlinkedin.com/company/acme", URL_REJECT_REASONS.host],
    ["https://lnkd.in/abc", URL_REJECT_REASONS.host],
    ["https://bit.ly/company/acme", URL_REJECT_REASONS.host],
    ["https://www.linkedin.com/in/jane-doe", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/jobs/view/123", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/school/acme-university", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/groups/12345", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/showcase/acme", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/company/", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/company?x=1", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/company/acme/life", URL_REJECT_REASONS.segmentCount],
    ["https://www.linkedin.com/company/acme/about", URL_REJECT_REASONS.segmentCount],
    ["https://www.linkedin.com/company/acme//", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/company/acme%2Fadmin", URL_REJECT_REASONS.encoding],
    ["https://www.linkedin.com/company/acme%20corp", URL_REJECT_REASONS.slug],
    ["https://www.linkedin.com/company/..", URL_REJECT_REASONS.path],
    ["https://www.linkedin.com/company/acme.example", URL_REJECT_REASONS.slug],
    ["https://www.linkedin.com/company/" + "a".repeat(101), URL_REJECT_REASONS.slug],
    ["https://www.linkedin.com/", URL_REJECT_REASONS.path],
  ];

  it.each(rejected)("rejects %s", (url, reason) => {
    const parsed = parseLinkedInCompanyUrl(url);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe(reason);
      expect(parsed.discoveredUrl).toBe(url.trim());
    }
  });

  it("rejects an over-long URL", () => {
    const parsed = parseLinkedInCompanyUrl(`https://www.linkedin.com/company/acme?x=${"a".repeat(2100)}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe(URL_REJECT_REASONS.tooLong);
  });

  it("rejects malformed percent encoding", () => {
    const parsed = parseLinkedInCompanyUrl("https://www.linkedin.com/company/acme%zz");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe(URL_REJECT_REASONS.encoding);
  });
});
