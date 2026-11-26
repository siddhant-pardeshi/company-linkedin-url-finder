import { describe, expect, it } from "vitest";
import { FIXTURE_TIME } from "@clf/fixtures";
import {
  computePersonLookupKey,
  evaluatePersonLookup,
  extractProfileName,
  normalizePersonName,
  parseLinkedInProfileUrl,
  personNamesEquivalent,
  planPersonQueries,
  sanitizePersonExtraQuery,
  type PersonInput,
  type QueryShape,
  type RawSearchResult,
} from "../src/index.js";

const META = { provider: "fixture", checkedAt: FIXTURE_TIME };
const Q = 'site:linkedin.com/in/ "Ada Lovelace"';

function result(
  url: string,
  title: string,
  snippet = "",
  query = Q,
  shape: QueryShape = "primary",
): RawSearchResult {
  return {
    originalUrl: url,
    title,
    snippet,
    provider: "fixture",
    query,
    shape,
    retrievedAt: FIXTURE_TIME,
  };
}

const PROFILE = "https://www.linkedin.com/in/ada-lovelace/";
const TITLE = "Ada Lovelace - Mathematician - Analytical Engines | LinkedIn";
const SNIPPET = "London, England · Analytical Engines · Mathematics";

describe("parseLinkedInProfileUrl", () => {
  it("accepts profile URLs and canonicalizes only discovered URLs", () => {
    const parsed = parseLinkedInProfileUrl(`${PROFILE}?trk=public#about`);
    expect(parsed).toMatchObject({
      ok: true,
      canonicalUrl: PROFILE,
      slug: "ada-lovelace",
    });
  });

  it("accepts locale subdomains and http", () => {
    for (const url of [
      "https://uk.linkedin.com/in/ada-lovelace",
      "http://linkedin.com/in/ada-lovelace/",
      "https://www.linkedin.com/in/Ada-Lovelace/",
    ]) {
      const parsed = parseLinkedInProfileUrl(url);
      expect(parsed.ok).toBe(true);
    }
  });

  it("rejects company pages, people subpaths, and lookalikes", () => {
    const rejected: Array<[string, string]> = [
      ["https://www.linkedin.com/company/ada", "url_not_profile_path"],
      ["https://www.linkedin.com/pub/ada-lovelace/1", "url_not_profile_path"],
      ["https://www.linkedin.com/in/ada-lovelace/details/experience", "url_extra_path_segments"],
      ["https://www.linkedin.com/in/", "url_not_profile_path"],
      ["https://www.linkedin.com/in/ada%2Flovelace", "url_malformed_encoding"],
      ["https://linkedin.com.evil.example/in/ada", "url_untrusted_host"],
      ["https://www.linkedin.com/in/ada.lovelace", "url_invalid_slug"],
    ];
    for (const [url, reason] of rejected) {
      const parsed = parseLinkedInProfileUrl(url);
      expect(parsed.ok, url).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe(reason);
    }
  });
});

describe("person name normalization", () => {
  it("handles commas, credential suffixes, and punctuation", () => {
    expect(normalizePersonName("Lovelace, Ada").core).toBe("ada lovelace");
    expect(normalizePersonName("Ada Lovelace, PhD").core).toBe("ada lovelace");
    expect(normalizePersonName("  ADA   LOVELACE ").core).toBe("ada lovelace");
    expect(normalizePersonName("Ada").isShortOrCommon).toBe(true);
    expect(normalizePersonName("Ada Lovelace").isShortOrCommon).toBe(false);
  });

  it("extracts the display name from a profile title", () => {
    expect(extractProfileName(TITLE)).toBe("Ada Lovelace");
    expect(extractProfileName("Ada Lovelace | LinkedIn")).toBe("Ada Lovelace");
    expect(extractProfileName("Ada Lovelace, PhD - Mathematician | LinkedIn")).toBe("Ada Lovelace");
    expect(extractProfileName("Ada Lovelace – Mathematician – Analytical Engines")).toBe("Ada Lovelace");
  });

  it("compares names exactly after normalization", () => {
    expect(
      personNamesEquivalent(normalizePersonName("Ada Lovelace"), normalizePersonName("Lovelace, Ada")),
    ).toBe(true);
    expect(
      personNamesEquivalent(normalizePersonName("Ada Lovelace"), normalizePersonName("Ada Lovelace-Smith")),
    ).toBe(false);
  });

  it("keys equivalent people together and different facts apart", () => {
    const base = computePersonLookupKey({
      kind: "person",
      fullName: "Ada Lovelace",
      company: "Analytical Engines",
    });
    const same = computePersonLookupKey({
      kind: "person",
      fullName: "Lovelace, Ada",
      company: " analytical   engines ",
    });
    expect(same).toBe(base);
    expect(
      computePersonLookupKey({ kind: "person", fullName: "Ada Lovelace", company: "Other Company" }),
    ).not.toBe(base);
  });
});

