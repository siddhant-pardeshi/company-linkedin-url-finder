import {
  computeLookupKeyFor,
  normalizeDomain,
  type AuditEntry,
  type CompanyInput,
  type Evaluation,
  type LookupInput,
  type PersonInput,
  type RowStatus,
} from "@clf/matching";
import type { Job, RawRow, ResultRow } from "../types.js";
import { rowKind, rowNormalizedName } from "../job/rows.js";

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
Umbrella,,,,,,,
Initech,,,,,,,
`;

export const PEOPLE_SAMPLE_CSV = `full_name,company,job_title,location,email,phone,notes
Ada Lovelace,Analytical Engines,Mathematician,"London, England",ada@example.test,,
Grace Hopper,United States Navy,Rear Admiral,"Arlington, Virginia",,,
Alan Turing,Bletchley Park,Mathematician,"Bletchley, England",,,
Noah Body,,,,,,
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
    if (fields.some((value) => value.trim() !== "")) records.push({ fields, line: recordLine });
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
        if (errors.length < MAX_ERRORS)
          errors.push({ line, message: "Unexpected quote inside an unquoted field." });
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

const COMPANY_HEADER_ALIASES: Record<string, keyof CompanyInput> = {
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

const PERSON_HEADER_ALIASES: Record<string, keyof PersonInput> = {
  full_name: "fullName",
  fullname: "fullName",
  person_name: "fullName",
  name: "fullName",
  company: "company",
  employer: "company",
  organization: "company",
  job_title: "jobTitle",
  title: "jobTitle",
  role: "jobTitle",
  location: "location",
  city: "location",
  email: "email",
  phone: "phone",
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

function headerMap<T extends string>(header: string[], aliases: Record<string, T>): Map<T, number> {
  const map = new Map<T, number>();
  header.forEach((name, index) => {
    const key = aliases[normalizeHeader(name)];
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function cell(record: CsvRecord, index: number | undefined): string {
  if (index === undefined) return "";
  return (record.fields[index] ?? "").trim();
}

function countDuplicates(rows: readonly LookupInput[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = computeLookupKeyFor(row);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

function validateCommonText(
  value: string,
  label: string,
  max: number,
  line: number,
  errors: CsvParseError[],
): boolean {
  if (value.length > max) {
    errors.push({ line, message: `${label} must be at most ${max} characters.` });
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    errors.push({ line, message: `${label} contains control characters.` });
    return false;
  }
  return true;
}

function validateCompanyRow(row: CompanyInput, line: number, errors: CsvParseError[]): boolean {
  if (!row.companyName) {
    errors.push({ line, message: "company_name is required." });
    return false;
  }
  if (!validateCommonText(row.companyName, "company_name", 200, line, errors)) return false;
  for (const [field, max] of [
    ["country", 120],
    ["region", 120],
    ["city", 120],
    ["alias", 120],
    ["notes", 500],
    ["officialDomain", 253],
    ["officialWebsite", 400],
  ] as const) {
    const value = row[field];
    if (typeof value === "string" && !validateCommonText(value, field, max, line, errors)) return false;
  }
  if (row.officialDomain && !normalizeDomain(row.officialDomain)) {
    errors.push({ line, message: "official_domain is not a valid domain." });
    return false;
  }
  if (row.officialWebsite) {
    let valid = false;
    try {
      const url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(row.officialWebsite)
          ? row.officialWebsite
          : `https://${row.officialWebsite}`,
      );
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

function validatePersonRow(row: PersonInput, line: number, errors: CsvParseError[]): boolean {
  if (!row.fullName) {
    errors.push({ line, message: "full_name is required." });
    return false;
  }
  if (!validateCommonText(row.fullName, "full_name", 200, line, errors)) return false;
  for (const [field, max] of [
    ["company", 200],
    ["jobTitle", 200],
    ["location", 200],
    ["notes", 500],
  ] as const) {
    const value = row[field];
    if (typeof value === "string" && !validateCommonText(value, field, max, line, errors)) return false;
  }
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
    errors.push({ line, message: "email is not a valid email address." });
    return false;
  }
  if (row.phone && row.phone.length > 40) {
    errors.push({ line, message: "phone must be at most 40 characters." });
    return false;
  }
  return true;
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
  const map = headerMap(header.fields, COMPANY_HEADER_ALIASES);
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
    const row: CompanyInput = { companyName: cell(record, map.get("companyName")) };
    for (const [field] of [
      ["country", 1],
      ["region", 1],
      ["city", 1],
      ["officialDomain", 1],
      ["officialWebsite", 1],
      ["alias", 1],
      ["notes", 1],
    ] as const) {
      const value = cell(record, map.get(field));
      if (value) row[field] = value;
    }
    if (validateCompanyRow(row, record.line, result.errors)) result.rows.push(row);
    if (result.errors.length >= MAX_ERRORS) break;
  }

  result.duplicateRows = countDuplicates(result.rows);
  return result;
}

export function parsePeopleCsvToRows(text: string): ImportResult {
  const { records, errors } = parseCsv(text);
  const result: ImportResult = { rows: [], errors, duplicateRows: 0, totalRows: 0 };
  if (records.length === 0) {
    result.errors.push({ line: 1, message: "The CSV file is empty." });
    return result;
  }
  const header = records[0];
  if (!header) return result;
  const map = headerMap(header.fields, PERSON_HEADER_ALIASES);
  if (!map.has("fullName")) {
    result.errors.push({
      line: header.line,
      message: "The CSV needs a full_name column (full_name, person_name, or name).",
    });
    return result;
  }

  for (const record of records.slice(1)) {
    if (record.fields.every((value) => value.trim() === "")) continue;
    result.totalRows += 1;
    const row: PersonInput = { kind: "person", fullName: cell(record, map.get("fullName")) };
    for (const field of ["company", "jobTitle", "location", "email", "phone", "notes"] as const) {
      const value = cell(record, map.get(field));
      if (value) row[field] = value;
    }
    if (validatePersonRow(row, record.line, result.errors)) result.rows.push(row);
    if (result.errors.length >= MAX_ERRORS) break;
  }

  result.duplicateRows = countDuplicates(result.rows);
  return result;
}

export function parseCompanyPaste(text: string): ImportResult {
  const rows = String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const result: ImportResult = { rows: [], errors: [], duplicateRows: 0, totalRows: rows.length };
  rows.forEach((companyName, index) => {
    const line = index + 1;
    if (!validateCommonText(companyName, "Company name", 200, line, result.errors)) return;
    result.rows.push({ companyName });
  });
  result.duplicateRows = countDuplicates(result.rows);
  return result;
}

export function parsePeoplePaste(text: string): ImportResult {
  const names = String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const result: ImportResult = { rows: [], errors: [], duplicateRows: 0, totalRows: names.length };
  names.forEach((fullName, index) => {
    const line = index + 1;
    if (!validateCommonText(fullName, "Full name", 200, line, result.errors)) return;
    result.rows.push({ kind: "person", fullName });
  });
  result.duplicateRows = countDuplicates(result.rows);
  return result;
}

/** Backwards-compatible name used by the existing company workspace/tests. */
export const parsePaste = parseCompanyPaste;

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula injection (CSV is commonly opened in Excel).
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function rowsToCsv(rows: readonly ResultRow[]): string {
  const headers = [
    "row_number",
    "kind",
    "company_name",
    "full_name",
    "job_title",
    "location",
    "email",
    "phone",
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
    const raw = row.raw;
    const evaluation: Evaluation | null = row.evaluation;
    const selected = evaluation?.candidates.find((candidate) => candidate.canonicalUrl === row.selectedUrl);
    const evidence = selected ? selected.notes.join(" ") : (evaluation?.reasons.join(" ") ?? "");
    const reasons = [...(evaluation?.reasonCodes ?? []), ...(row.error ? [row.error.code] : [])];
    const isPerson = rowKind(raw) === "person";
    lines.push(
      [
        row.rowIndex,
        rowKind(raw),
        isPerson ? "" : (raw as CompanyInput).companyName,
        isPerson ? (raw as PersonInput).fullName : "",
        isPerson ? ((raw as PersonInput).jobTitle ?? "") : "",
        isPerson ? ((raw as PersonInput).location ?? "") : "",
        isPerson ? ((raw as PersonInput).email ?? "") : "",
        isPerson ? ((raw as PersonInput).phone ?? "") : "",
        rowNormalizedName(raw),
        isPerson ? "" : ((raw as CompanyInput).country ?? ""),
        isPerson ? "" : ((raw as CompanyInput).region ?? ""),
        isPerson ? "" : ((raw as CompanyInput).city ?? ""),
        isPerson ? "" : ((raw as CompanyInput).officialDomain ?? ""),
        isPerson ? "" : ((raw as CompanyInput).officialWebsite ?? ""),
        isPerson ? "" : ((raw as CompanyInput).alias ?? ""),
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
    kind: "company" | "person";
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
      kind: rowKind(row.raw),
      raw: row.raw,
      normalizedName: row.evaluation?.normalizedName ?? rowNormalizedName(row.raw),
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
