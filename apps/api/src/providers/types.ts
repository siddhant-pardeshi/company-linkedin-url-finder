import type { ProviderErrorCode, QueryShape, RawSearchResult } from "@clf/matching";

export type SearchContext = {
  shape: QueryShape;
  retrievedAt: string;
};

export interface SearchProvider {
  readonly name: string;
  search(query: string, context: SearchContext): Promise<RawSearchResult[]>;
}

/** Provider failures are typed and safe to report; they never contain secrets. */
export class ProviderSearchError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly retryable: boolean;
  public readonly retryAfterMs: number | undefined;

  constructor(code: ProviderErrorCode, message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderSearchError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function isProviderSearchError(error: unknown): error is ProviderSearchError {
  return error instanceof ProviderSearchError;
}
