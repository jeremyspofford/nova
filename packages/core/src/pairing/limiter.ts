// A small in-memory sliding-window limiter for the public Add Device routes (docs/22 §9.3): per
// client address, so a flood of guesses or polls from one place is refused with 429 before it
// reaches the database. The Hub had no shared limiter; this one is bounded in memory.

export interface SlidingWindowLimiterOptions {
  /** Requests allowed per key within `windowMs`. */
  limit: number;
  windowMs: number;
  /** Keys remembered at most (the oldest are dropped first). Default 10,000. */
  maxKeys?: number;
  now?: () => number;
}

export class SlidingWindowLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(opts: SlidingWindowLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.#maxKeys = opts.maxKeys ?? 10_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Count one request for `key`; false when it is over the limit (the request is not counted). */
  take(key: string): boolean {
    const now = this.#now();
    const since = now - this.windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > since);
    if (hits.length >= this.limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    // Re-insert so the map's order is least recently used first.
    this.#hits.delete(key);
    this.#hits.set(key, hits);
    while (this.#hits.size > this.#maxKeys) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
    return true;
  }

  /** Forget every key (tests). */
  clear(): void {
    this.#hits.clear();
  }

  get size(): number {
    return this.#hits.size;
  }
}
