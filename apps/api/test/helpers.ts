import type { ApiConfig } from "../src/config.js";
import { hashToken } from "../src/crypto.js";
import { createLogger, type Logger } from "../src/logger.js";
import { createResolverServer, type ServerOverrides } from "../src/server.js";

export const TEST_TOKEN = "test-token-0123456789abcdef";

export function silentLogger(): Logger {
  return createLogger("error", () => undefined);
}

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    provider: "mock",
    braveApiKey: "",
    braveApiBaseUrl: "https://api.search.brave.com/res/v1/web/search",
    accessTokenHashes: [hashToken(TEST_TOKEN)],
    allowedOrigins: [],
    cacheTtlMs: 60_000,
    rateLimitPerMinute: 1000,
    providerConcurrency: 2,
    providerTimeoutMs: 2000,
    batchTimeoutMs: 5000,
    logLevel: "error",
    version: "1.0.0",
    ...overrides,
  };
}

export type TestServer = {
  url: string;
  close: () => Promise<void>;
};

export async function startTestServer(
  config: ApiConfig,
  overrides: ServerOverrides = {},
): Promise<TestServer> {
  const { server } = createResolverServer(config, { logger: silentLogger(), ...overrides });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not obtain a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export async function postJson(
  baseUrl: string,
  body: unknown,
  options: { token?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (options.token !== null) headers["Authorization"] = `Bearer ${options.token ?? TEST_TOKEN}`;
  return fetch(`${baseUrl}/v1/search`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function validRequest(
  lookups: Array<{ id: string; companyName: string }> = [{ id: "r1", companyName: "Microsoft" }],
) {
  return {
    schemaVersion: 1,
    idempotencyKey: `test-${Math.random().toString(16).slice(2)}`,
    lookups,
  };
}
