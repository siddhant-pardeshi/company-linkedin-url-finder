import { describe, expect, it } from "vitest";
import { IdempotencyCache } from "../src/cache.js";
import { RateLimiter } from "../src/rate-limit.js";
import { withRetry } from "../src/retry.js";
import { Semaphore } from "../src/semaphore.js";
import { ProviderSearchError } from "../src/providers/types.js";

describe("withRetry", () => {
  const base = {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    jitterRatio: 0,
  };

  it("retries transient failures and succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ProviderSearchError("provider_unavailable", "down", true);
        return "ok";
      },
      {
        ...base,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0.5,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderSearchError("provider_auth_failed", "no", false);
        },
        { ...base, sleep: async () => undefined, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ code: "provider_auth_failed" });
    expect(calls).toBe(1);
  });

  it("respects a provider Retry-After delay", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        throw new ProviderSearchError("provider_rate_limited", "slow down", true, 750);
      },
      {
        ...base,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0.5,
      },
    ).catch(() => undefined);
    expect(calls).toBe(3);
    expect(delays.every((delay) => delay >= 750)).toBe(true);
  });

  it("surfaces a long rate limit instead of ignoring it", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderSearchError("provider_rate_limited", "slow down", true, 10_000);
        },
        { ...base, sleep: async () => undefined, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(calls).toBe(1);
  });

  it("caps backoff and applies bounded jitter", async () => {
    const delays: number[] = [];
    await withRetry(
      async () => {
        throw new ProviderSearchError("provider_unavailable", "down", true);
      },
      {
        maxAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 400,
        jitterRatio: 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 1,
      },
    ).catch(() => undefined);
    expect(delays).toEqual([150, 300, 400, 400]);
  });

  it("throws immediately when attempts are exhausted", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderSearchError("provider_timeout", "timeout", true);
        },
        { ...base, maxAttempts: 1, sleep: async () => undefined, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ code: "provider_timeout" });
    expect(calls).toBe(1);
  });
});

describe("RateLimiter", () => {
  it("allows the bucket capacity then demands a refill", () => {
    const clock = 0;
    const limiter = new RateLimiter({ perMinute: 2, now: () => clock });
    expect(limiter.take("token")).toEqual({ allowed: true });
    expect(limiter.take("token")).toEqual({ allowed: true });
    const limited = limiter.take("token");
    expect(limited.allowed).toBe(false);
    if (!limited.allowed) expect(limited.retryAfterMs).toBeGreaterThanOrEqual(1000);
  });

  it("refills over time and isolates keys", () => {
    let clock = 0;
    const limiter = new RateLimiter({ perMinute: 2, now: () => clock });
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
    expect(limiter.take("b").allowed).toBe(true);
    clock = 30_000;
    expect(limiter.take("a").allowed).toBe(true);
  });
});

describe("IdempotencyCache", () => {
  it("returns a hit for the same key and fingerprint", () => {
    const cache = new IdempotencyCache<string>({ ttlMs: 1000, now: () => 0 });
    cache.set("key", "fingerprint", "value");
    expect(cache.get("key", "fingerprint")).toEqual({ kind: "hit", value: "value" });
  });

  it("reports a conflict when a key is reused with another payload", () => {
    const cache = new IdempotencyCache<string>({ ttlMs: 1000, now: () => 0 });
    cache.set("key", "fingerprint-a", "value");
    expect(cache.get("key", "fingerprint-b")).toEqual({ kind: "conflict" });
  });

  it("expires entries and never stores with a zero TTL", () => {
    let clock = 0;
    const cache = new IdempotencyCache<string>({ ttlMs: 1000, now: () => clock });
    cache.set("key", "f", "value");
    clock = 1001;
    expect(cache.get("key", "f")).toEqual({ kind: "miss" });

    const disabled = new IdempotencyCache<string>({ ttlMs: 0, now: () => clock });
    disabled.set("key", "f", "value");
    expect(disabled.get("key", "f")).toEqual({ kind: "miss" });
  });

  it("evicts the oldest entries", () => {
    const cache = new IdempotencyCache<string>({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
    cache.set("a", "f", "1");
    cache.set("b", "f", "2");
    cache.set("c", "f", "3");
    expect(cache.size).toBe(2);
    expect(cache.get("a", "f")).toEqual({ kind: "miss" });
    expect(cache.get("c", "f")).toEqual({ kind: "hit", value: "3" });
  });
});

describe("Semaphore", () => {
  it("limits concurrent work", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
