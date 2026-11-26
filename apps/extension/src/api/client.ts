import {
  parseSearchResponse,
  SEARCH_SCHEMA_VERSION,
  type ApiLookup,
  type SearchResponse,
} from "@clf/matching";
import { RESOLVER_ENDPOINT, SEARCH_PATH, WHOAMI_PATH } from "../types.js";

export type ResolverErrorKind = "http" | "network" | "timeout" | "invalid_response";

export class ResolverClientError extends Error {
  public readonly kind: ResolverErrorKind;
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly retryAfterSeconds: number | undefined;

  constructor(options: {
    kind: ResolverErrorKind;
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    retryAfterSeconds?: number;
  }) {
    super(options.message);
    this.name = "ResolverClientError";
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export type WhoAmI = {
  ok: boolean;
  service: string;
  version: string;
  provider: string;
  time: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ResolverClientOptions = {
  endpoint?: string;
  getToken: () => Promise<string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  newRequestId?: () => string;
};

const DEFAULT_TIMEOUT_MS = 90_000;

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

/**
 * Thin client for the resolver. It validates the response against the shared
 * schema before the engine sees it and never logs the token or payload.
 */
export class ResolverClient {
  private readonly endpoint: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly newRequestId: () => string;

  constructor(options: ResolverClientOptions) {
    this.endpoint = (options.endpoint ?? RESOLVER_ENDPOINT).replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
  }

  private async request(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const token = (await this.getToken()).trim();
    if (!token) {
      throw new ResolverClientError({
        kind: "http",
        code: "missing_token",
        message: "No access token is configured. Open Settings and save a token.",
        status: 0,
        retryable: false,
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await this.fetchImpl(`${this.endpoint}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-Request-Id": this.newRequestId(),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new ResolverClientError({
          kind: "timeout",
          code: "request_timeout",
          message: "The resolver did not answer in time. Resume the job to retry.",
          status: 0,
          retryable: true,
        });
      }
      throw new ResolverClientError({
        kind: "network",
        code: "network_error",
        message: "The resolver could not be reached. Check the endpoint and connection.",
        status: 0,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpError(response: Response): Promise<ResolverClientError> {
    let code = `http_${response.status}`;
    let message = "The resolver rejected the request.";
    try {
      const payload = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      if (payload.error) {
        if (typeof payload.error.code === "string" && payload.error.code.length > 0)
          code = payload.error.code;
        if (typeof payload.error.message === "string" && payload.error.message.length > 0) {
          message = payload.error.message;
        }
      }
    } catch {
      // Keep the safe generic message.
    }

    if (response.status === 401 || response.status === 403) {
      return new ResolverClientError({
        kind: "http",
        code,
        message: "The resolver rejected the access token. Update it in Settings, then resume.",
        status: response.status,
        retryable: false,
      });
    }
    if (response.status === 429) {
      return new ResolverClientError({
        kind: "http",
        code,
        message: "The resolver rate limit was reached. The job will resume after the cooldown.",
        status: response.status,
        retryable: true,
        retryAfterSeconds: retryAfterSeconds(response) ?? 60,
      });
    }
    return new ResolverClientError({
      kind: "http",
      code,
      message,
      status: response.status,
      retryable: response.status >= 500,
      retryAfterSeconds: retryAfterSeconds(response),
    });
  }

  public async search(lookups: ApiLookup[], idempotencyKey: string): Promise<SearchResponse> {
    const response = await this.request(SEARCH_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: SEARCH_SCHEMA_VERSION, idempotencyKey, lookups }),
    });

    if (!response.ok) throw await this.httpError(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ResolverClientError({
        kind: "invalid_response",
        code: "invalid_response",
        message: "The resolver returned a response that was not valid JSON.",
        status: response.status,
        retryable: true,
      });
    }

    try {
      return parseSearchResponse(payload);
    } catch {
      throw new ResolverClientError({
        kind: "invalid_response",
        code: "invalid_response",
        message: "The resolver response did not match the expected contract.",
        status: response.status,
        retryable: true,
      });
    }
  }

  public async whoami(): Promise<WhoAmI> {
    const response = await this.request(WHOAMI_PATH, { method: "GET" }, 15_000);
    if (!response.ok) throw await this.httpError(response);
    try {
      const payload = (await response.json()) as WhoAmI;
      if (!payload || typeof payload !== "object" || payload.ok !== true) throw new Error("bad payload");
      return payload;
    } catch {
      throw new ResolverClientError({
        kind: "invalid_response",
        code: "invalid_response",
        message: "The resolver did not return a valid identity response.",
        status: response.status,
        retryable: false,
      });
    }
  }
}
