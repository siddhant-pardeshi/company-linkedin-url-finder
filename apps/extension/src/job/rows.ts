import {
  computeLookupKeyFor,
  normalizeCompanyName,
  normalizePersonName,
  type ApiLookup,
} from "@clf/matching";
import type { RawRow, RowKind } from "../types.js";

export function rowKind(row: RawRow): RowKind {
  return row.kind === "person" ? "person" : "company";
}

export function rowDisplayName(row: RawRow): string {
  return row.kind === "person" ? row.fullName : row.companyName;
}

export function rowNormalizedName(row: RawRow): string {
  return row.kind === "person"
    ? normalizePersonName(row.fullName).core
    : normalizeCompanyName(row.companyName).core;
}

export function rowSubtitle(row: RawRow): string {
  if (row.kind === "person") return "";
  return row.alias ? `Alias: ${row.alias}` : "";
}

export function rowContextLines(row: RawRow): string[] {
  if (row.kind === "person") {
    const lines = [row.company ?? "", row.jobTitle ?? "", row.location ?? ""].filter(Boolean);
    return [...new Set(lines)];
  }
  const location = [row.city, row.region, row.country].filter(Boolean).join(", ");
  return [location, row.officialDomain ?? ""].filter(Boolean);
}

export function rowSearchBlob(row: RawRow): string {
  if (row.kind === "person") {
    return [row.fullName, row.company, row.jobTitle, row.location, row.email, row.phone, row.notes]
      .filter(Boolean)
      .join(" \n ");
  }
  return [row.companyName, row.country, row.region, row.city, row.officialDomain, row.alias, row.notes]
    .filter(Boolean)
    .join(" \n ");
}

export function rowLookupKey(row: RawRow): string {
  return computeLookupKeyFor(row);
}

export function rowApiLookup(row: RawRow, id: string): ApiLookup {
  return { ...row, id };
}
