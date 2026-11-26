export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

type Bucket = { tokens: number; updatedAt: number };

/**
 * Per-token bucket. The bucket refills at the configured per-minute rate and
 * never exceeds its capacity. Deliberately in-memory: this reference deployment
 * expects a single instance, or a shared limiter in front of it.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: { perMinute: number; now?: () => number }) {
    this.capacity = Math.max(1, options.perMinute);
    this.refillPerMs = this.capacity / 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  public take(key: string): RateLimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      this.prune(now);
      return { allowed: true };
    }

    this.buckets.set(key, bucket);
    const needed = 1 - bucket.tokens;
    return { allowed: false, retryAfterMs: Math.max(1000, Math.ceil(needed / this.refillPerMs)) };
  }

  private prune(now: number): void {
    if (this.buckets.size < 1000) return;
    const idleLimit = 60 * 60 * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > idleLimit) this.buckets.delete(key);
    }
  }
}
