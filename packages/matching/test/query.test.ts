import { describe, expect, it } from "vitest";
import { isCompanyRestrictedQuery, MAX_QUERY_LENGTH, planQueries, sanitizePhrase } from "../src/index.js";

describe("sanitizePhrase", () => {
  it("removes quotes, backslashes, control characters, and collapses whitespace", () => {
    expect(sanitizePhrase('  Acme "Global" \\ Ltd  ')).toBe("Acme Global Ltd");
    expect(sanitizePhrase("Acme\u0000Corp")).toBe("Acme Corp");
    expect(sanitizePhrase("a".repeat(500))).toHaveLength(120);
  });
});

describe("planQueries", () => {
  it("always starts with a quoted, company-restricted exact-name query", () => {
    const queries = planQueries({ companyName: "Acme Corp" });
    expect(queries[0]).toMatchObject({ shape: "primary" });
    expect(queries[0]?.query).toBe('site:linkedin.com/company/ "Acme Corp"');
    expect(isCompanyRestrictedQuery(queries[0]?.query ?? "")).toBe(true);
  });

  it("adds domain and country constraints when supplied", () => {
    const queries = planQueries({
      companyName: "Example Private Ltd",
      country: "India",
      officialDomain: "https://www.example.in/",
    });
    const shapes = queries.map((query) => query.shape);
    expect(shapes).toContain("domain");
    expect(shapes).toContain("country");
    expect(queries.find((query) => query.shape === "domain")?.query).toBe(
      'site:linkedin.com/company/ "Example Private Ltd" "example.in"',
    );
    expect(queries.find((query) => query.shape === "country")?.query).toBe(
      'site:linkedin.com/company/ "Example Private Ltd" "India"',
    );
  });

  it("adds an alias query only when the alias differs", () => {
    const withAlias = planQueries({ companyName: "Beispiel GmbH", alias: "Example Pvt Ltd" });
    expect(withAlias.some((query) => query.shape === "alias")).toBe(true);
    const sameAlias = planQueries({ companyName: "Example Private Ltd", alias: "Example Private Limited" });
    expect(sameAlias.some((query) => query.shape === "alias")).toBe(false);
  });

  it("adds a differently shaped corroboration query for ambiguous names", () => {
    const queries = planQueries({ companyName: "Acme" });
    expect(queries.map((query) => query.shape)).toEqual(["primary", "reshaped"]);
    expect(queries[1]?.query).toBe('"Acme" site:linkedin.com/company/');
  });

  it("caps the plan at four queries and de-duplicates identical queries", () => {
    const queries = planQueries({
      companyName: "Acme",
      country: "India",
      officialDomain: "acme.com",
      alias: "Acme Labs",
    });
    expect(queries).toHaveLength(4);
    expect(new Set(queries.map((query) => query.query)).size).toBe(4);
  });

  it("returns no queries for an empty or symbol-only name", () => {
    expect(planQueries({ companyName: "   " })).toEqual([]);
    expect(planQueries({ companyName: "---" })).toEqual([]);
  });

  it("keeps every query within the provider length limit", () => {
    for (const query of planQueries({ companyName: "A".repeat(500), country: "B".repeat(500) })) {
      expect(query.query.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
    }
  });
});

describe("isCompanyRestrictedQuery", () => {
  it("accepts the site restriction anywhere in the query", () => {
    expect(isCompanyRestrictedQuery('site:linkedin.com/company/ "Acme"')).toBe(true);
    expect(isCompanyRestrictedQuery('"Acme" site:linkedin.com/company')).toBe(true);
    expect(isCompanyRestrictedQuery('"Acme" site:www.linkedin.com/company/')).toBe(false);
    expect(isCompanyRestrictedQuery('"Acme" site:linkedin.com/in/')).toBe(false);
    expect(isCompanyRestrictedQuery("Acme LinkedIn")).toBe(false);
  });
});
