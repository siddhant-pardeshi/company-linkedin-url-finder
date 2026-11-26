import { describe, expect, it } from "vitest";
import {
  ApiSchemaError,
  MAX_API_BODY_BYTES,
  MAX_LOOKUPS_PER_REQUEST,
  parseSearchRequest,
  parseSearchResponse,
  SEARCH_SCHEMA_VERSION,
} from "../src/index.js";
import { FIXTURE_TIME } from "@clf/fixtures";

const validRequest = {
  schemaVersion: SEARCH_SCHEMA_VERSION,
  idempotencyKey: "job-1:abc123",
  lookups: [
    {
      id: "row-1",
      companyName: "Microsoft",
      country: "United States",
      officialDomain: "microsoft.com",
    },
  ],
};

const validResponse = {
  schemaVersion: SEARCH_SCHEMA_VERSION,
  provider: "brave",
  generatedAt: FIXTURE_TIME,
  results: [
    {
      id: "row-1",
      queries: [
        { query: 'site:linkedin.com/company/ "Microsoft"', shape: "primary", rationale: "Exact name." },
      ],
      results: [
        {
          originalUrl: "https://www.linkedin.com/company/microsoft/",
          title: "Microsoft | LinkedIn",
          snippet: "microsoft.com",
          provider: "brave",
          query: 'site:linkedin.com/company/ "Microsoft"',
          shape: "primary",
          retrievedAt: FIXTURE_TIME,
        },
      ],
      errors: [],
      cached: false,
    },
  ],
};

describe("parseSearchRequest", () => {
  it("accepts a valid request and trims optional values", () => {
    const parsed = parseSearchRequest({
      ...validRequest,
      lookups: [{ ...validRequest.lookups[0], country: "  United States  " }],
    });
    expect(parsed.lookups[0]?.kind).toBe("company");
    const lookup = parsed.lookups[0] as { companyName?: string; country?: string };
    expect(lookup.companyName).toBe("Microsoft");
    expect(lookup.country).toBe("United States");
  });

  it("accepts a person lookup with safe AI queries", () => {
    const parsed = parseSearchRequest({
      ...validRequest,
      lookups: [
        {
          id: "p1",
          kind: "person",
          fullName: "Ada Lovelace",
          company: "Analytical Engines",
          jobTitle: "Mathematician",
          location: "London",
          email: "ada@example.test",
          extraQueries: ['site:linkedin.com/in/ "Ada Lovelace" "Countess of Lovelace"'],
        },
      ],
    });
    const lookup = parsed.lookups[0];
    expect(lookup?.kind).toBe("person");
    if (lookup?.kind === "person") {
      expect(lookup.fullName).toBe("Ada Lovelace");
      expect(lookup.extraQueries).toHaveLength(1);
      expect(lookup.email).toBe("ada@example.test");
    }
  });

  it("rejects unsafe or off-name AI queries", () => {
    for (const extraQueries of [
      ['site:linkedin.com/in/ada-lovelace "Ada Lovelace"'],
      ["https://www.linkedin.com/in/ada-lovelace/"],
      ['site:linkedin.com/in/ "Someone Else"'],
      [
        'site:linkedin.com/in/ "Ada Lovelace"',
        'site:linkedin.com/in/ "Ada Lovelace"',
        'site:linkedin.com/in/ "Ada Lovelace"',
      ],
    ]) {
      expect(() =>
        parseSearchRequest({
          ...validRequest,
          lookups: [{ id: "p1", kind: "person", fullName: "Ada Lovelace", extraQueries }],
        }),
      ).toThrow(ApiSchemaError);
    }
  });

  it("rejects invalid person fields", () => {
    for (const lookup of [
      { id: "p1", kind: "person", fullName: "" },
      { id: "p1", kind: "person", fullName: "Ada Lovelace", email: "not-an-email" },
      { id: "p1", kind: "person", fullName: "Ada Lovelace", company: "a".repeat(201) },
      { id: "p1", kind: "unknown", companyName: "Acme" },
    ]) {
      expect(() => parseSearchRequest({ ...validRequest, lookups: [lookup] })).toThrow(ApiSchemaError);
    }
  });

  it("rejects an unsupported schema version", () => {
    expect(() => parseSearchRequest({ ...validRequest, schemaVersion: 2 })).toThrow(ApiSchemaError);
  });

  it("rejects missing, empty, over-long, or unsafe names", () => {
    for (const companyName of ["", "   ", "a".repeat(201), "Acme\u0000Corp"]) {
      expect(() => parseSearchRequest({ ...validRequest, lookups: [{ id: "r1", companyName }] })).toThrow(
        ApiSchemaError,
      );
    }
  });

  it("rejects empty and oversized batches", () => {
    expect(() => parseSearchRequest({ ...validRequest, lookups: [] })).toThrow(ApiSchemaError);
    const tooMany = Array.from({ length: MAX_LOOKUPS_PER_REQUEST + 1 }, (_, index) => ({
      id: `r${index}`,
      companyName: `Company ${index}`,
    }));
    expect(() => parseSearchRequest({ ...validRequest, lookups: tooMany })).toThrow(ApiSchemaError);
  });

  it("rejects duplicate lookup IDs", () => {
    expect(() =>
      parseSearchRequest({
        ...validRequest,
        lookups: [
          { id: "same", companyName: "Acme" },
          { id: "same", companyName: "Globex" },
        ],
      }),
    ).toThrow(/unique/);
  });

  it("rejects invalid idempotency keys", () => {
    for (const idempotencyKey of ["short", "x".repeat(201), "bad key with spaces", "-leading-hyphen"]) {
      expect(() => parseSearchRequest({ ...validRequest, idempotencyKey })).toThrow(ApiSchemaError);
    }
  });

  it("rejects a non-object payload", () => {
    expect(() => parseSearchRequest(null)).toThrow(ApiSchemaError);
    expect(() => parseSearchRequest([])).toThrow(ApiSchemaError);
  });
});

describe("parseSearchResponse", () => {
  it("accepts a valid response", () => {
    const parsed = parseSearchResponse(validResponse);
    expect(parsed.results[0]?.id).toBe("row-1");
    expect(parsed.results[0]?.results[0]?.title).toBe("Microsoft | LinkedIn");
  });

  it("rejects unknown query shapes and error codes", () => {
    const badShape = structuredClone(validResponse);
    badShape.results[0]!.queries[0]!.shape = "guessed";
    expect(() => parseSearchResponse(badShape)).toThrow(/not a supported query shape/);

    const badCode = structuredClone(validResponse);
    badCode.results[0]!.errors.push({ code: "made_up", message: "x", retryable: true } as never);
    expect(() => parseSearchResponse(badCode)).toThrow(/not a supported error code/);
  });

  it("rejects missing fields and invalid dates", () => {
    expect(() => parseSearchResponse({ ...validResponse, provider: "" })).toThrow(ApiSchemaError);
    expect(() => parseSearchResponse({ ...validResponse, generatedAt: "not-a-date" })).toThrow(/ISO date/);
    expect(() => parseSearchResponse({ ...validResponse, results: "nope" })).toThrow(ApiSchemaError);
  });

  it("exposes a bounded request size", () => {
    expect(MAX_API_BODY_BYTES).toBe(64 * 1024);
  });
});
