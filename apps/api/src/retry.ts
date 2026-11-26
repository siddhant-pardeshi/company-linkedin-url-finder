import { isProviderSearchError } from "./providers/types.js";

export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
};

export const DEFAULT_RETRY: Omit<RetryOptions, "sleep" | "random"> = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 4000,
  jitterRatio: 0.25,
};

function retryAfterMs(error: unknown): number | undefined {
  if (isProviderSearchError(error)) return error.retryAfterMs;
  return undefined;
}

export function isRetryableError(error: unknown): boolean {
  return isProviderSearchError(error) && error.retryable;
}

/**
 * Bounded exponential backoff with jitter for transient provider failures.
 * Rate-limit windows longer than `maxDelayMs` are surfaced to the caller
 * instead of being ignored (the job pauses rather than hammering the provider).
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= options.maxAttempts) throw error;

      const serverDelay = retryAfterMs(error);
      if (serverDelay !== undefined && serverDelay > options.maxDelayMs) throw error;

      const exponential = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      const jitter = exponential * options.jitterRatio * (options.random() * 2 - 1);
      const delay = Math.max(
        0,
        Math.min(options.maxDelayMs, Math.max(exponential + jitter, serverDelay ?? 0)),
      );
      options.onRetry?.(attempt, Math.round(delay), error);
      await options.sleep(Math.round(delay));
      attempt += 1;
    }
  }
}
