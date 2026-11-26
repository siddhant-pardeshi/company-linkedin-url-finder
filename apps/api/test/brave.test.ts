import { describe, expect, it, vi } from "vitest";
import { braveSuccessBody, braveMalformedBody, FIXTURE_TIME } from "@clf/fixtures";
import { BraveSearchProvider } from "../src/providers/brave.js";
import { ProviderSearchError, type FetchLike } from "../src/providers/types.js";

const BASE = "https://api.search.brave.com/res/v1/web/search";
const CONTEXT = { shape: "primary" as const, retrievedAt: FIXTURE_TIME };

function provider(fetchImpl: FetchLike, timeoutMs = 500): BraveSearchProvider {
  return new BraveSearchProvider({
    apiKey: "secret-brave-key-123",
    baseUrl: BASE,
    timeoutMs,
    fetchImpl,
  });
}

describe("BraveSearchProvider", () => {
  it("calls the documented endpoint with the subscription header and parses results", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify(braveSuccessBody), { status: 200 });
    };

    const results = await provider(fetchImpl).search('site:linkedin.com/company/ "Microsoft"', CONTEXT);
    const url = new URL(seenUrl);
    expect(url.origin + url.pathname).toBe(BASE);
    expect(url.searchParams.get("q")).toBe('site:linkedin.com/company/ "Microsoft"');
    expect(url.searchParams.get("count")).toBe("10");
    expect(url.searchParams.get("safesearch")).toBe("strict");
    expect(seenInit?.headers).toMatchObject({ "X-Subscription-Token": "secret-brave-key-123" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      originalUrl: "https://www.linkedin.com/company/microsoft/",
      title: "Microsoft | LinkedIn",
      provider: "brave",
      query: 'site:linkedin.com/company/ "Microsoft"',
      shape: "primary",
    });
  });

  it("treats a missing web block as an empty result set", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ type: "search" }), { status: 200 });
    await expect(provider(fetchImpl).search("q", CONTEXT)).resolves.toEqual([]);
  });

  it("rejects a malformed results payload", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify(braveMalformedBody), { status: 200 });
    await expect(provider(fetchImpl).search("q", CONTEXT)).rejects.toMatchObject({
      code: "provider_bad_response",
      retryable: false,
    });
  });

  it("rejects invalid JSON", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>oops</html>", { status: 200 });
    await expect(provider(fetchImpl).search("q", CONTEXT)).rejects.toMatchObject({
      code: "provider_bad_response",
    });
  });

  it("maps 401 and 403 to a non-retryable auth failure without leaking the key", async () => {
    for (const status of [401, 403]) {
      const fetchImpl: FetchLike = async () => new Response("{}", { status });
      const error = await provider(fetchImpl)
        .search("q", CONTEXT)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderSearchError);
      expect(error).toMatchObject({ code: "provider_auth_failed", retryable: false });
      expect(String((error as Error).message)).not.toContain("secret-brave-key");
    }
  });

  it("maps 429 to a retryable rate limit and honours Retry-After", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
    await expect(provider(fetchImpl).search("q", CONTEXT)).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it("maps 5xx to a retryable provider outage", async () => {
    const fetchImpl: FetchLike = async () => new Response("{}", { status: 503 });
    await expect(provider(fetchImpl).search("q", CONTEXT)).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("maps other 4xx responses to a non-retryable bad response", async () => {
    const fetchImpl: FetchLike = async () => new Response("{}", { status: 422 });
    await expect(provider(fetchImpl).search("q", CONTEXT)).rejects.toMatchObject({
      code: "provider_bad_response",
      retryable: false,
    });
  });

  it("aborts and reports a timeout", async () => {
    vi.useRealTimers();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    await expect(provider(fetchImpl, 10).search("q", CONTEXT)).rejects.toMatchObject({
      code: "provider_timeout",
      retryable: true,
    });
  });

  it("maps network failures to a retryable outage", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(provider(fetchImpl).search("q", CONTEXT)).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("skips entries without a usable URL or title", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "No URL" },
              { url: "https://www.linkedin.com/company/ok/", title: "Ok | LinkedIn" },
              { url: "https://www.linkedin.com/company/empty-title/", title: "   " },
            ],
          },
        }),
        { status: 200 },
      );
    const results = await provider(fetchImpl).search("q", CONTEXT);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Ok | LinkedIn");
  });
});
