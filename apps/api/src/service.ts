import {
  planQueriesFor,
  SEARCH_SCHEMA_VERSION,
  type LookupSearchResult,
  type PlannedQuery,
  type ProviderError,
  type RawSearchResult,
  type SearchRequest,
  type SearchResponse,
} from "@clf/matching";
import type { IdempotencyCache } from "./cache.js";
import type { Logger } from "./logger.js";
import { withRetry, type RetryOptions } from "./retry.js";
import type { Semaphore } from "./semaphore.js";
import { isProviderSearchError, type SearchProvider } from "./providers/types.js";

export type ResolverErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "rate_limited"
  | "idempotency_conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "not_found"
  | "method_not_allowed"
  | "internal_error";

export class ResolverError extends Error {
  public readonly status: number;
  public readonly code: ResolverErrorCode;
  public readonly retryable: boolean;
  public readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: ResolverErrorCode,
    message: string,
    retryable = false,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ResolverError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ResolverServiceOptions = {
  provider: SearchProvider;
  cache: IdempotencyCache<SearchResponse>;
  logger: Logger;
  semaphore: Semaphore;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  retry: Omit<RetryOptions, "sleep" | "random">;
  batchTimeoutMs: number;
};

function toProviderError(error: unknown): ProviderError {
  if (isProviderSearchError(error)) {
    const result: ProviderError = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.retryAfterMs !== undefined) {
      result.retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
    }
    return result;
  }
  return {
    code: "lookup_failed",
    message: "The lookup failed unexpectedly. Retry the row; if it keeps failing, contact the operator.",
    retryable: true,
  };
}

function isGlobalStop(error: ProviderError): boolean {
  return (
    error.code === "provider_rate_limited" ||
    error.code === "provider_auth_failed" ||
    error.code === "provider_not_configured"
  );
}

/**
 * Executes a small, idempotent batch of lookups. It never evaluates matching
 * rules and never chooses a URL: it only plans queries and returns verbatim
 * provider evidence for the extension's deterministic engine.
 */
export class ResolverService {
  private readonly options: ResolverServiceOptions;

  constructor(options: ResolverServiceOptions) {
    this.options = options;
  }

  public async resolve(request: SearchRequest, fingerprint: string): Promise<SearchResponse> {
    const { cache, logger, now } = this.options;
    const cacheRead = cache.get(request.idempotencyKey, fingerprint);
    if (cacheRead.kind === "conflict") {
      throw new ResolverError(
        409,
        "idempotency_conflict",
        "This idempotency key was already used with a different payload.",
      );
    }
    if (cacheRead.kind === "hit") {
      logger.info("batch_cache_hit", { lookups: request.lookups.length });
      return {
        ...cacheRead.value,
        results: cacheRead.value.results.map((result) => ({ ...result, cached: true })),
      };
    }

    const generatedAt = now().toISOString();
    const deadline = now().getTime() + this.options.batchTimeoutMs;
    const results: LookupSearchResult[] = [];
    let stopError: ProviderError | null = null;

    for (const lookup of request.lookups) {
      let queries: PlannedQuery[];
      try {
        queries = planQueriesFor(lookup);
      } catch {
        results.push({
          id: lookup.id,
          queries: [],
          results: [],
          errors: [
            {
              code: "request_invalid",
              message: "The company name could not be turned into a safe search query.",
              retryable: false,
            },
          ],
          cached: false,
        });
        continue;
      }

      if (queries.length === 0) {
        results.push({
          id: lookup.id,
          queries: [],
          results: [],
          errors: [
            {
              code: "request_invalid",
              message: "The company name contains no searchable characters.",
              retryable: false,
            },
          ],
          cached: false,
        });
        continue;
      }

      if (stopError) {
        results.push({ id: lookup.id, queries, results: [], errors: [stopError], cached: false });
        continue;
      }
      if (now().getTime() >= deadline) {
        stopError = {
          code: "provider_timeout",
          message: "The batch reached its time budget. Pause and resume later.",
          retryable: true,
        };
        results.push({ id: lookup.id, queries, results: [], errors: [stopError], cached: false });
        continue;
      }

      const collected: RawSearchResult[] = [];
      const errors: ProviderError[] = [];

      for (const planned of queries) {
        if (now().getTime() >= deadline) {
          stopError = {
            code: "provider_timeout",
            message: "The batch reached its time budget. Pause and resume later.",
            retryable: true,
          };
          errors.push(stopError);
          break;
        }
        try {
          const found = await this.options.semaphore.run(() =>
            withRetry(
              () =>
                this.options.provider.search(planned.query, {
                  shape: planned.shape,
                  retrievedAt: now().toISOString(),
                }),
              {
                ...this.options.retry,
                sleep: this.options.sleep,
                random: this.options.random,
                onRetry: (attempt, delayMs) => {
                  logger.warn("provider_retry", { attempt, delayMs });
                },
              },
            ),
          );
          collected.push(...found);
        } catch (error) {
          const providerError = toProviderError(error);
          errors.push(providerError);
          if (!isProviderSearchError(error)) {
            logger.error("provider_unexpected_error", {
              errorName: error instanceof Error ? error.name : "unknown",
            });
          }
          if (isGlobalStop(providerError)) stopError = providerError;
          break;
        }
      }

      results.push({ id: lookup.id, queries, results: collected, errors, cached: false });
    }

    const response: SearchResponse = {
      schemaVersion: SEARCH_SCHEMA_VERSION,
      provider: this.options.provider.name,
      generatedAt,
      results,
    };

    const hasErrors = results.some((result) => result.errors.length > 0);
    if (!hasErrors) {
      cache.set(request.idempotencyKey, fingerprint, response);
    }
    return response;
  }
}
