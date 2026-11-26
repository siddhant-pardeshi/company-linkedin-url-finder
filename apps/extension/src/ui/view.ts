import { ROW_STATUSES, type RowStatus } from "@clf/matching";
import type { ResultRow } from "../types.js";
import { computeStats, progressPercent } from "../job/stats.js";

export type StatusFilter = "ALL" | "MATCHED" | "REVIEW_REQUIRED" | "NOT_FOUND" | "ERROR" | "PENDING";

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "ALL", label: "All rows" },
  { value: "MATCHED", label: "Matched" },
  { value: "REVIEW_REQUIRED", label: "Review required" },
  { value: "NOT_FOUND", label: "Not found" },
  { value: "ERROR", label: "Errors" },
  { value: "PENDING", label: "Pending" },
];

export type SortKey = "rowIndex" | "company" | "status" | "checkedAt" | "confidence";
export type SortDirection = "asc" | "desc";

const STATUS_RANK: Record<RowStatus, number> = Object.fromEntries(
  ROW_STATUSES.map((status, index) => [status, index]),
) as Record<RowStatus, number>;

const CONFIDENCE_RANK: Record<string, number> = { high: 3, low: 2, none: 1 };

export function matchesStatusFilter(row: ResultRow, filter: StatusFilter): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "MATCHED":
      return row.status === "MATCHED" || row.status === "USER_CONFIRMED";
    case "PENDING":
      return row.status === "PENDING" || row.status === "IN_PROGRESS";
    default:
      return row.status === filter;
  }
}

export function filterRows(rows: readonly ResultRow[], filter: StatusFilter, query: string): ResultRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesStatusFilter(row, filter)) return false;
    if (!needle) return true;
    const haystack = [
      row.raw.companyName,
      row.raw.country ?? "",
      row.raw.region ?? "",
      row.raw.city ?? "",
      row.raw.officialDomain ?? "",
      row.raw.alias ?? "",
      row.selectedUrl ?? "",
      row.error?.message ?? "",
      row.evaluation?.reasons.join(" ") ?? "",
    ]
      .join(" \n ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function sortRows(rows: readonly ResultRow[], key: SortKey, direction: SortDirection): ResultRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let delta = 0;
    switch (key) {
      case "rowIndex":
        delta = a.rowIndex - b.rowIndex;
        break;
      case "company":
        delta = a.raw.companyName.localeCompare(b.raw.companyName, undefined, { sensitivity: "base" });
        break;
      case "status":
        delta = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        break;
      case "checkedAt":
        delta = (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "");
        break;
      case "confidence":
        delta = (CONFIDENCE_RANK[a.confidence] ?? 0) - (CONFIDENCE_RANK[b.confidence] ?? 0);
        break;
    }
    if (delta === 0) delta = a.rowIndex - b.rowIndex;
    return delta * factor;
  });
}

export type Page<T> = {
  items: T[];
  totalPages: number;
  page: number;
  pageSize: number;
  start: number;
  end: number;
};

export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Math.floor(page)), totalPages);
  const offset = (current - 1) * size;
  return {
    items: items.slice(offset, offset + size),
    totalPages,
    page: current,
    pageSize: size,
    start: items.length === 0 ? 0 : offset + 1,
    end: Math.min(items.length, offset + size),
  };
}

export { computeStats, progressPercent };
