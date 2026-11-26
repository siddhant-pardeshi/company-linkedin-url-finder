import { hashToken } from "./crypto.js";

export type ProviderName = "brave" | "mock";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type ApiConfig = {
  env: "development" | "production" | "test";
  port: number;
  host: string;
  provider: ProviderName;
  braveApiKey: string;
  braveApiBaseUrl: string;
  accessTokenHashes: string[];
  allowedOrigins: string[];
  cacheTtlMs: number;
  rateLimitPerMinute: number;
  providerConcurrency: number;
  providerTimeoutMs: number;
  batchTimeoutMs: number;
  logLevel: LogLevel;
  version: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const VERSION = "1.0.0";

function readString(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? "").trim();
}

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = readString(env, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigError(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

function readProvider(env: NodeJS.ProcessEnv): ProviderName {
  const value = (readString(env, "SEARCH_PROVIDER") || "brave").toLowerCase();
  if (value !== "brave" && value !== "mock") {
    throw new ConfigError("SEARCH_PROVIDER must be 'brave' or 'mock'");
  }
  return value;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const value = (readString(env, "LOG_LEVEL") || "info").toLowerCase();
  if (value !== "debug" && value !== "info" && value !== "warn" && value !== "error") {
    throw new ConfigError("LOG_LEVEL must be debug, info, warn, or error");
  }
  return value;
}

function readOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = readString(env, "ALLOWED_ORIGINS");
  if (!raw) return [];
  const origins = raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  for (const origin of origins) {
    if (
      !/^(https:\/\/[a-z0-9.-]+(:\d+)?|chrome-extension:\/\/[a-p]{32}|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(
        origin,
      )
    ) {
      throw new ConfigError(
        `ALLOWED_ORIGINS contains an unsupported origin: ${origin}. Use https origins, a chrome-extension origin, or http://localhost.`,
      );
    }
  }
  return origins;
}

function readTokens(env: NodeJS.ProcessEnv): string[] {
  const raw = readString(env, "RESOLVER_ACCESS_TOKENS");
  if (!raw) {
    throw new ConfigError("RESOLVER_ACCESS_TOKENS is required. Set at least one strong access token.");
  }
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) throw new ConfigError("RESOLVER_ACCESS_TOKENS must contain at least one token");
  for (const token of tokens) {
    if (token.length < 16) throw new ConfigError("Each resolver access token must be at least 16 characters");
    if (/\s/.test(token)) throw new ConfigError("Resolver access tokens must not contain whitespace");
  }
  return tokens.map(hashToken);
}

/**
 * Load and validate configuration. Secrets are read only from the environment,
 * never from the extension, source tree, or request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const provider = readProvider(env);
  const braveApiKey = readString(env, "BRAVE_API_KEY");
  if (provider === "brave" && !braveApiKey) {
    throw new ConfigError(
      "BRAVE_API_KEY is required when SEARCH_PROVIDER=brave. For offline development use SEARCH_PROVIDER=mock.",
    );
  }
  const environment = (readString(env, "NODE_ENV") || "development").toLowerCase();
  const normalizedEnv =
    environment === "production" ? "production" : environment === "test" ? "test" : "development";

  const config: ApiConfig = {
    env: normalizedEnv,
    port: readInt(env, "PORT", 8787, { min: 1, max: 65535 }),
    host: readString(env, "HOST") || "127.0.0.1",
    provider,
    braveApiKey,
    braveApiBaseUrl:
      readString(env, "BRAVE_API_BASE_URL") || "https://api.search.brave.com/res/v1/web/search",
    accessTokenHashes: readTokens(env),
    allowedOrigins: readOrigins(env),
    cacheTtlMs: readInt(env, "CACHE_TTL_MS", 15 * 60 * 1000, { min: 0, max: 24 * 60 * 60 * 1000 }),
    rateLimitPerMinute: readInt(env, "RATE_LIMIT_PER_MINUTE", 30, { min: 1, max: 600 }),
    providerConcurrency: readInt(env, "PROVIDER_CONCURRENCY", 2, { min: 1, max: 6 }),
    providerTimeoutMs: readInt(env, "PROVIDER_TIMEOUT_MS", 8000, { min: 1000, max: 30000 }),
    batchTimeoutMs: readInt(env, "BATCH_TIMEOUT_MS", 50000, { min: 5000, max: 120000 }),
    logLevel: readLogLevel(env),
    version: VERSION,
  };

  if (config.provider === "mock" && config.env === "production") {
    throw new ConfigError(
      "SEARCH_PROVIDER=mock is a local development/demo provider and must not run with NODE_ENV=production.",
    );
  }

  return config;
}
