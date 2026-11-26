import { describe, expect, it } from "vitest";
import type { SearchResponse } from "@clf/matching";
import { postJson, startTestServer, TEST_TOKEN, testConfig, validRequest } from "./helpers.js";

describe("resolver HTTP server", () => {
  it("reports health without authentication", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const response = await fetch(`${srv.url}/healthz`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = (await response.json()) as { ok: boolean; provider: string; version: string };
      expect(body).toMatchObject({ ok: true, provider: "mock", version: "1.0.0" });
    } finally {
      await srv.close();
    }
  });

  it("resolves a valid batch and preserves evidence", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const response = await postJson(
        srv.url,
        {
          schemaVersion: 1,
          idempotencyKey: "batch-key-0001",
          lookups: [
            { id: "r1", companyName: "Microsoft", country: "United States", officialDomain: "microsoft.com" },
          ],
        },
        { headers: { "X-Request-Id": "req-123" } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("req-123");
      const body = (await response.json()) as SearchResponse;
      expect(body.provider).toBe("mock");
      expect(body.results[0]?.queries.length).toBeGreaterThan(0);
      expect(body.results[0]?.results[0]?.originalUrl).toContain("linkedin.com/company/");
      expect(body.results[0]?.errors).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("resolves a person batch through the same evidence contract", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const response = await postJson(srv.url, {
        schemaVersion: 1,
        idempotencyKey: "batch-key-person-01",
        lookups: [
          {
            id: "p1",
            kind: "person",
            fullName: "Ada Lovelace",
            company: "Analytical Engines",
            jobTitle: "Mathematician",
            location: "London",
          },
        ],
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchResponse;
      expect(body.results[0]?.queries.some((query) => query.query.includes("site:linkedin.com/in/"))).toBe(
        true,
      );
      expect(body.results[0]?.results[0]?.originalUrl).toContain("linkedin.com/in/ada-lovelace");
      expect(body.results[0]?.errors).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("replays an idempotent request from cache", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const payload = {
        schemaVersion: 1,
        idempotencyKey: "batch-key-0002",
        lookups: [{ id: "r1", companyName: "Microsoft" }],
      };
      const first = (await (await postJson(srv.url, payload)).json()) as SearchResponse;
      const second = (await (await postJson(srv.url, payload)).json()) as SearchResponse;
      expect(first.results[0]?.cached).toBe(false);
      expect(second.results[0]?.cached).toBe(true);
      expect(second.results[0]?.results).toEqual(first.results[0]?.results);
    } finally {
      await srv.close();
    }
  });

  it("rejects idempotency key reuse with a different payload", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const base = {
        schemaVersion: 1,
        idempotencyKey: "batch-key-0003",
        lookups: [{ id: "r1", companyName: "Microsoft" }],
      };
      expect((await postJson(srv.url, base)).status).toBe(200);
      const conflict = await postJson(srv.url, { ...base, lookups: [{ id: "r1", companyName: "Acme" }] });
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as { error: { code: string } };
      expect(body.error.code).toBe("idempotency_conflict");
    } finally {
      await srv.close();
    }
  });

  it("requires a valid bearer token", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const missing = await postJson(srv.url, validRequest(), { token: null });
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toContain("Bearer");

      const wrong = await postJson(srv.url, validRequest(), { token: "wrong-token-0000000000" });
      expect(wrong.status).toBe(401);

      const whoamiUnauthorized = await fetch(`${srv.url}/v1/whoami`);
      expect(whoamiUnauthorized.status).toBe(401);

      const whoami = await fetch(`${srv.url}/v1/whoami`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(whoami.status).toBe(200);
      expect(await whoami.json()).toMatchObject({ ok: true, provider: "mock" });
    } finally {
      await srv.close();
    }
  });

  it("rejects malformed JSON and schema violations with a 400", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const malformed = await postJson(srv.url, "{not json");
      expect(malformed.status).toBe(400);

      const invalid = await postJson(srv.url, {
        schemaVersion: 1,
        idempotencyKey: "k-12345678",
        lookups: [],
      });
      expect(invalid.status).toBe(400);
      const body = (await invalid.json()) as { error: { code: string }; details: string[] };
      expect(body.error.code).toBe("invalid_request");
      expect(Array.isArray(body.details)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("enforces content type and body size limits", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const wrongType = await postJson(srv.url, validRequest(), {
        headers: { "Content-Type": "text/plain" },
      });
      expect(wrongType.status).toBe(415);

      const oversized = await postJson(srv.url, "x".repeat(70 * 1024));
      expect(oversized.status).toBe(413);
    } finally {
      await srv.close();
    }
  });

  it("limits request rates per token", async () => {
    const srv = await startTestServer(testConfig({ rateLimitPerMinute: 1 }));
    try {
      expect((await postJson(srv.url, validRequest())).status).toBe(200);
      const limited = await postJson(srv.url, validRequest());
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
    } finally {
      await srv.close();
    }
  });

  it("supports CORS only for configured origins", async () => {
    const srv = await startTestServer(testConfig({ allowedOrigins: ["https://app.example.com"] }));
    try {
      const preflight = await fetch(`${srv.url}/v1/search`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.com");

      const denied = await fetch(`${srv.url}/v1/search`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" },
      });
      expect(denied.status).toBe(204);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("rejects unsupported methods and unknown routes", async () => {
    const srv = await startTestServer(testConfig());
    try {
      const wrongMethod = await fetch(`${srv.url}/v1/search`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toContain("POST");

      const missing = await fetch(`${srv.url}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});
