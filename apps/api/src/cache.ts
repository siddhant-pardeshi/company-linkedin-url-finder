export type CacheRead<T> = { kind: "miss" } | { kind: "hit"; value: T } | { kind: "conflict" };

type Entry<T> = {
  fingerprint: string;
  value: T;
  expiresAt: number;
};

/**
 * Small TTL idempotency cache.
 *
 * An idempotency key is bound to a request fingerprint: replaying the same key
 * with a different payload is a conflict, not a cache hit. Responses that carry
 * retryable failures are not stored, so a retry can still succeed.
 */
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs: number; maxEntries?: number; now?: () => number }) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? (() => Date.now());
  }

  public get(key: string, fingerprint: string): CacheRead<T> {
    if (this.ttlMs <= 0) return { kind: "miss" };
    const entry = this.entries.get(key);
    if (!entry) return { kind: "miss" };
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return { kind: "miss" };
    }
    if (entry.fingerprint !== fingerprint) return { kind: "conflict" };
    return { kind: "hit", value: entry.value };
  }

  public set(key: string, fingerprint: string, value: T): void {
    if (this.ttlMs <= 0) return;
    this.entries.set(key, { fingerprint, value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  public get size(): number {
    return this.entries.size;
  }

  public clear(): void {
    this.entries.clear();
  }
}