describe("planPersonQueries", () => {
  const input: PersonInput = {
    kind: "person",
    fullName: "Ada Lovelace",
    company: "Analytical Engines",
    jobTitle: "Mathematician",
    location: "London",
  };

  it("builds profile-restricted exact-name queries with context", () => {
    const queries = planPersonQueries(input);
    expect(queries[0]?.query).toBe('site:linkedin.com/in/ "Ada Lovelace"');
    expect(queries.map((query) => query.shape)).toContain("company");
    expect(queries.map((query) => query.shape)).toContain("title");
    expect(queries.map((query) => query.shape)).toContain("location");
    expect(queries.every((query) => query.query.includes("site:linkedin.com/in/"))).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(5);
  });

  it("accepts only safe AI queries containing the exact name", () => {
    const valid = sanitizePersonExtraQuery(
      'site:linkedin.com/in/ "Ada Lovelace" "Countess of Lovelace"',
      normalizePersonName("Ada Lovelace"),
    );
    expect(valid).toBeTruthy();

    for (const unsafe of [
      'site:linkedin.com/in/ada-lovelace "Ada Lovelace"',
      "https://www.linkedin.com/in/ada-lovelace/",
      'site:linkedin.com/in/ "Someone Else"',
      'site:linkedin.com/company/ "Ada Lovelace"',
    ]) {
      expect(sanitizePersonExtraQuery(unsafe, normalizePersonName("Ada Lovelace"))).toBeNull();
    }
  });

  it("adds at most two validated AI queries", () => {
    const queries = planPersonQueries({
      ...input,
      extraQueries: [
        'site:linkedin.com/in/ "Ada Lovelace" "Countess of Lovelace"',
        'site:linkedin.com/in/ "Ada Lovelace" "Charles Babbage"',
        'site:linkedin.com/in/ "Ada Lovelace" "extra"',
      ],
    });
    expect(queries.filter((query) => query.shape === "ai")).toHaveLength(2);
  });
});

describe("evaluatePersonLookup", () => {
  const fullInput: PersonInput = {
    kind: "person",
    fullName: "Ada Lovelace",
    company: "Analytical Engines",
    jobTitle: "Mathematician",
    location: "London",
  };

  it("matches one exact profile with a supplied corroborating fact", () => {
    const evaluation = evaluatePersonLookup(
      fullInput,
      [
        result(PROFILE, TITLE, SNIPPET),
        result(
          PROFILE,
          TITLE,
          SNIPPET,
          '"Ada Lovelace" "Analytical Engines" site:linkedin.com/in/',
          "reshaped",
        ),
      ],
      META,
    );
    expect(evaluation.kind).toBe("person");
    expect(evaluation.status).toBe("MATCHED");
    expect(evaluation.selectedUrl).toBe(PROFILE);
    expect(evaluation.candidates[0]?.signals.companyMentioned).toBe(true);
    expect(evaluation.candidates[0]?.signals.corroboratedBySecondQuery).toBe(true);
  });

  it("requires context for a name-only lookup", () => {
    const evaluation = evaluatePersonLookup(
      { kind: "person", fullName: "Ada Lovelace" },
      [result(PROFILE, TITLE, SNIPPET)],
      META,
    );
    expect(evaluation.status).toBe("REVIEW_REQUIRED");
    expect(evaluation.selectedUrl).toBeNull();
    expect(evaluation.reasonCodes).toContain("context_required");
  });

  it("requires the supplied context to appear in the evidence", () => {
    const evaluation = evaluatePersonLookup(
      { kind: "person", fullName: "Ada Lovelace", company: "Unrelated Corp" },
      [result(PROFILE, TITLE, SNIPPET)],
      META,
    );
    expect(evaluation.status).toBe("REVIEW_REQUIRED");
    expect(evaluation.reasonCodes).toContain("corroboration_required");
  });

  it("routes two exact name matches to review", () => {
    const evaluation = evaluatePersonLookup(
      fullInput,
      [
        result(PROFILE, TITLE, SNIPPET),
        result("https://www.linkedin.com/in/ada-lovelace-2/", TITLE, SNIPPET),
      ],
      META,
    );
    expect(evaluation.status).toBe("REVIEW_REQUIRED");
    expect(evaluation.reasonCodes).toContain("competing_exact_names");
    expect(evaluation.selectedUrl).toBeNull();
  });

  it("does not match a different name", () => {
    const evaluation = evaluatePersonLookup(
      fullInput,
      [
        result(
          "https://www.linkedin.com/in/ada-king/",
          "Ada King - Mathematician - Analytical Engines | LinkedIn",
          SNIPPET,
        ),
      ],
      META,
    );
    expect(evaluation.status).toBe("REVIEW_REQUIRED");
    expect(evaluation.reasonCodes).toContain("no_exact_name_match");
  });

  it("returns not found for company URLs and untrusted queries", () => {
    const evaluation = evaluatePersonLookup(
      fullInput,
      [
        result(
          "https://www.linkedin.com/company/analytical-engines/",
          "Analytical Engines | LinkedIn",
          SNIPPET,
        ),
        result(PROFILE, TITLE, SNIPPET, 'site:linkedin.com/company/ "Ada Lovelace"'),
      ],
      META,
    );
    expect(evaluation.status).toBe("NOT_FOUND");
    expect(evaluation.excludedResults.map((entry) => entry.reason)).toEqual([
      "url_not_profile_path",
      "untrusted_query",
    ]);
    expect(evaluation.selectedUrl).toBeNull();
  });
});
