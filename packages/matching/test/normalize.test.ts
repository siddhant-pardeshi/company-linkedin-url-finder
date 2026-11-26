import { describe, expect, it } from "vitest";
import {
  companyNamesEquivalent,
  computeLookupKey,
  countryMentioned,
  domainMentioned,
  extractTitleEntity,
  normalizeCompanyName,
  normalizeDomain,
  normalizeText,
  slugNameScore,
} from "../src/index.js";

describe("normalizeText", () => {
  it("handles accents, ampersands, punctuation, and typographic characters", () => {
    expect(normalizeText("Crème Brûlée & Co.")).toBe("creme brulee and co");
    expect(normalizeText("Ernst & Young")).toBe("ernst and young");
    expect(normalizeText("  Acme—Global  ")).toBe("acme global");
    expect(normalizeText("O’Reilly Media")).toBe("o reilly media");
  });

  it("preserves non-Latin letters", () => {
    expect(normalizeText("株式会社テスト")).toBe("株式会社テスト");
    expect(normalizeText("ООО Ромашка")).toBe("ооо ромашка");
  });

  it("returns an empty string for empty or symbol-only input", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("  ---  ")).toBe("");
  });
});

describe("normalizeCompanyName", () => {
  it("removes trailing legal-form tokens only", () => {
    expect(normalizeCompanyName("Acme Pvt. Ltd.").core).toBe("acme");
    expect(normalizeCompanyName("Acme Private Limited").core).toBe("acme");
    expect(normalizeCompanyName("Acme, Inc.").core).toBe("acme");
    expect(normalizeCompanyName("Acme GmbH & Co. KG").core).toBe("acme");
    expect(normalizeCompanyName("Acme Holdings").core).toBe("acme holdings");
  });

  it("never reduces a name to an empty string", () => {
    expect(normalizeCompanyName("Limited").core).toBe("limited");
    expect(normalizeCompanyName("Co.").core).toBe("co");
  });

  it("compares names exactly after normalization", () => {
    const a = normalizeCompanyName("Example Private Ltd");
    const b = normalizeCompanyName("Example Private Limited");
    const c = normalizeCompanyName("Example");
    expect(companyNamesEquivalent(a, b)).toBe(true);
    expect(companyNamesEquivalent(a, c)).toBe(true);
    expect(companyNamesEquivalent(normalizeCompanyName("Acme"), normalizeCompanyName("Acme Robotics"))).toBe(
      false,
    );
  });

  it("flags short, generic, and ambiguous names", () => {
    expect(normalizeCompanyName("Acme").isShortOrCommon).toBe(true);
    expect(normalizeCompanyName("X").isShortOrCommon).toBe(true);
    expect(normalizeCompanyName("Global Solutions").isShortOrCommon).toBe(true);
    expect(normalizeCompanyName("Microsoft").isShortOrCommon).toBe(true);
    expect(normalizeCompanyName("Example Private Ltd").isShortOrCommon).toBe(true);
    expect(normalizeCompanyName("Northwind Traders").isShortOrCommon).toBe(false);
  });
});

describe("normalizeDomain", () => {
  it("extracts a bare host from domains and websites", () => {
    expect(normalizeDomain("microsoft.com")).toBe("microsoft.com");
    expect(normalizeDomain("https://www.microsoft.com/en-us/")).toBe("microsoft.com");
    expect(normalizeDomain("HTTP://WWW.Example.CO.UK")).toBe("example.co.uk");
    expect(normalizeDomain("sub.example.org")).toBe("sub.example.org");
  });

  it("rejects values that are not plausible hosts", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("https://")).toBeNull();
    expect(normalizeDomain("javascript:alert(1)")).toBeNull();
  });
});

describe("countryMentioned", () => {
  it("matches country spellings as whole phrases", () => {
    expect(countryMentioned("United States", "Redmond, Washington, United States")).toBe(true);
    expect(countryMentioned("US", "Redmond, Washington, United States")).toBe(true);
    expect(countryMentioned("USA", "Redmond, Washington, United States")).toBe(true);
    expect(countryMentioned("United Kingdom", "London, England")).toBe(true);
    expect(countryMentioned("India", "Pune, Maharashtra, India")).toBe(true);
    expect(countryMentioned("India", "Indianapolis, Indiana")).toBe(false);
  });

  it("does not treat the pronoun 'us' as the United States", () => {
    expect(countryMentioned("US", "Contact us for a demo")).toBe(false);
  });
});

describe("domainMentioned", () => {
  it("requires a real host boundary", () => {
    expect(domainMentioned("microsoft.com", "Visit microsoft.com for details")).toBe(true);
    expect(domainMentioned("microsoft.com", "https://www.microsoft.com/en-us")).toBe(true);
    expect(domainMentioned("microsoft.com", "notmicrosoft.com")).toBe(false);
    expect(domainMentioned("microsoft.com", "microsoft.com.evil.example")).toBe(false);
    expect(domainMentioned("microsoft.com", "Microsoft Corporation")).toBe(false);
  });
});

describe("extractTitleEntity", () => {
  it("removes LinkedIn decorations and descriptor clauses", () => {
    expect(extractTitleEntity("Microsoft | LinkedIn")).toBe("Microsoft");
    expect(extractTitleEntity("Acme Corp - LinkedIn")).toBe("Acme Corp");
    expect(extractTitleEntity("Acme Corp | 2,000 employees | LinkedIn")).toBe("Acme Corp");
    expect(extractTitleEntity("Acme Corp — Overview, News & Competitors")).toBe("Acme Corp");
    expect(extractTitleEntity("Acme on LinkedIn")).toBe("Acme");
    expect(extractTitleEntity("Acme (formerly Acme Labs) | LinkedIn")).toBe("Acme");
    expect(extractTitleEntity("Coca-Cola | LinkedIn")).toBe("Coca-Cola");
  });
});

describe("slugNameScore", () => {
  it("scores token overlap without being decisive", () => {
    expect(slugNameScore("acme", ["acme"])).toBe(1);
    expect(slugNameScore("acme-global", ["acme"])).toBeCloseTo(2 / 3, 5);
    expect(slugNameScore("acme", ["acme", "global"])).toBeCloseTo(2 / 3, 5);
    expect(slugNameScore("unrelated", ["acme"])).toBe(0);
    expect(slugNameScore("", ["acme"])).toBe(0);
  });
});

describe("computeLookupKey", () => {
  it("deduplicates equivalent names and context", () => {
    const a = computeLookupKey({
      companyName: "Example Private Ltd",
      country: "India",
      officialDomain: "example.in",
    });
    const b = computeLookupKey({
      companyName: "  example private limited ",
      country: "india",
      officialDomain: "https://www.example.in/",
    });
    expect(a).toBe(b);
  });

  it("keeps different context separate", () => {
    const base = computeLookupKey({ companyName: "Acme" });
    expect(computeLookupKey({ companyName: "Acme", country: "India" })).not.toBe(base);
    expect(computeLookupKey({ companyName: "Acme", officialDomain: "acme.com" })).not.toBe(base);
    expect(computeLookupKey({ companyName: "Acme", alias: "Acme Labs" })).not.toBe(base);
  });
});
