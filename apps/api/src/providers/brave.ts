import type { RawSearchResult } from "@clf/matching";
import { ProviderSearchError, type FetchLike, type SearchContext, type SearchProvider } from "./types.js";

/**
 * Brave Web Search adapter.
 *
 * Endpoint and header verified against the official Brave Web Search docs:
 * GET https://api.search.brave.com/res/v1/web/search with X-Subscription-Token.
 * The provider key stays in the server environment only.
 */

export type BraveProviderOptions = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
};

const MAX_RESULTS = 20;
const MAX_SNIPPET_LENGTH = 1000;

export class BraveSearchProvider implements SearchProvider {
  public readonly name = "brave";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: BraveProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  public async search(query: string, context: SearchContext): Promise<RawSearchResult[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", "10");
    url.searchParams.set("safesearch", "strict");
    url.searchParams.set("text_decorations", "false");
    url.searchParams.set("spellcheck", "false");

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": this.apiKey,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new ProviderSearchError("provider_timeout", "The search provider timed out.", true);
      }
      throw new ProviderSearchError(
        "provider_unavailable",
        "The search provider could not be reached.",
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw this.mapHttpError(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderSearchError(
        "provider_bad_response",
        "The search provider returned a response that was not valid JSON.",
        false,
      );
    }

    return this.parseResults(payload, query, context);
  }

  private mapHttpError(response: Response): ProviderSearchError {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (response.status === 401 || response.status === 403) {
      return new ProviderSearchError(
        "provider_auth_failed",
        "The search provider rejected the server credential.",
        false,
      );
    }
    if (response.status === 429) {
      return new ProviderSearchError(
        "provider_rate_limited",
        "The search provider quota or rate limit was reached.",
        true,
        retryAfterMs ?? 30_000,
      );
    }
    if (response.status >= 500) {
      return new ProviderSearchError(
        "provider_unavailable",
        "The search provider is temporarily unavailable.",
        true,
        retryAfterMs,
      );
    }
    return new ProviderSearchError(
      "provider_bad_response",
      `The search provider rejected the request (HTTP ${response.status}).`,
      false,
    );
  }

  private parseResults(payload: unknown, query: string, context: SearchContext): RawSearchResult[] {
    if (typeof payload !== "object" || payload === null) {
      throw new ProviderSearchError(
        "provider_bad_response",
        "The search provider returned an unexpected payload.",
        false,
      );
    }
    const web = (payload as { web?: unknown }).web;
    if (typeof web !== "object" || web === null) {
      // Brave omits `web` for some query types; treat it as an empty result set.
      return [];
    }
    const results = (web as { results?: unknown }).results;
    if (results === undefined) return [];
    if (!Array.isArray(results)) {
      throw new ProviderSearchError(
        "provider_bad_response",
        "The search provider returned malformed results.",
        false,
      );
    }

    const output: RawSearchResult[] = [];
    for (const entry of results.slice(0, MAX_RESULTS)) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const originalUrl = typeof record["url"] === "string" ? record["url"].trim() : "";
      if (!originalUrl) continue;
      const title = typeof record["title"] === "string" ? record["title"].trim().slice(0, 300) : "";
      if (!title) continue;
      const snippet =
        typeof record["description"] === "string"
          ? record["description"].trim().slice(0, MAX_SNIPPET_LENGTH)
          : "";
      output.push({
        originalUrl,
        title,
        snippet,
        provider: this.name,
        query,
        shape: context.shape,
        retrievedAt: context.retrievedAt,
      });
    }
    return output;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15 * 60 * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 15 * 60 * 1000);
  return undefined;
}
