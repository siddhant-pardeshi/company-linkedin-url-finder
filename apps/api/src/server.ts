import http from "node:http";
import { ApiSchemaError, MAX_API_BODY_BYTES, parseSearchRequest, type SearchResponse } from "@clf/matching";
import { IdempotencyCache } from "./cache.js";
import type { ApiConfig } from "./config.js";
import { hashToken, randomId, safeEqualHex, sha256Hex, stableStringify } from "./crypto.js";
import { createLogger, type Logger, type LogFields } from "./logger.js";
import { BraveSearchProvider } from "./providers/brave.js";
import { MockSearchProvider } from "./providers/mock.js";
import type { SearchProvider } from "./providers/types.js";
import { RateLimiter } from "./rate-limit.js";
import { DEFAULT_RETRY } from "./retry.js";
import { Semaphore } from "./semaphore.js";
import { ResolverError, ResolverService } from "./service.js";

export type ServerOverrides = {
  provider?: SearchProvider;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: Logger;
};

export type ResolverServer = {
  server: http.Server;
  logger: Logger;
  service: ResolverService;
};

function buildProvider(config: ApiConfig): SearchProvider {
  if (config.provider === "mock") return new MockSearchProvider();
  return new BraveSearchProvider({
    apiKey: config.braveApiKey,
    baseUrl: config.braveApiBaseUrl,
    timeoutMs: config.providerTimeoutMs,
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
    ...extraHeaders,
  });
  res.end(payload);
}

