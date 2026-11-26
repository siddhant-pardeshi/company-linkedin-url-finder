import { ROW_STATUSES, type RowStatus } from "@clf/matching";
import type { RowCounts, ResultRow } from "../types.js";

export function emptyCounts(): RowCounts {
  const counts = { total: 0 } as RowCounts;
  for (const status of ROW_STATUSES) counts[status] = 0;
  return counts;
}

export function computeStats(rows: readonly ResultRow[]): RowCounts {
  const counts = emptyCounts();
  counts.total = rows.length;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export function isTerminalStatus(status: RowStatus): boolean {
  return status !== "PENDING" && status !== "IN_PROGRESS";
}

export function processedRows(stats: RowCounts): number {
  return stats.total - stats.PENDING - stats.IN_PROGRESS;
}

export function progressPercent(stats: RowCounts): number {
  if (stats.total === 0) return 0;
  return Math.min(100, Math.round((processedRows(stats) / stats.total) * 100));
}
