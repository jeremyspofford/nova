// A small in-memory sliding-window limiter for the public enrollment routes (ported from Era 1,
// 6e2cf142 packages/core/src/pairing/limiter.ts): per client address, so a flood of guesses or
// polls from one place is refused before it reaches the database. Bounded in memory.

export interface SlidingWindowLimiterOptions {
  // Requests allowed per key within `windowMs`.
  limit: number;
  windowMs: number;
  // Keys remembered at most (the oldest are dropped first). Default 10,000.
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

  // Counts one request for `key`; false when it is over the limit (the request is not counted).
  take(key: string): boolean {
    const now = this.#now();
    const since = now - this.windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > since);
    if (hits.length >= this.limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    // Re-inserted so the map's order is least recently used first.
    this.#hits.delete(key);
    this.#hits.set(key, hits);
    while (this.#hits.size > this.#maxKeys) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
    return true;
  }

  // Forgets every key (tests).
  clear(): void {
    this.#hits.clear();
  }

  get size(): number {
    return this.#hits.size;
  }
}

// At most one report per key every `everyMs`: a problem raised by what another machine sends (a
// paired device that may be compromised, a client of the public routes) is raised once, then held
// back and counted, however often it is sent. The key is what the sender can't vary (its
// authenticated device, or its address, and the kind of report), never text it chose. A key is kept
// while it holds back the next report or has a count to give; at most `maxKeys` (the oldest go
// first), so a flood of keys can't grow it without end.
export interface ReportThrottleOptions {
  everyMs: number;
  // Keys remembered at most. Default 1,000.
  maxKeys?: number;
  now?: () => number;
}

export class ReportThrottle {
  readonly everyMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #last = new Map<string, { at: number; held: number }>();

  constructor(opts: ReportThrottleOptions) {
    this.everyMs = opts.everyMs;
    this.#maxKeys = opts.maxKeys ?? 1_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  // null while a report for `key` was made within the window (this one is counted as held back);
  // otherwise the report is due, and this is how many were held back since the last one.
  due(key: string): number | null {
    const now = this.#now();
    const last = this.#last.get(key);
    if (last && now - last.at < this.everyMs) {
      last.held++;
      return null;
    }
    this.#last.delete(key);
    for (const [k, v] of this.#last) if (!v.held && now - v.at >= this.everyMs) this.#last.delete(k);
    this.#last.set(key, { at: now, held: 0 });
    while (this.#last.size > this.#maxKeys) {
      const oldest = this.#last.keys().next().value;
      if (oldest === undefined) break;
      this.#last.delete(oldest);
    }
    return last?.held ?? 0;
  }

  get size(): number {
    return this.#last.size;
  }
}
