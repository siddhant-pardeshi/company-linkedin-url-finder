import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { hashToken } from "../src/crypto.js";

const TOKEN = "config-token-0123456789";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RESOLVER_ACCESS_TOKENS: TOKEN,
    SEARCH_PROVIDER: "mock",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads a safe mock development configuration", () => {
    const config = loadConfig(env());
    expect(config.provider).toBe("mock");
    expect(config.port).toBe(8787);
    expect(config.host).toBe("127.0.0.1");
    expect(config.accessTokenHashes).toEqual([hashToken(TOKEN)]);
    expect(config.rateLimitPerMinute).toBe(30);
    expect(config.cacheTtlMs).toBe(15 * 60 * 1000);
    expect(config.batchTimeoutMs).toBe(50_000);
  });

  it("requires at least one strong access token", () => {
    expect(() => loadConfig({ SEARCH_PROVIDER: "mock" })).toThrow(ConfigError);
    expect(() => loadConfig(env({ RESOLVER_ACCESS_TOKENS: "short" }))).toThrow(/at least 16/);
    expect(() => loadConfig(env({ RESOLVER_ACCESS_TOKENS: "token with spaces 1234" }))).toThrow(/whitespace/);
  });

  it("requires a Brave key for the Brave provider", () => {
    expect(() => loadConfig(env({ SEARCH_PROVIDER: "brave" }))).toThrow(/BRAVE_API_KEY/);
    const config = loadConfig(env({ SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "secret" }));
    expect(config.provider).toBe("brave");
  });

  it("refuses the mock provider in production", () => {
    expect(() => loadConfig(env({ NODE_ENV: "production" }))).toThrow(/must not run/);
  });

  it("rejects bad provider, log level, and numeric bounds", () => {
    expect(() => loadConfig(env({ SEARCH_PROVIDER: "bing" }))).toThrow(/SEARCH_PROVIDER/);
    expect(() => loadConfig(env({ LOG_LEVEL: "verbose" }))).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig(env({ PORT: "70000" }))).toThrow(/PORT/);
    expect(() => loadConfig(env({ RATE_LIMIT_PER_MINUTE: "0" }))).toThrow(/RATE_LIMIT/);
    expect(() => loadConfig(env({ CACHE_TTL_MS: "-1" }))).toThrow(/CACHE_TTL_MS/);
    expect(() => loadConfig(env({ PROVIDER_CONCURRENCY: "9" }))).toThrow(/PROVIDER_CONCURRENCY/);
  });

  it("validates the CORS allowlist", () => {
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: "*" }))).toThrow(/ALLOWED_ORIGINS/);
    const config = loadConfig(
      env({
        ALLOWED_ORIGINS: "https://app.example.com,chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    expect(config.allowedOrigins).toHaveLength(2);
  });

  it("does not include the raw token in the configuration", () => {
    const config = loadConfig(env());
    expect(JSON.stringify(config)).not.toContain(TOKEN);
  });
});
