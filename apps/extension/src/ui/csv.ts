import {
  computeLookupKey,
  normalizeCompanyName,
  normalizeDomain,
  type Evaluation,
  type RowStatus,
} from "@clf/matching";
import type { Job, RawRow, ResultRow } from "../types.js";
import type { AuditEntry } from "@clf/matching";

export type CsvParseError = { line: number; message: string };

export type CsvRecord = { fields: string[]; line: number };

export type ImportResult = {
  rows: RawRow[];
  errors: CsvParseError[];
  duplicateRows: number;
  totalRows: number;
};

const MAX_ERRORS = 100;

export const SAMPLE_CSV = `company_name,country,region,city,official_domain,official_website,alias,notes
Microsoft,United States,Washington,Redmond,microsoft.com,https://www.microsoft.com,,
Example Private Ltd,India,Maharashtra,Pune,example.in,https://example.in,Example Pvt Ltd,
Acme,,,,,,,
Umbrella,United Kingdom,,London,,,,
Initech,,,,,,,
`;

/**
 * RFC-4180-style CSV parser: quoted fields, escaped quotes, embedded newlines,
 * CRLF/LF/CR, BOM, and clear errors for malformed quoting.
 */
export function parseCsv(text: string): { records: CsvRecord[]; errors: CsvParseError[] } {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  const records: CsvRecord[] = [];
  const errors: CsvParseError[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let recordStarted = false;
  let index = 0;

  const pushField = (): void => {
    fields.push(field);
    field = "";
  };

  const pushRecord = (): void => {
    pushField();
    if (fields.some((value) => value.trim() !== "")) {
      records.push({ fields, line: recordLine });
    }
    fields = [];
    recordStarted = false;
  };

  while (index < input.length) {
    const char = input[index] ?? "";
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      if (char === "\r") {
        if (input[index + 1] === "\n") index += 1;
        field += "\n";
        line += 1;
        index += 1;
        continue;
      }
      if (char === "\n") {
        field += "\n";
        line += 1;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      if (field.trim() !== "") {
        if (errors.length < MAX_ERRORS) {
          errors.push({ line, message: "Unexpected quote inside an unquoted field." });
        }
        field += char;
        index += 1;
        continue;
      }
      inQuotes = true;
      field = "";
      if (!recordStarted) {
        recordStarted = true;
        recordLine = line;
      }
      index += 1;
      continue;
    }

    if (char === ",") {
      pushField();
      if (!recordStarted) {
        recordStarted = true;
        recordLine = line;
      }
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      if (recordStarted || field !== "" || fields.length > 0) pushRecord();
      line += 1;
      recordLine = line;
      index += 1;
      continue;
    }

    field += char;
    if (!recordStarted) {
      recordStarted = true;
      recordLine = line;
    }
    index += 1;
  }

  if (inQuotes) {
    errors.push({ line: recordLine, message: "Unclosed quoted field at the end of the file." });
  } else if (recordStarted || field !== "" || fields.length > 0) {
    pushRecord();
  }

  return { records, errors };
}

const HEADER_ALIASES: Record<string, keyof RawRow> = {
  company_name: "companyName",
  company: "companyName",
  companyname: "companyName",
  name: "companyName",
  country: "country",
  region: "region",
  state: "region",
  city: "city",
  official_domain: "officialDomain",
  domain: "officialDomain",
  official_website: "officialWebsite",
  website: "officialWebsite",
  url: "officialWebsite",
  alias: "alias",
  notes: "notes",
  note: "notes",
};

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function headerMap(header: string[]): Map<keyof RawRow, number> {
  const map = new Map<keyof RawRow, number>();
  header.forEach((name, index) => {
    const key = HEADER_ALIASES[normalizeHeader(name)];
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function cell(record: CsvRecord, index: number | undefined): string {
  if (index === undefined) return "";
  return (record.fields[index] ?? "").trim();
}

function validateRow(row: RawRow, line: number, errors: CsvParseError[]): boolean {
  if (!row.companyName) {
    errors.push({ line, message: "company_name is required." });
    return false;
  }
  if (row.companyName.length > 200) {
    errors.push({ line, message: "company_name must be at most 200 characters." });
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(row.companyName)) {
    errors.push({ line, message: "company_name contains control characters." });
    return false;
  }
  const limits: Array<[keyof RawRow, number]> = [
    ["country", 120],
    ["region", 120],
    ["city", 120],
    ["alias", 120],
    ["notes", 500],
    ["officialDomain", 253],
    ["officialWebsite", 400],
  ];
  for (const [field, max] of limits) {
    const value = row[field];
    if (typeof value === "string" && value.length > max) {
      errors.push({ line, message: `${field} must be at most ${max} characters.` });
      return false;
    }
  }
  if (row.officialDomain && !normalizeDomain(row.officialDomain)) {
    errors.push({ line, message: "official_domain is not a valid domain." });
    return false;
  }
  if (row.officialWebsite) {
    const website = row.officialWebsite;
    let valid = false;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`);
      valid =
        (url.protocol === "http:" || url.protocol === "https:") && Boolean(normalizeDomain(url.hostname));
    } catch {
      valid = false;
    }
    if (!valid) {
      errors.push({ line, message: "official_website is not a valid web address." });
      return false;
    }
  }
  return true;
}

function countDuplicates(rows: readonly RawRow[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = computeLookupKey(row);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

export function parseCsvToRows(text: string): ImportResult {
  const { records, errors } = parseCsv(text);
  const result: ImportResult = { rows: [], errors, duplicateRows: 0, totalRows: 0 };
  if (records.length === 0) {
    result.errors.push({ line: 1, message: "The CSV file is empty." });
    return result;
  }
  const header = records[0];
  if (!header) return result;
  const map = headerMap(header.fields);
  if (!map.has("companyName")) {
    result.errors.push({
      line: header.line,
      message: "The CSV needs a company_name column (company_name, company, or name).",
    });
    return result;
  }

  for (const record of records.slice(1)) {
    if (record.fields.every((value) => value.trim() === "")) continue;
    result.totalRows += 1;
    const row: RawRow = { companyName: cell(record, map.get("companyName")) };
    const optional: Array<keyof RawRow> = [
      "country",
      "region",
      "city",
      "officialDomain",
      "officialWebsite",
      "alias",
      "notes",
    ];
    for (const field of optional) {
      const value = cell(record, map.get(field));
      if (value) row[field] = value;
    }
    if (validateRow(row, record.line, result.errors)) result.rows.push(row);
    if (result.errors.length >= MAX_ERRORS) break;
  }

  result.duplicateRows = countDuplicates(result.rows);
  return result;
}

export function parsePaste(text: string): ImportResult {
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const result: ImportResult = { rows: [], errors: [], duplicateRows: 0, totalRows: 0 };
  lines.forEach((line, index) => {
    const companyName = line.trim();
    const lineNumber = index + 1;
    if (!companyName) return;
    result.totalRows += 1;
    if (companyName.length > 200) {
      result.errors.push({ line: lineNumber, message: "Company name must be at most 200 characters." });
      return;
    }
    if (/[\u0000-\u001f\u007f]/.test(companyName)) {
      result.errors.push({ line: lineNumber, message: "Company name contains control characters." });
      return;
    }
    result.rows.push({ companyName });
  });
  result.duplicateRows = countDuplicates(result.rows);
  return result;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula injection (CSV is commonly opened in Excel).
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function rowsToCsv(rows: readonly ResultRow[]): string {
  const headers = [
    "row_number",
    "company_name",
    "normalized_name",
    "country",
    "region",
    "city",
    "official_domain",
    "official_website",
    "alias",
    "notes",
    "status",
    "selected_url",
    "confidence",
    "evidence",
    "reason_codes",
    "checked_at",
    "provider",
    "candidate_count",
    "candidate_urls",
    "error",
    "confirmed_by",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    const evaluation: Evaluation | null = row.evaluation;
    const selected = evaluation?.candidates.find((candidate) => candidate.canonicalUrl === row.selectedUrl);
    const evidence = selected ? selected.notes.join(" ") : (evaluation?.reasons.join(" ") ?? "");
    const reasons = [...(evaluation?.reasonCodes ?? []), ...(row.error ? [row.error.code] : [])];
    lines.push(
      [
        row.rowIndex,
        row.raw.companyName,
        normalizeCompanyName(row.raw.companyName).core,
        row.raw.country ?? "",
        row.raw.region ?? "",
        row.raw.city ?? "",
        row.raw.officialDomain ?? "",
        row.raw.officialWebsite ?? "",
        row.raw.alias ?? "",
        row.raw.notes ?? "",
        row.status,
        row.selectedUrl ?? "",
        row.confidence,
        evidence,
        reasons.join("; "),
        row.checkedAt ?? "",
        row.provider ?? "",
        evaluation ? String(evaluation.candidates.length) : "0",
        evaluation ? evaluation.candidates.map((candidate) => candidate.canonicalUrl).join("; ") : "",
        row.error ? `${row.error.code}: ${row.error.message}` : "",
        row.confirmedBy ? `${row.confirmedBy.actor} at ${row.confirmedBy.at}` : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

export type JsonExport = {
  product: string;
  version: string;
  exportedAt: string;
  job: Job;
  audit: AuditEntry[];
  rows: Array<{
    rowNumber: number;
    raw: RawRow;
    normalizedName: string;
    lookupKey: string;
    status: RowStatus;
    selectedUrl: string | null;
    confidence: string;
    confirmedBy: ResultRow["confirmedBy"];
    rejectedCandidates: string[];
    provider: string | null;
    checkedAt: string | null;
    error: ResultRow["error"];
    evaluation: Evaluation | null;
  }>;
};

export function rowsToJson(
  rows: readonly ResultRow[],
  job: Job,
  version: string,
  exportedAt: string,
  audit: readonly AuditEntry[] = [],
): JsonExport {
  return {
    product: "Company Page Finder",
    version,
    exportedAt,
    job,
    audit: [...audit],
    rows: rows.map((row) => ({
      rowNumber: row.rowIndex,
      raw: row.raw,
      normalizedName: row.evaluation?.normalizedName ?? normalizeCompanyName(row.raw.companyName).core,
      lookupKey: row.lookupKey,
      status: row.status,
      selectedUrl: row.selectedUrl,
      confidence: row.confidence,
      confirmedBy: row.confirmedBy,
      rejectedCandidates: row.rejectedCandidates,
      provider: row.provider,
      checkedAt: row.checkedAt,
      error: row.error,
      evaluation: row.evaluation,
    })),
  };
}

export function exportFilename(prefix: string, job: Job, extension: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}_${stamp}_${job.id.slice(0, 8)}.${extension}`;
}
