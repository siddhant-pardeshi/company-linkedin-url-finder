import { describe, expect, it } from "vitest";
import { evaluateLookup, type Evaluation } from "@clf/matching";
import { FIXTURE_TIME, FIXTURE_COMPANIES, fixtureResult } from "@clf/fixtures";
import {
  exportFilename,
  parseCsv,
  parseCsvToRows,
  parsePaste,
  rowsToCsv,
  rowsToJson,
  SAMPLE_CSV,
} from "../src/ui/csv.js";
import { filterRows, paginate, sortRows } from "../src/ui/view.js";
import type { Job, ResultRow } from "../src/types.js";

const META = { provider: "fixture", checkedAt: FIXTURE_TIME };

function evaluationFor(company: string, withDomain = false): Evaluation {
  const fixture = FIXTURE_COMPANIES.find((entry) => entry.companyName === company);
  if (!fixture) throw new Error("missing fixture");
  const query = `site:linkedin.com/company/ "${company}"`;
  const results = fixture.results.map((result) => fixtureResult(result, query, "primary"));
  return evaluateLookup(
    { companyName: company, ...(withDomain ? { officialDomain: "microsoft.com" } : {}) },
    results,
    META,
  );
}

function row(overrides: Partial<ResultRow> & Pick<ResultRow, "rowIndex" | "status">): ResultRow {
  return {
    id: `job:${overrides.rowIndex}`,
    jobId: "job",
    raw: { companyName: `Company ${overrides.rowIndex}` },
    lookupKey: "key",
    selectedUrl: null,
    confidence: "none",
    evaluation: null,
    provider: null,
    checkedAt: null,
    error: null,
    confirmedBy: null,
    rejectedCandidates: [],
    updatedAt: FIXTURE_TIME,
    ...overrides,
  };
}

const job: Job = {
  id: "11111111-2222-3333-4444-555555555555",
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
  state: "completed",
  totalRows: 3,
  totalLookups: 3,
  batchSize: 5,
  operatorName: "Test",
  pauseReason: null,
  lastError: null,
  cooldownUntil: null,
  startedAt: FIXTURE_TIME,
  finishedAt: FIXTURE_TIME,
};

describe("parseCsv", () => {
  it("handles quotes, commas, escaped quotes, and embedded newlines", () => {
    const text = 'a,b\r\n"Acme, Inc.","Line one\nLine two"\r\n"Say ""hi""",x\r\n';
    const { records, errors } = parseCsv(text);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(3);
    expect(records[1]?.fields).toEqual(["Acme, Inc.", "Line one\nLine two"]);
    expect(records[2]?.fields).toEqual(['Say "hi"', "x"]);
  });

  it("strips a BOM and accepts LF and CR line endings", () => {
    const { records } = parseCsv("\uFEFFcompany_name\nAcme\nGlobex");
    expect(records.map((record) => record.fields[0])).toEqual(["company_name", "Acme", "Globex"]);
  });

  it("reports an unclosed quoted field", () => {
    const { errors } = parseCsv('company_name,notes\n"Acme,unterminated');
    expect(errors.some((error) => error.message.includes("Unclosed"))).toBe(true);
  });
});

describe("parseCsvToRows", () => {
  it("imports the documented schema and optional context", () => {
    const result = parseCsvToRows(SAMPLE_CSV);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toMatchObject({
      companyName: "Microsoft",
      country: "United States",
      officialDomain: "microsoft.com",
      officialWebsite: "https://www.microsoft.com",
    });
    expect(result.rows[1]?.alias).toBe("Example Pvt Ltd");
  });

  it("accepts tolerant header aliases", () => {
    const result = parseCsvToRows("Company,Domain,Country\nAcme,acme.com,United States\n");
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ companyName: "Acme", officialDomain: "acme.com" });
  });

  it("requires a company_name column", () => {
    const result = parseCsvToRows("domain,country\nacme.com,United States\n");
    expect(result.errors[0]?.message).toMatch(/company_name column/);
  });

  it("reports row-level validation errors", () => {
    const result = parseCsvToRows(
      "company_name,official_domain,official_website\n,acme.com,\n" +
        "Acme,not a domain,\n" +
        "Globex,,ftp://example.com\n" +
        "Initech,,https://initech.example\n",
    );
    expect(result.rows.map((row) => row.companyName)).toEqual(["Initech"]);
    expect(result.errors.map((error) => error.line)).toEqual([2, 3, 4]);
  });

  it("skips blank lines and reports duplicate lookups", () => {
    const result = parseCsvToRows("company_name\nAcme\n\nacme\nAcme Pvt Ltd\n");
    expect(result.rows).toHaveLength(3);
    expect(result.totalRows).toBe(3);
    expect(result.duplicateRows).toBe(2);
  });

  it("rejects an empty file", () => {
    expect(parseCsvToRows("").errors[0]?.message).toMatch(/empty/);
  });
});

describe("parsePaste", () => {
  it("takes one company per line and ignores blanks", () => {
    const result = parsePaste("Microsoft\n\n  Example Private Ltd  \n");
    expect(result.rows).toEqual([{ companyName: "Microsoft" }, { companyName: "Example Private Ltd" }]);
    expect(result.totalRows).toBe(2);
  });

  it("flags over-long names", () => {
    const result = parsePaste("a".repeat(201));
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]?.line).toBe(1);
  });
});

