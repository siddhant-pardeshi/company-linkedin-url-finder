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
    expect(parsed.lookups[0]?.companyName).toBe("Microsoft");
    expect(parsed.lookups[0]?.country).toBe("United States");
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
