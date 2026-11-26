import {
  assertSelectedUrlWasDiscovered,
  computeLookupKey,
  evaluateLookup,
  MAX_COMPANY_NAME_LENGTH,
  type ApiLookup,
  type AuditAction,
  type Evaluation,
  type RowStatus,
  type SearchResponse,
} from "@clf/matching";
import { hasUsableToken } from "../settings.js";
import type { Repository } from "../storage/repository.js";
import {
  MAX_BATCH_SIZE,
  MAX_ROWS_PER_JOB,
  type AppSettings,
  type AuditRecord,
  type Job,
  type JobSnapshot,
  type LookupRecord,
  type PauseReason,
  type RawRow,
  type ResultRow,
  type RowError,
} from "../types.js";
import { sha256Hex } from "./hash.js";
import { computeStats } from "./stats.js";

export type EngineClient = {
  search: (lookups: ApiLookup[], idempotencyKey: string) => Promise<SearchResponse>;
};

export type EngineDeps = {
  repository: Repository;
  client: EngineClient;
  getSettings: () => Promise<AppSettings>;
  now?: () => Date;
  newId?: () => string;
  hash?: (value: string) => Promise<string>;
  logger?: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export class EngineError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

type ClientFailure = {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  kind: "http" | "network" | "timeout" | "invalid_response";
  retryAfterSeconds?: number;
};

type ApplyOutcome = {
  pause: {
    reason: PauseReason;
    message: string;
    code: string;
    retryable: boolean;
    cooldownSeconds?: number;
  } | null;
};

const DEFAULT_BATCH_SIZE = 5;

function clampBatchSize(value: number | undefined, fallback: number): number {
  const candidate = Number.isInteger(value) ? (value as number) : fallback;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, candidate));
}

function cleanOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeRawRow(input: RawRow): RawRow {
  const companyName = String(input.companyName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!companyName) throw new EngineError("invalid_rows", "Every row needs a company name.");
  if (companyName.length > MAX_COMPANY_NAME_LENGTH) {
    throw new EngineError(
      "invalid_rows",
      `Company names must be at most ${MAX_COMPANY_NAME_LENGTH} characters.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(companyName)) {
    throw new EngineError("invalid_rows", "Company names must not contain control characters.");
  }
  const row: RawRow = { companyName };
  const country = cleanOptional(input.country, 120);
  const region = cleanOptional(input.region, 120);
  const city = cleanOptional(input.city, 120);
  const officialDomain = cleanOptional(input.officialDomain, 253);
  const officialWebsite = cleanOptional(input.officialWebsite, 400);
  const alias = cleanOptional(input.alias, 120);
  const notes = cleanOptional(input.notes, 500);
  if (country) row.country = country;
  if (region) row.region = region;
  if (city) row.city = city;
  if (officialDomain) row.officialDomain = officialDomain;
  if (officialWebsite) row.officialWebsite = officialWebsite;
  if (alias) row.alias = alias;
  if (notes) row.notes = notes;
  return row;
}

function makeRowError(
  code: string,
  message: string,
  retryable: boolean,
  at: string,
  retryAfterSeconds?: number,
): RowError {
  const error: RowError = { code, message, retryable, at };
  if (retryAfterSeconds !== undefined) error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return error;
}

function errorRow(row: ResultRow, error: RowError, at: string): ResultRow {
  return {
    ...row,
    status: "ERROR",
    selectedUrl: null,
    confidence: "none",
    evaluation: null,
    checkedAt: null,
    error,
    confirmedBy: null,
    updatedAt: at,
  };
}

function resetRow(row: ResultRow, at: string): ResultRow {
  return {
    ...row,
    status: "PENDING",
    selectedUrl: null,
    confidence: "none",
    evaluation: null,
    checkedAt: null,
    error: null,
    confirmedBy: null,
    rejectedCandidates: [],
    updatedAt: at,
  };
}

function applyEvaluation(row: ResultRow, evaluation: Evaluation, provider: string, at: string): ResultRow {
  let status: RowStatus = evaluation.status;
  let selectedUrl = evaluation.status === "MATCHED" ? evaluation.selectedUrl : null;
  if (selectedUrl && row.rejectedCandidates.includes(selectedUrl)) {
    status = "REVIEW_REQUIRED";
    selectedUrl = null;
  }
  return {
    ...row,
    status,
    selectedUrl,
    confidence: evaluation.confidence,
    evaluation,
    provider,
    checkedAt: at,
    error: null,
    confirmedBy: null,
    updatedAt: at,
  };
}

function asClientFailure(error: unknown): ClientFailure | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record["code"] !== "string") return null;
  const kind = record["kind"];
  const status = typeof record["status"] === "number" ? record["status"] : 0;
  const retryAfter = record["retryAfterSeconds"];
  const result: ClientFailure = {
    code: record["code"],
    message: typeof record["message"] === "string" ? record["message"] : "The lookup failed.",
    status,
    retryable: record["retryable"] === true,
    kind:
      kind === "network" || kind === "timeout" || kind === "invalid_response" || kind === "http"
        ? kind
        : "http",
  };
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) result.retryAfterSeconds = retryAfter;
  return result;
}

/**
 * Durable, checkpointed job engine. It owns all job state in the repository and
 * is safe to recreate at any time, which is the basis for MV3 resume behavior.
 *
 * The engine never chooses a URL. It only stores the deterministic evaluation
 * returned by the pure matching package and applies human decisions.
 */
export class JobEngine {
  private readonly repository: Repository;
  private readonly client: EngineClient;
  private readonly getSettings: () => Promise<AppSettings>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly hash: (value: string) => Promise<string>;
  private readonly logger: (event: string, fields?: Record<string, string | number | boolean>) => void;
  private readonly active = new Set<string>();

  constructor(deps: EngineDeps) {
    this.repository = deps.repository;
    this.client = deps.client;
    this.getSettings = deps.getSettings;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.hash = deps.hash ?? sha256Hex;
    this.logger = deps.logger ?? (() => undefined);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async actorName(): Promise<string> {
    try {
      const settings = await this.getSettings();
      return settings.operatorName || "Local user";
    } catch {
      return "Local user";
    }
  }

  private async audit(
    jobId: string,
    action: AuditAction,
    detail: string,
    actor: string,
    rowId?: string,
  ): Promise<void> {
    const entry: AuditRecord = {
      id: this.newId(),
      jobId,
      action,
      actor,
      at: this.nowIso(),
      detail,
    };
    if (rowId !== undefined) entry.rowId = rowId;
    await this.repository.putAudit(entry);
  }

  private async requireJob(jobId: string): Promise<Job> {
    const job = await this.repository.getJob(jobId);
    if (!job) throw new EngineError("job_not_found", "That job no longer exists in this browser.");
    return job;
  }

  public async createJob(
    rawRows: readonly RawRow[],
    options: { batchSize?: number; operatorName?: string } = {},
  ): Promise<Job> {
    if (rawRows.length === 0) throw new EngineError("invalid_rows", "Add at least one company name.");
    if (rawRows.length > MAX_ROWS_PER_JOB) {
      throw new EngineError("invalid_rows", `A batch can contain at most ${MAX_ROWS_PER_JOB} rows.`);
    }
    const settings = await this.getSettings();
    const batchSize = clampBatchSize(options.batchSize, settings.batchSize || DEFAULT_BATCH_SIZE);
    const operatorName = (options.operatorName ?? settings.operatorName ?? "Local user").slice(0, 60);
    const now = this.nowIso();
    const jobId = this.newId();

    const rows: ResultRow[] = [];
    const lookupInputs = new Map<string, RawRow>();
    rawRows.forEach((input, index) => {
      const raw = normalizeRawRow(input);
      const lookupKey = computeLookupKey(raw);
      if (!lookupInputs.has(lookupKey)) lookupInputs.set(lookupKey, raw);
      rows.push({
        id: `${jobId}:${index + 1}`,
        jobId,
        rowIndex: index + 1,
        raw,
        lookupKey,
        status: "PENDING",
        selectedUrl: null,
        confidence: "none",
        evaluation: null,
        provider: null,
        checkedAt: null,
        error: null,
        confirmedBy: null,
        rejectedCandidates: [],
        updatedAt: now,
      });
    });

    const job: Job = {
      id: jobId,
      createdAt: now,
      updatedAt: now,
      state: "running",
      totalRows: rows.length,
      totalLookups: lookupInputs.size,
      batchSize,
      operatorName,
      pauseReason: null,
      lastError: null,
      cooldownUntil: null,
      startedAt: now,
      finishedAt: null,
    };

    const lookups: LookupRecord[] = [...lookupInputs.entries()].map(([lookupKey, input]) => ({
      key: `${jobId}|${lookupKey}`,
      jobId,
      lookupKey,
      input,
      status: "PENDING",
      queries: [],
      evaluation: null,
      provider: null,
      checkedAt: null,
      error: null,
      updatedAt: now,
    }));

    await this.repository.putJob(job);
    await this.repository.putLookups(lookups);
    await this.repository.putRows(rows);
    await this.audit(
      jobId,
      "job_created",
      `${rows.length} row(s) queued; ${lookups.length} unique lookup(s).`,
      operatorName,
    );
    this.logger("job_created", { rows: rows.length, lookups: lookups.length, batchSize });
    return job;
  }

  public async run(jobId: string): Promise<void> {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    try {
      let job = await this.repository.getJob(jobId);
      if (!job || job.state !== "running") return;
      await this.recoverInterrupted(jobId);

      for (;;) {
        job = await this.repository.getJob(jobId);
        if (!job || job.state !== "running") return;
        if (job.cooldownUntil && Date.parse(job.cooldownUntil) > this.now().getTime()) return;

        const pending = await this.repository.getLookupsByStatus(jobId, ["PENDING"], job.batchSize);
        if (pending.length === 0) {
          await this.finishJob(jobId);
          return;
        }

        const settings = await this.getSettings();
        if (!hasUsableToken(settings)) {
          await this.pauseJob(
            jobId,
            "missing_token",
            "No access token is configured. Open Settings, save a token, then resume.",
            { code: "missing_token", retryable: false, actor: "System" },
          );
          return;
        }

        const nowIso = this.nowIso();
        const keys = pending.map((lookup) => lookup.lookupKey);
        await this.repository.putLookups(
          pending.map((lookup) => ({ ...lookup, status: "IN_PROGRESS" as const, updatedAt: nowIso })),
        );
        const batchRows = await this.repository.getRowsByLookupKeys(jobId, keys);
        await this.repository.putRows(
          batchRows.map((row) => ({
            ...row,
            status: "IN_PROGRESS" as RowStatus,
            error: null,
            updatedAt: nowIso,
          })),
        );

        const requestLookups: ApiLookup[] = pending.map((lookup, index) => ({
          ...lookup.input,
          id: `l${index}`,
        }));
        const idempotencyKey = await this.hash(
          `${job.id}:${[...keys].sort((a, b) => a.localeCompare(b)).join("|")}`,
        );

        let response: SearchResponse;
        try {
          response = await this.client.search(requestLookups, idempotencyKey);
        } catch (error) {
          const failure = asClientFailure(error) ?? {
            code: "network_error",
            message: "The resolver could not be reached.",
            status: 0,
            retryable: true,
            kind: "network" as const,
          };
          await this.handleClientFailure(jobId, pending, failure);
          return;
        }

        const outcome = await this.applyResponse(jobId, pending, response);
        if (outcome.pause) {
          await this.pauseJob(jobId, outcome.pause.reason, outcome.pause.message, {
            code: outcome.pause.code,
            retryable: outcome.pause.retryable,
            ...(outcome.pause.cooldownSeconds !== undefined
              ? { cooldownSeconds: outcome.pause.cooldownSeconds }
              : {}),
            actor: "System",
          });
          return;
        }
        await this.touchJob(jobId);
      }
    } finally {
      this.active.delete(jobId);
    }
  }

  private async recoverInterrupted(jobId: string): Promise<void> {
    const interrupted = await this.repository.getLookupsByStatus(jobId, ["IN_PROGRESS"], 100_000);
    if (interrupted.length > 0) {
      const now = this.nowIso();
      await this.repository.putLookups(
        interrupted.map((lookup) => ({ ...lookup, status: "PENDING" as const, updatedAt: now })),
      );
    }
    const rows = await this.repository.getRows(jobId);
    const stuck = rows.filter((row) => row.status === "IN_PROGRESS");
    if (stuck.length > 0) {
      const now = this.nowIso();
      await this.repository.putRows(
        stuck.map((row) => ({ ...row, status: "PENDING" as RowStatus, updatedAt: now })),
      );
    }
  }

  private async touchJob(jobId: string): Promise<void> {
    const job = await this.repository.getJob(jobId);
    if (!job) return;
    await this.repository.putJob({ ...job, updatedAt: this.nowIso() });
  }

  private async finishJob(jobId: string): Promise<void> {
    const job = await this.repository.getJob(jobId);
    if (!job || job.state !== "running") return;
    const stillPending = await this.repository.getLookupsByStatus(jobId, ["PENDING", "IN_PROGRESS"], 1);
    if (stillPending.length > 0) return;
    const now = this.nowIso();
    const rows = await this.repository.getRows(jobId);
    const stats = computeStats(rows);
    await this.repository.putJob({
      ...job,
      state: "completed",
      pauseReason: null,
      cooldownUntil: null,
      finishedAt: now,
      updatedAt: now,
    });
    await this.audit(
      jobId,
      "job_completed",
      `${stats.MATCHED} matched, ${stats.REVIEW_REQUIRED} review, ${stats.NOT_FOUND} not found, ${stats.ERROR} error.`,
      "System",
    );
    this.logger("job_completed", { rows: stats.total });
  }

  private async pauseJob(
    jobId: string,
    reason: PauseReason,
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      cooldownSeconds?: number;
      actor?: string;
    } = {},
  ): Promise<void> {
    const now = this.nowIso();
    const cooldownUntil =
      options.cooldownSeconds !== undefined
        ? new Date(this.now().getTime() + Math.max(1, options.cooldownSeconds) * 1000).toISOString()
        : null;
    const current = await this.repository.getJob(jobId);
    if (!current || current.state === "cancelled" || current.state === "completed") return;
    if (current.state === "paused" && current.pauseReason === "user" && reason !== "user") return;

    const updated: Job = {
      ...current,
      state: "paused",
      pauseReason: reason,
      lastError: {
        code: options.code ?? reason,
        message,
        retryable: options.retryable ?? false,
        at: now,
      },
      cooldownUntil,
      updatedAt: now,
    };
    await this.repository.putJob(updated);
    await this.audit(jobId, "job_paused", `${reason}: ${message}`, options.actor ?? "System");
  }

  private async handleClientFailure(
    jobId: string,
    pending: readonly LookupRecord[],
    failure: ClientFailure,
  ): Promise<void> {
    const keys = pending.map((lookup) => lookup.lookupKey);
    const rows = await this.repository.getRowsByLookupKeys(jobId, keys);
    const now = this.nowIso();
    const error = makeRowError(
      failure.code,
      failure.message,
      failure.retryable,
      now,
      failure.retryAfterSeconds,
    );

    const authFailure = failure.status === 401 || failure.status === 403;
    const rateLimited = failure.status === 429;
    const transient = failure.kind === "network" || failure.kind === "timeout" || failure.status >= 500;

    if (authFailure || rateLimited) {
      // Keep the batch queued so a resume can pick it up without losing rows.
      await this.repository.putLookups(
        pending.map((lookup) => ({
          ...lookup,
          status: "PENDING" as const,
          error,
          updatedAt: now,
        })),
      );
      await this.repository.putRows(
        rows.map((row) => ({
          ...row,
          status: "PENDING" as RowStatus,
          selectedUrl: null,
          evaluation: null,
          error,
          updatedAt: now,
        })),
      );
      if (authFailure) {
        await this.pauseJob(
          jobId,
          "auth",
          "The resolver rejected the access token. Update it in Settings, then resume.",
          { code: failure.code, retryable: false, actor: "System" },
        );
      } else {
        await this.pauseJob(
          jobId,
          "rate_limit",
          "The search provider rate limit was reached. The job will resume automatically after the cooldown.",
          {
            code: failure.code,
            retryable: true,
            cooldownSeconds: failure.retryAfterSeconds ?? 60,
            actor: "System",
          },
        );
      }
      return;
    }

    if (transient) {
      await this.repository.putLookups(
        pending.map((lookup) => ({ ...lookup, status: "ERROR" as const, error, updatedAt: now })),
      );
      await this.repository.putRows(rows.map((row) => errorRow(row, error, now)));
      await this.pauseJob(
        jobId,
        "network",
        "The resolver could not be reached. Check your connection, then resume; failed rows can be retried.",
        { code: failure.code, retryable: true, actor: "System" },
      );
      return;
    }

    await this.repository.putLookups(
      pending.map((lookup) => ({ ...lookup, status: "ERROR" as const, error, updatedAt: now })),
    );
    await this.repository.putRows(rows.map((row) => errorRow(row, error, now)));
    await this.pauseJob(
      jobId,
      "request_error",
      "The resolver rejected the batch request. Check the endpoint, build, and access token.",
      { code: failure.code, retryable: false, actor: "System" },
    );
  }

  private async applyResponse(
    jobId: string,
    pending: readonly LookupRecord[],
    response: SearchResponse,
  ): Promise<ApplyOutcome> {
    const byId = new Map(response.results.map((result) => [result.id, result] as const));
    const keys = pending.map((lookup) => lookup.lookupKey);
    const rows = await this.repository.getRowsByLookupKeys(jobId, keys);
    const rowsByKey = new Map<string, ResultRow[]>();
    for (const row of rows) {
      const list = rowsByKey.get(row.lookupKey);
      if (list) list.push(row);
      else rowsByKey.set(row.lookupKey, [row]);
    }

    const now = this.nowIso();
    let pause: ApplyOutcome["pause"] = null;
    const updatedLookups: LookupRecord[] = [];
    const updatedRows: ResultRow[] = [];

    pending.forEach((lookup, index) => {
      const keyRows = rowsByKey.get(lookup.lookupKey) ?? [];
      const result = byId.get(`l${index}`);
      if (!result) {
        const error = makeRowError(
          "invalid_response",
          "The resolver response did not include this lookup. Retry the row.",
          true,
          now,
        );
        updatedLookups.push({
          ...lookup,
          status: "ERROR",
          error,
          updatedAt: now,
        });
        updatedRows.push(...keyRows.map((row) => errorRow(row, error, now)));
        return;
      }

      if (result.errors.length > 0) {
        const first = result.errors[0];
        if (!first) return;
        const error = makeRowError(first.code, first.message, first.retryable, now, first.retryAfterSeconds);
        const globalReason: PauseReason | null =
          first.code === "provider_rate_limited"
            ? "rate_limit"
            : first.code === "provider_auth_failed" || first.code === "provider_not_configured"
              ? "auth"
              : null;

        if (globalReason) {
          updatedLookups.push({
            ...lookup,
            status: "PENDING",
            queries: result.queries.length > 0 ? result.queries : lookup.queries,
            error,
            updatedAt: now,
          });
          updatedRows.push(
            ...keyRows.map((row) => ({
              ...row,
              status: "PENDING" as RowStatus,
              selectedUrl: null,
              evaluation: null,
              checkedAt: null,
              confirmedBy: null,
              error,
              updatedAt: now,
            })),
          );
          pause ??= {
            reason: globalReason,
            message:
              globalReason === "rate_limit"
                ? "The search provider rate limit was reached. The job will resume automatically after the cooldown."
                : "The resolver is not authorized with the search provider. The operator must check the server credential.",
            code: first.code,
            retryable: first.retryable,
            cooldownSeconds: globalReason === "rate_limit" ? (first.retryAfterSeconds ?? 60) : undefined,
          };
        } else {
          updatedLookups.push({
            ...lookup,
            status: "ERROR",
            queries: result.queries.length > 0 ? result.queries : lookup.queries,
            error,
            updatedAt: now,
          });
          updatedRows.push(...keyRows.map((row) => errorRow(row, error, now)));
        }
        return;
      }

      try {
        const evaluation = evaluateLookup(lookup.input, result.results, {
          provider: response.provider,
          checkedAt: now,
        });
        assertSelectedUrlWasDiscovered(evaluation);
        updatedLookups.push({
          ...lookup,
          status: "RESOLVED",
          queries: result.queries.length > 0 ? result.queries : lookup.queries,
          evaluation,
          provider: response.provider,
          checkedAt: now,
          error: null,
          updatedAt: now,
        });
        updatedRows.push(...keyRows.map((row) => applyEvaluation(row, evaluation, response.provider, now)));
      } catch (error) {
        const rowError = makeRowError(
          "evaluation_failed",
          "The evidence check failed safely; no URL was selected. Retry the row.",
          true,
          now,
        );
        updatedLookups.push({
          ...lookup,
          status: "ERROR",
          queries: result.queries.length > 0 ? result.queries : lookup.queries,
          error: rowError,
          updatedAt: now,
        });
        updatedRows.push(...keyRows.map((row) => errorRow(row, rowError, now)));
        this.logger("evaluation_failed", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    });

    // Rows first, lookups second: a crash in between leaves the lookup
    // IN_PROGRESS, which recovery re-queues; no row can be left unprocessed.
    await this.repository.putRows(updatedRows);
    await this.repository.putLookups(updatedLookups);
    return { pause };
  }

  public async pause(jobId: string): Promise<Job> {
    const job = await this.requireJob(jobId);
    if (job.state !== "running") return job;
    const now = this.nowIso();
    const actor = await this.actorName();
    const updated: Job = {
      ...job,
      state: "paused",
      pauseReason: "user",
      cooldownUntil: null,
      updatedAt: now,
    };
    await this.repository.putJob(updated);
    await this.audit(jobId, "job_paused", "Paused by the user.", actor);
    return updated;
  }

  public async resume(jobId: string): Promise<Job> {
    const job = await this.requireJob(jobId);
    if (job.state === "cancelled") {
      throw new EngineError("cancelled", "This job was cancelled. Start a new batch instead.");
    }
    if (job.state === "running") return job;
    return this.resumeInternal(jobId, await this.actorName(), "Resumed by the user.");
  }

  private async resumeInternal(jobId: string, actor: string, detail: string): Promise<Job> {
    const job = await this.requireJob(jobId);
    const now = this.nowIso();
    const updated: Job = {
      ...job,
      state: "running",
      pauseReason: null,
      lastError: null,
      cooldownUntil: null,
      finishedAt: null,
      startedAt: job.startedAt ?? now,
      updatedAt: now,
    };
    await this.repository.putJob(updated);
    await this.audit(jobId, "job_resumed", detail, actor);
    return updated;
  }

  public async autoResumeIfReady(jobId: string): Promise<boolean> {
    const job = await this.repository.getJob(jobId);
    if (!job || job.state !== "paused") return false;
    if (job.pauseReason !== "rate_limit") return false;
    if (job.cooldownUntil && Date.parse(job.cooldownUntil) > this.now().getTime()) return false;
    await this.resumeInternal(jobId, "System", "Automatic resume after the provider cooldown.");
    await this.run(jobId);
    return true;
  }

  public async cancel(jobId: string): Promise<Job> {
    const job = await this.requireJob(jobId);
    if (job.state === "cancelled") return job;
    const now = this.nowIso();
    const actor = await this.actorName();
    const updated: Job = {
      ...job,
      state: "cancelled",
      pauseReason: null,
      cooldownUntil: null,
      finishedAt: now,
      updatedAt: now,
    };
    await this.repository.putJob(updated);
    await this.audit(jobId, "job_cancelled", "Cancelled by the user.", actor);
    return updated;
  }

  public async retryFailed(jobId: string): Promise<number> {
    const rows = await this.repository.getRows(jobId);
    const failed = rows.filter((row) => row.status === "ERROR").map((row) => row.id);
    if (failed.length === 0) return 0;
    return this.retryRows(jobId, failed);
  }

  public async retryRows(jobId: string, rowIds: readonly string[]): Promise<number> {
    const job = await this.requireJob(jobId);
    if (job.state === "cancelled") {
      throw new EngineError("cancelled", "This job was cancelled. Start a new batch instead.");
    }
    const ids = new Set(rowIds);
    const rows = await this.repository.getRows(jobId);
    const targets = rows.filter((row) => ids.has(row.id));
    if (targets.length === 0) {
      throw new EngineError("no_rows_selected", "Select at least one row to retry.");
    }
    const keys = new Set(targets.map((row) => row.lookupKey));
    const affected = rows.filter((row) => keys.has(row.lookupKey));
    const now = this.nowIso();
    await this.repository.putRows(affected.map((row) => resetRow(row, now)));

    const lookups: LookupRecord[] = [];
    for (const key of keys) {
      const lookup = await this.repository.getLookup(jobId, key);
      if (lookup)
        lookups.push({ ...lookup, status: "PENDING", evaluation: null, error: null, updatedAt: now });
    }
    await this.repository.putLookups(lookups);

    const running: Job = {
      ...job,
      state: "running",
      pauseReason: null,
      lastError: null,
      cooldownUntil: null,
      finishedAt: null,
      startedAt: job.startedAt ?? now,
      updatedAt: now,
    };
    await this.repository.putJob(running);
    await this.audit(
      jobId,
      "rows_retried",
      `${targets.length} row(s) re-queued across ${keys.size} lookup(s).`,
      await this.actorName(),
    );
    return targets.length;
  }

  public async acceptCandidate(jobId: string, rowId: string, canonicalUrl: string): Promise<ResultRow> {
    const row = await this.repository.getRow(rowId);
    if (!row || row.jobId !== jobId) throw new EngineError("row_not_found", "That row no longer exists.");
    if (row.status === "IN_PROGRESS") {
      throw new EngineError("row_in_progress", "Wait for the current lookup to finish before confirming.");
    }
    const candidate = row.evaluation?.candidates.find((entry) => entry.canonicalUrl === canonicalUrl);
    if (!candidate) {
      throw new EngineError("candidate_not_found", "That candidate was not returned by the search provider.");
    }
    const actor = await this.actorName();
    const now = this.nowIso();
    const updated: ResultRow = {
      ...row,
      status: "USER_CONFIRMED",
      selectedUrl: candidate.canonicalUrl,
      confidence: row.evaluation?.confidence ?? "low",
      confirmedBy: { actor, at: now, canonicalUrl: candidate.canonicalUrl },
      rejectedCandidates: row.rejectedCandidates.filter((url) => url !== candidate.canonicalUrl),
      error: null,
      updatedAt: now,
    };
    await this.repository.putRows([updated]);
    await this.audit(
      jobId,
      "candidate_accepted",
      `Human-confirmed ${candidate.canonicalUrl} (candidate verdict: ${candidate.verdict}).`,
      actor,
      rowId,
    );
    return updated;
  }

  public async rejectCandidate(jobId: string, rowId: string, canonicalUrl: string): Promise<ResultRow> {
    const row = await this.repository.getRow(rowId);
    if (!row || row.jobId !== jobId) throw new EngineError("row_not_found", "That row no longer exists.");
    const candidate = row.evaluation?.candidates.find((entry) => entry.canonicalUrl === canonicalUrl);
    if (!candidate) {
      throw new EngineError("candidate_not_found", "That candidate was not returned by the search provider.");
    }
    const actor = await this.actorName();
    const now = this.nowIso();
    const rejected = row.rejectedCandidates.includes(canonicalUrl)
      ? row.rejectedCandidates
      : [...row.rejectedCandidates, canonicalUrl];
    const clearedSelection = row.selectedUrl === canonicalUrl;
    const updated: ResultRow = {
      ...row,
      status: clearedSelection ? "REVIEW_REQUIRED" : row.status,
      selectedUrl: clearedSelection ? null : row.selectedUrl,
      confirmedBy: clearedSelection ? null : row.confirmedBy,
      rejectedCandidates: rejected,
      updatedAt: now,
    };
    await this.repository.putRows([updated]);
    await this.audit(
      jobId,
      "candidate_rejected",
      `Rejected ${candidate.canonicalUrl}${clearedSelection ? "; the selected URL was cleared." : "."}`,
      actor,
      rowId,
    );
    return updated;
  }

  public async updateRowContext(jobId: string, rowId: string, context: Partial<RawRow>): Promise<ResultRow> {
    const job = await this.requireJob(jobId);
    if (job.state === "cancelled") {
      throw new EngineError("cancelled", "This job was cancelled. Start a new batch instead.");
    }
    const row = await this.repository.getRow(rowId);
    if (!row || row.jobId !== jobId) throw new EngineError("row_not_found", "That row no longer exists.");
    if (row.status === "IN_PROGRESS") {
      throw new EngineError("row_in_progress", "Wait for the current lookup to finish before editing.");
    }

    const merged: RawRow = { ...row.raw };
    const fields: Array<[keyof RawRow, number]> = [
      ["country", 120],
      ["region", 120],
      ["city", 120],
      ["officialDomain", 253],
      ["officialWebsite", 400],
      ["alias", 120],
      ["notes", 500],
    ];
    for (const [field, max] of fields) {
      if (!(field in context)) continue;
      const value = cleanOptional(context[field], max);
      if (value) merged[field] = value;
      else delete merged[field];
    }

    const now = this.nowIso();
    const newKey = computeLookupKey(merged);
    let updatedRow: ResultRow;

    if (newKey === row.lookupKey) {
      const affected = await this.repository.getRowsByLookupKeys(jobId, [newKey]);
      await this.repository.putRows(
        affected.map((entry) => resetRow({ ...entry, raw: entry.id === row.id ? merged : entry.raw }, now)),
      );
      const lookup = await this.repository.getLookup(jobId, newKey);
      if (lookup) {
        await this.repository.putLookups([
          { ...lookup, input: merged, status: "PENDING", evaluation: null, error: null, updatedAt: now },
        ]);
      } else {
        await this.repository.putLookups([
          {
            key: `${jobId}|${newKey}`,
            jobId,
            lookupKey: newKey,
            input: merged,
            status: "PENDING",
            queries: [],
            evaluation: null,
            provider: null,
            checkedAt: null,
            error: null,
            updatedAt: now,
          },
        ]);
      }
      updatedRow = resetRow({ ...row, raw: merged }, now);
    } else {
      const existing = await this.repository.getLookup(jobId, newKey);
      const movedRow: ResultRow = {
        ...row,
        raw: merged,
        lookupKey: newKey,
        rejectedCandidates: [],
        updatedAt: now,
      };
      if (existing) {
        updatedRow =
          existing.status === "RESOLVED" && existing.evaluation
            ? applyEvaluation(movedRow, existing.evaluation, existing.provider ?? "", now)
            : existing.status === "ERROR" && existing.error
              ? errorRow(movedRow, existing.error, now)
              : resetRow(movedRow, now);
      } else {
        const lookup: LookupRecord = {
          key: `${jobId}|${newKey}`,
          jobId,
          lookupKey: newKey,
          input: merged,
          status: "PENDING",
          queries: [],
          evaluation: null,
          provider: null,
          checkedAt: null,
          error: null,
          updatedAt: now,
        };
        await this.repository.putLookups([lookup]);
        updatedRow = resetRow(movedRow, now);
      }
      await this.repository.putRows([updatedRow]);
      const remaining = await this.repository.getRowsByLookupKeys(jobId, [row.lookupKey]);
      if (remaining.length === 0) await this.repository.deleteLookup(jobId, row.lookupKey);
    }

    await this.repository.putJob({
      ...job,
      state: "running",
      pauseReason: null,
      lastError: null,
      cooldownUntil: null,
      finishedAt: null,
      startedAt: job.startedAt ?? now,
      updatedAt: now,
    });
    await this.audit(
      jobId,
      "row_context_updated",
      "Disambiguation context updated; the lookup was re-queued.",
      await this.actorName(),
      rowId,
    );
    return updatedRow;
  }

  public async latestSnapshot(): Promise<JobSnapshot | null> {
    const job = await this.repository.getLatestJob();
    if (!job) return null;
    return this.snapshot(job.id);
  }

  public async snapshot(jobId: string): Promise<JobSnapshot | null> {
    const job = await this.repository.getJob(jobId);
    if (!job) return null;
    const rows = await this.repository.getRows(jobId);
    return { job, stats: computeStats(rows) };
  }

  public async listRows(jobId: string): Promise<ResultRow[]> {
    return this.repository.getRows(jobId);
  }

  public async listAudit(jobId: string, rowId?: string): Promise<AuditRecord[]> {
    return this.repository.listAudit(jobId, rowId);
  }

  public async clearJob(jobId: string): Promise<void> {
    await this.repository.deleteJob(jobId);
  }

  public async clearAll(): Promise<void> {
    await this.repository.clearAll();
  }

  public async cleanup(retentionDays?: number): Promise<number> {
    const settings = await this.getSettings();
    const days = retentionDays ?? settings.retentionDays;
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const latest = await this.repository.getLatestJob();
    if (latest && latest.createdAt < cutoff && (latest.state === "running" || latest.state === "paused")) {
      return 0;
    }
    return this.repository.deleteJobsOlderThan(cutoff);
  }
}
