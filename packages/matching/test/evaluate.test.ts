import { describe, expect, it } from "vitest";
import { FIXTURE_TIME, fixtureResult, FIXTURE_COMPANIES } from "@clf/fixtures";
import {
  assertSelectedUrlWasDiscovered,
  evaluateLookup,
  parseLinkedInCompanyUrl,
  type Evaluation,
  type QueryShape,
  type RawSearchResult,
} from "../src/index.js";

const META = { provider: "fixture", checkedAt: FIXTURE_TIME };
const Q1 = 'site:linkedin.com/company/ "Company"';
const Q2 = '"Company" site:linkedin.com/company/';

function result(
  url: string,
  title: string,
  snippet = "",
  query = Q1,
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

function fixture(company: string, query: string, shape: QueryShape): RawSearchResult[] {
  const found = FIXTURE_COMPANIES.find((entry) => entry.companyName === company);
  if (!found) throw new Error(`missing fixture ${company}`);
  return found.results.map((entry) => fixtureResult(entry, query, shape));
}

function expectSelectedUrlIsDiscovered(evaluation: Evaluation, inputs: RawSearchResult[]): void {
  if (!evaluation.selectedUrl) return;
  const allowed = new Set(
    inputs
      .map((input) => parseLinkedInCompanyUrl(input.originalUrl))
      .filter((parsed) => parsed.ok)
      .map((parsed) => (parsed.ok ? parsed.canonicalUrl : null)),
  );
  expect(allowed.has(evaluation.selectedUrl)).toBe(true);
}

describe("evaluateLookup — automatic matches", () => {
  it("selects a unique exact candidate with domain corroboration", () => {
    const inputs = [...fixture("Microsoft", Q1, "primary"), ...fixture("Microsoft", Q2, "domain")];
    const evaluation = evaluateLookup(
      { companyName: "Microsoft", officialDomain: "microsoft.com" },
      inputs,
      META,
    );

    expect(evaluation.status).toBe("MATCHED");
    expect(evaluation.selectedUrl).toBe("https://www.linkedin.com/company/microsoft/");
    expect(evaluation.confidence).toBe("high");
    expect(evaluation.candidates).toHaveLength(1);
    expect(evaluation.candidates[0]?.signals.corroboratedBySecondQuery).toBe(true);
    expect(evaluation.candidates[0]?.signals.domainMentioned).toBe(true);
    expect(evaluation.reasonCodes).toContain("unique_exact_match");
    expect(evaluation.stats.validCompanyUrls).toBe(2);
    expectSelectedUrlIsDiscovered(evaluation, inputs);
  });

  it("merges duplicate discoveries across queries into one candidate", () => {
    const inputs = [...fixture("Microsoft", Q1, "primary"), ...fixture("Microsoft", Q2, "reshaped")];
    const evaluation = evaluateLookup({ companyName: "Microsoft" }, inputs, META);
    expect(evaluation.candidates).toHaveLength(1);
    expect(evaluation.candidates[0]?.queries).toHaveLength(2);
    expect(evaluation.status).toBe("MATCHED");
  });

  it("accepts a user-supplied alias as an exact match when corroborated", () => {
    const inputs = [
      result("https://www.linkedin.com/company/example", "Example | LinkedIn", "example.de", Q1, "primary"),
      result("https://www.linkedin.com/company/example", "Example | LinkedIn", "example.de", Q2, "reshaped"),
    ];
    const evaluation = evaluateLookup(
      { companyName: "Beispiel GmbH", alias: "Example", officialDomain: "example.de" },
      inputs,
      META,
    );
    expect(evaluation.status).toBe("MATCHED");
    expect(evaluation.candidates[0]?.signals.matchedAlias).toBe(true);
    expect(evaluation.candidates[0]?.reasonCodes).toContain("alias_exact_match");
  });

  it("normalizes case, punctuation, and legal suffixes in titles", () => {
    const inputs = [
      result(
        "https://www.linkedin.com/company/example-private-limited",
        "EXAMPLE PRIVATE LIMITED | LinkedIn",
      ),
      result(
        "https://www.linkedin.com/company/example-private-limited",
        "Example Pvt. Ltd. | LinkedIn",
        "",
        Q2,
        "domain",
      ),
    ];
    const evaluation = evaluateLookup(
      { companyName: "Example Private Ltd", officialDomain: "example.in" },
      inputs,
      META,
    );
    expect(evaluation.status).toBe("MATCHED");
  });
});

describe("evaluateLookup — refusals", () => {
  it("requires review when two exact candidates exist", () => {
    const inputs = fixture("Acme", Q1, "primary");
    const evaluation = evaluateLookup({ companyName: "Acme" }, inputs, META);
    expect(evaluation.status).toBe("REVIEW_REQUIRED");
    expect(evaluation.selectedUrl).toBeNull();
    expect(evaluation.candidates).toHaveLength(2);
    expect(evaluation.reasonCodes).toContain("competing_exact_matches");
    expect(evaluation.stats.exactTitleMatches).toBe(2);
  });

  it("requires review when the only candidate is a valid page with a different title", () => {
    const inputs = fixture("Umbrella", Q1, "primary");
    const evaluation = evaluateLookup({ companyName: "Umbrella" }, inputs, META);
    expect(evaluation.status).toBe("REVIEW_REQUIRED");
    expect(evaluation.selectedUrl).toBeNull();
    expect(evaluation.reasonCodes).toContain("no_exact_title_match");
  });

  it("requires corroboration for a short name with only one weak signal", () => {
    const inputs = [result("https://www.linkedin.com/company/acme", "Acme | LinkedIn")];
    const evaluation = evaluateLookup({ companyName: "Acme" }, inputs, META);
    expect(evaluation.status).toBe("REVIEW_REQUIRED");
    expect(evaluation.reasonCodes).toContain("corroboration_required");
    expect(evaluation.candidates[0]?.verdict).toBe("review");
  });

  it("allows a short name when a second query corroborates it", () => {
    const inputs = [
      result("https://www.linkedin.com/company/acme", "Acme | LinkedIn"),
      result("https://www.linkedin.com/company/acme", "Acme | LinkedIn", "", Q2, "reshaped"),
    ];
    const evaluation = evaluateLookup({ companyName: "Acme" }, inputs, META);
    expect(evaluation.status).toBe("MATCHED");
    expect(evaluation.candidates[0]?.signals.corroboratedBySecondQuery).toBe(true);
  });

  it("returns NOT_FOUND for results that are not company pages", () => {
    const inputs = fixture("Initech", Q1, "primary");
    const evaluation = evaluateLookup({ companyName: "Initech" }, inputs, META);
    expect(evaluation.status).toBe("NOT_FOUND");
    expect(evaluation.selectedUrl).toBeNull();
    expect(evaluation.candidates).toHaveLength(0);
    expect(evaluation.excludedResults).toHaveLength(2);
    expect(evaluation.excludedResults.map((entry) => entry.reason)).toEqual([
      "url_not_company_path",
      "url_not_company_path",
    ]);
  });

  it("returns NOT_FOUND for lookalike LinkedIn domains", () => {
    const inputs = [
      result("https://linkedin.com.evil.example/company/acme", "Acme | LinkedIn"),
      result("https://evil.example/company/acme", "Acme | LinkedIn"),
    ];
    const evaluation = evaluateLookup({ companyName: "Acme" }, inputs, META);
    expect(evaluation.status).toBe("NOT_FOUND");
    expect(evaluation.excludedResults.every((entry) => entry.reason === "url_untrusted_host")).toBe(true);
  });

  it("ignores results that did not come from a company-restricted query", () => {
    const inputs = [result("https://www.linkedin.com/company/acme", "Acme | LinkedIn", "", "acme linkedin")];
    const evaluation = evaluateLookup({ companyName: "Acme", officialDomain: "acme.com" }, inputs, META);
    expect(evaluation.status).toBe("NOT_FOUND");
    expect(evaluation.excludedResults[0]?.reason).toBe("untrusted_query");
  });

  it("returns NOT_FOUND for an empty candidate set", () => {
    const evaluation = evaluateLookup({ companyName: "Globex" }, [], META);
    expect(evaluation.status).toBe("NOT_FOUND");
    expect(evaluation.confidence).toBe("none");
  });

  it("never selects a URL that was not in the provider results", () => {
    for (const company of FIXTURE_COMPANIES) {
      const inputs = fixture(company.companyName, Q1, "primary");
      const evaluation = evaluateLookup({ companyName: company.companyName }, inputs, META);
      if (evaluation.selectedUrl) {
        const discovered = new Set(
          inputs.map((input) => parseLinkedInCompanyUrl(input.originalUrl)).filter((parsed) => parsed.ok),
        );
        const canonical = [...discovered].map((parsed) => (parsed.ok ? parsed.canonicalUrl : ""));
        expect(canonical).toContain(evaluation.selectedUrl);
      }
    }
  });
});

describe("assertSelectedUrlWasDiscovered", () => {
  it("throws when a selection is not backed by a selectable candidate", () => {
    const inputs = fixture("Acme", Q1, "primary");
    const evaluation = evaluateLookup({ companyName: "Acme" }, inputs, META);
    const forged: Evaluation = {
      ...evaluation,
      status: "MATCHED",
      selectedUrl: "https://www.linkedin.com/company/guessed-slug/",
    };
    expect(() => assertSelectedUrlWasDiscovered(forged)).toThrow("invariant_violation");
  });

  it("does not throw for MATCHED evaluations", () => {
    const inputs = fixture("Microsoft", Q1, "primary");
    const evaluation = evaluateLookup(
      { companyName: "Microsoft", officialDomain: "microsoft.com" },
      inputs,
      META,
    );
    expect(() => assertSelectedUrlWasDiscovered(evaluation)).not.toThrow();
  });
});