function corsHeaders(req: http.IncomingMessage, config: ApiConfig): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function requestIdFrom(req: http.IncomingMessage): string {
  const raw = req.headers["x-request-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && /^[A-Za-z0-9._:-]{1,64}$/.test(value)) return value;
  return randomId();
}

function authenticate(req: http.IncomingMessage, config: ApiConfig): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,512})$/i.exec(header);
  const token = match?.[1];
  if (!token) return null;
  const digest = hashToken(token);
  let valid = false;
  // Compare against every configured digest; comparison itself is constant-time.
  for (const expected of config.accessTokenHashes) {
    valid = safeEqualHex(digest, expected) || valid;
  }
  return valid ? digest : null;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > limit) {
      reject(new ResolverError(413, "payload_too_large", "Request body exceeds the size limit."));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        reject(new ResolverError(413, "payload_too_large", "Request body exceeds the size limit."));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function errorBody(code: string, message: string, retryable: boolean, requestId: string) {
  return { error: { code, message, retryable, requestId } };
}

export function createResolverServer(config: ApiConfig, overrides: ServerOverrides = {}): ResolverServer {
  const logger =
    overrides.logger ??
    createLogger(config.logLevel, (line) => {
      process.stdout.write(`${line}\n`);
    });
  const now = overrides.now ?? (() => new Date());
  const sleep = overrides.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = overrides.random ?? Math.random;
  const provider = overrides.provider ?? buildProvider(config);
  const cache = new IdempotencyCache<SearchResponse>({
    ttlMs: config.cacheTtlMs,
    now: () => now().getTime(),
  });
  const limiter = new RateLimiter({ perMinute: config.rateLimitPerMinute, now: () => now().getTime() });
  const semaphore = new Semaphore(config.providerConcurrency);

  const service = new ResolverService({
    provider,
    cache,
    logger,
    semaphore,
    now,
    sleep,
    random,
    retry: DEFAULT_RETRY,
    batchTimeoutMs: config.batchTimeoutMs,
  });

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const requestId = requestIdFrom(req);
    res.setHeader("X-Request-Id", requestId);
    const url = new URL(req.url ?? "/", "http://resolver.local");
    const cors = corsHeaders(req, config);
    const log = (fields: LogFields): void => {
      logger.info("request_completed", {
        requestId,
        route: url.pathname,
        durationMs: Date.now() - started,
        ...fields,
      });
    };

    const handle = async (): Promise<void> => {
      if (url.pathname === "/healthz" && req.method === "GET") {
        writeJson(
          res,
          200,
          {
            ok: true,
            service: "company-page-finder-resolver",
            version: config.version,
            provider: config.provider,
            time: now().toISOString(),
          },
          cors,
        );
        log({ status: 200 });
        return;
      }

      if (url.pathname === "/v1/whoami") {
        if (req.method !== "GET") {
          writeJson(res, 405, errorBody("method_not_allowed", "Use GET for /v1/whoami.", false, requestId), {
            ...cors,
            Allow: "GET",
          });
          log({ status: 405 });
          return;
        }
        const tokenHash = authenticate(req, config);
        if (!tokenHash) {
          writeJson(
            res,
            401,
            errorBody("unauthorized", "A valid resolver access token is required.", false, requestId),
            {
              ...cors,
              "WWW-Authenticate": 'Bearer realm="company-page-finder"',
            },
          );
          log({ status: 401 });
          return;
        }
        writeJson(
          res,
          200,
          {
            ok: true,
            service: "company-page-finder-resolver",
            version: config.version,
            provider: config.provider,
            time: now().toISOString(),
          },
          cors,
        );
        log({ status: 200 });
        return;
      }

      if (url.pathname === "/v1/search") {
        if (req.method === "OPTIONS") {
          res.writeHead(204, { ...SECURITY_HEADERS, ...cors });
          res.end();
          log({ status: 204 });
          return;
        }
        if (req.method !== "POST") {
          writeJson(res, 405, errorBody("method_not_allowed", "Use POST for /v1/search.", false, requestId), {
            ...cors,
            Allow: "POST, OPTIONS",
          });
          log({ status: 405 });
          return;
        }

        const tokenHash = authenticate(req, config);
        if (!tokenHash) {
          writeJson(
            res,
            401,
            errorBody("unauthorized", "A valid resolver access token is required.", false, requestId),
            {
              ...cors,
              "WWW-Authenticate": 'Bearer realm="company-page-finder"',
            },
          );
          log({ status: 401 });
          return;
        }

        const limit = limiter.take(tokenHash);
        if (!limit.allowed) {
          const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
          writeJson(
            res,
            429,
            errorBody("rate_limited", "Too many requests. Retry after the indicated delay.", true, requestId),
            { ...cors, "Retry-After": String(retryAfter) },
          );
          log({ status: 429 });
          return;
        }

        const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.startsWith("application/json")) {
          writeJson(
            res,
            415,
            errorBody("unsupported_media_type", "Content-Type must be application/json.", false, requestId),
            cors,
          );
          log({ status: 415 });
          return;
        }

        const body = await readBody(req, MAX_API_BODY_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(body) as unknown;
        } catch {
          throw new ResolverError(400, "invalid_request", "The request body is not valid JSON.");
        }
        const request = parseSearchRequest(payload);
        const fingerprint = sha256Hex(stableStringify(request.lookups));
        const response = await service.resolve(request, fingerprint);
        writeJson(res, 200, response, cors);
        log({ status: 200, lookups: request.lookups.length });
        return;
      }

      writeJson(res, 404, errorBody("not_found", "Route not found.", false, requestId), cors);
      log({ status: 404 });
    };

    void handle().catch((error: unknown) => {
      if (error instanceof ResolverError) {
        const headers: Record<string, string> = { ...cors };
        if (error.retryAfterSeconds !== undefined) headers["Retry-After"] = String(error.retryAfterSeconds);
        if (error.status === 413) headers["Connection"] = "close";
        if (res.headersSent) {
          res.end();
          return;
        }
        writeJson(
          res,
          error.status,
          errorBody(error.code, error.message, error.retryable, requestId),
          headers,
        );
        log({ status: error.status });
        return;
      }
      if (error instanceof ApiSchemaError) {
        if (res.headersSent) {
          res.end();
          return;
        }
        writeJson(res, 400, {
          ...errorBody(
            "invalid_request",
            "The request did not match the resolver contract.",
            false,
            requestId,
          ),
          details: error.issues.slice(0, 5),
        });
        log({ status: 400 });
        return;
      }
      logger.error("request_failed", {
        requestId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      if (!res.headersSent) {
        writeJson(
          res,
          500,
          errorBody("internal_error", "The resolver failed to process the request.", true, requestId),
        );
      } else {
        res.end();
      }
      log({ status: 500 });
    });
  });

  server.requestTimeout = 90_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return { server, logger, service };
}
