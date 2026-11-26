import { describe, expect, it } from "vitest";
import { FIXTURE_TIME } from "@clf/fixtures";
import { ResolverClient, ResolverClientError } from "../src/api/client.js";

const TOKEN = "test-token-0123456789abcdef";
const ENDPOINT = "https://resolver.example.com";

const validResponse = {
  schemaVersion: 1,
  provider: "brave",
  generatedAt: FIXTURE_TIME,
  results: [
    {
      id: "l0",
      queries: [{ query: 'site:linkedin.com/company/ "Microsoft"', shape: "primary", rationale: "test" }],
      results: [
        {
          originalUrl: "https://www.linkedin.com/company/microsoft/",
          title: "Microsoft | LinkedIn",
          snippet: "microsoft.com",
          provider: "brave",
          query: 'site:linkedin.com/company/ "Microsoft"',
          shape: "primary",
          retrievedAt: FIXTURE_TIME,
        },
      ],
      errors: [],
      cached: false,
    },
  ],
};

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, token = TOKEN) {
  return new ResolverClient({
    endpoint: ENDPOINT,
    getToken: async () => token,
    fetchImpl,
    timeoutMs: 500,
    newRequestId: () => "req-1",
  });
}

describe("ResolverClient", () => {
  it("sends the documented request and validates the response", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const instance = client(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify(validResponse), { status: 200 });
    });

    const response = await instance.search([{ id: "l0", companyName: "Microsoft" }], "idem-12345678");
    expect(seenUrl).toBe("https://resolver.example.com/v1/search");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "X-Request-Id": "req-1",
    });
    expect(JSON.parse(String(seenInit?.body))).toMatchObject({
      schemaVersion: 1,
      idempotencyKey: "idem-12345678",
      lookups: [{ id: "l0", companyName: "Microsoft" }],
    });
    expect(response.provider).toBe("brave");
    expect(response.results[0]?.results[0]?.title).toBe("Microsoft | LinkedIn");
  });

  it("refuses to call the network without a token", async () => {
    let calls = 0;
    const instance = client(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }, "");
    await expect(
      instance.search([{ id: "l0", companyName: "Microsoft" }], "idem-12345678"),
    ).rejects.toMatchObject({
      code: "missing_token",
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it("maps 401 to an actionable auth error without exposing the token", async () => {
    const instance = client(async () => new Response("{}", { status: 401 }));
    const error = await instance
      .search([{ id: "l0", companyName: "Acme" }], "idem-12345678")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ResolverClientError);
    expect(error).toMatchObject({ kind: "http", status: 401, retryable: false });
    expect(String((error as Error).message)).toContain("Settings");
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("maps 429 with Retry-After to a retryable cooldown", async () => {
    const instance = client(async () => new Response("{}", { status: 429, headers: { "Retry-After": "7" } }));
    await expect(instance.search([{ id: "l0", companyName: "Acme" }], "idem-12345678")).rejects.toMatchObject(
      {
        status: 429,
        retryable: true,
        retryAfterSeconds: 7,
      },
    );
  });

  it("maps 5xx to a retryable server error", async () => {
    const instance = client(async () => new Response("{}", { status: 503 }));
    await expect(instance.search([{ id: "l0", companyName: "Acme" }], "idem-12345678")).rejects.toMatchObject(
      {
        status: 503,
        retryable: true,
      },
    );
  });

  it("maps network failures and timeouts", async () => {
    const network = client(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(network.search([{ id: "l0", companyName: "Acme" }], "idem-12345678")).rejects.toMatchObject({
      kind: "network",
      retryable: true,
    });

    const timeout = new ResolverClient({
      endpoint: ENDPOINT,
      getToken: async () => TOKEN,
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    await expect(timeout.search([{ id: "l0", companyName: "Acme" }], "idem-12345678")).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
  });

  it("rejects malformed JSON and contract violations as invalid responses", async () => {
    const badJson = client(async () => new Response("<html>", { status: 200 }));
    await expect(badJson.search([{ id: "l0", companyName: "Acme" }], "idem-12345678")).rejects.toMatchObject({
      kind: "invalid_response",
    });

    const badShape = client(
      async () =>
        new Response(
          JSON.stringify({ schemaVersion: 1, provider: "brave", generatedAt: "nope", results: [] }),
          {
            status: 200,
          },
        ),
    );
    await expect(badShape.search([{ id: "l0", companyName: "Acme" }], "idem-12345678")).rejects.toMatchObject(
      {
        kind: "invalid_response",
      },
    );
  });

  it("verifies the resolver identity for settings", async () => {
    const instance = client(async (url) => {
      expect(url).toBe("https://resolver.example.com/v1/whoami");
      return new Response(
        JSON.stringify({
          ok: true,
          service: "company-page-finder-resolver",
          version: "1.0.0",
          provider: "mock",
          time: FIXTURE_TIME,
        }),
        { status: 200 },
      );
    });
    const who = await instance.whoami();
    expect(who.provider).toBe("mock");
  });
});