describe("rowsToCsv", () => {
  it("exports every row, evidence, candidates, errors, and confirmations", () => {
    const matched = row({
      rowIndex: 1,
      status: "MATCHED",
      selectedUrl: "https://www.linkedin.com/company/microsoft/",
      confidence: "high",
      evaluation: evaluationFor("Microsoft", true),
      raw: { companyName: "Microsoft", country: "United States" },
      provider: "fixture",
      checkedAt: FIXTURE_TIME,
    });
    const review = row({
      rowIndex: 2,
      status: "REVIEW_REQUIRED",
      confidence: "low",
      evaluation: evaluationFor("Acme"),
      raw: { companyName: "Acme, Inc." },
    });
    const failed = row({
      rowIndex: 3,
      status: "ERROR",
      raw: { companyName: '=HYPERLINK("https://evil.example","click")' },
      error: { code: "provider_unavailable", message: "Provider down", retryable: true, at: FIXTURE_TIME },
    });
    const notFound = row({ rowIndex: 4, status: "NOT_FOUND", evaluation: evaluationFor("Initech") });
    const confirmed = row({
      rowIndex: 5,
      status: "USER_CONFIRMED",
      selectedUrl: "https://www.linkedin.com/company/acme-inc/",
      confidence: "low",
      evaluation: evaluationFor("Acme"),
      confirmedBy: {
        actor: "Test Operator",
        at: FIXTURE_TIME,
        canonicalUrl: "https://www.linkedin.com/company/acme-inc/",
      },
    });

    const csv = rowsToCsv([matched, review, failed, notFound, confirmed]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("candidate_urls");
    expect(csv).toContain('"Acme, Inc."');
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""click"")"`);
    expect(csv).toContain("provider_unavailable: Provider down");
    expect(csv).toContain("Test Operator at");
    expect(csv).toContain("https://www.linkedin.com/company/acme-inc/");
    expect(csv.split("\r\n").every((line) => line.split('","').length >= 0)).toBe(true);
  });
});

describe("rowsToJson", () => {
  it("preserves raw inputs and full evidence", () => {
    const matched = row({
      rowIndex: 1,
      status: "MATCHED",
      selectedUrl: "https://www.linkedin.com/company/microsoft/",
      confidence: "high",
      evaluation: evaluationFor("Microsoft", true),
      raw: { companyName: "Microsoft" },
    });
    const json = rowsToJson([matched], job, "1.0.0", FIXTURE_TIME);
    expect(json.product).toBe("Company Page Finder");
    expect(json.rows[0]?.raw.companyName).toBe("Microsoft");
    expect(json.rows[0]?.evaluation?.candidates.length).toBeGreaterThan(0);
    expect(json.job.id).toBe(job.id);
    expect(JSON.parse(JSON.stringify(json)).rows[0].evaluation.candidates[0].discoveredUrl).toContain(
      "linkedin.com",
    );
  });
});

describe("exportFilename", () => {
  it("uses a timestamp and a short job id", () => {
    expect(exportFilename("company-page-finder", job, "csv", new Date("2026-11-26T10:45:00.000Z"))).toBe(
      "company-page-finder_2026-11-26T10-45-00_11111111.csv",
    );
  });
});

describe("view helpers", () => {
  const rows = [
    row({ rowIndex: 1, status: "MATCHED", raw: { companyName: "Microsoft", country: "United States" } }),
    row({ rowIndex: 2, status: "REVIEW_REQUIRED", raw: { companyName: "Acme" } }),
    row({ rowIndex: 3, status: "NOT_FOUND", raw: { companyName: "Globex" } }),
    row({
      rowIndex: 4,
      status: "ERROR",
      error: { code: "provider_unavailable", message: "Down", retryable: true, at: FIXTURE_TIME },
    }),
    row({ rowIndex: 5, status: "USER_CONFIRMED", selectedUrl: "https://www.linkedin.com/company/acme-inc/" }),
    row({ rowIndex: 6, status: "PENDING" }),
  ];

  it("filters by grouped status and free text", () => {
    expect(filterRows(rows, "MATCHED", "").map((entry) => entry.rowIndex)).toEqual([1, 5]);
    expect(filterRows(rows, "PENDING", "").map((entry) => entry.rowIndex)).toEqual([6]);
    expect(filterRows(rows, "ALL", "acme").map((entry) => entry.rowIndex)).toEqual([2, 5]);
    expect(filterRows(rows, "ERROR", "down")).toHaveLength(1);
  });

  it("sorts by company, status, and row number", () => {
    expect(sortRows(rows, "company", "asc").map((entry) => entry.raw.companyName)[0]).toBe("Acme");
    expect(sortRows(rows, "rowIndex", "desc")[0]?.rowIndex).toBe(6);
    expect(sortRows(rows, "status", "asc")[0]?.status).toBe("PENDING");
  });

  it("paginates and clamps the page", () => {
    const page = paginate(rows, 99, 4);
    expect(page.totalPages).toBe(2);
    expect(page.page).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.start).toBe(5);
    expect(page.end).toBe(6);
    expect(paginate([], 1, 10).totalPages).toBe(1);
  });
});
