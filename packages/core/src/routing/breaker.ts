// Circuit breaker per provider account or compute node (docs/07 §9): open after N consecutive
// failures, allow one half-open probe after a cooldown, close on success. Only availability
// failures count; a provider that answers with a request error is up.

export interface BreakerOptions {
  /** Consecutive failures that open the circuit (default 3). */
  threshold: number;
  /** Time an open circuit waits before one probe is let through (default 30 s). */
  cooldownMs: number;
  now: () => number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

interface Entry {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

export class CircuitBreaker {
  readonly #opts: BreakerOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: Partial<BreakerOptions> = {}) {
    this.#opts = {
      threshold: opts.threshold ?? 3,
      cooldownMs: opts.cooldownMs ?? 30_000,
      now: opts.now ?? Date.now,
    };
  }

  state(key: string): BreakerState {
    const e = this.#entries.get(key);
    if (!e || e.openedAt === null) return 'closed';
    return this.#opts.now() - e.openedAt >= this.#opts.cooldownMs ? 'half_open' : 'open';
  }

  /**
   * Whether a request may go to `key` now. In the half-open state only one probe is let
   * through; the caller must then report `success`, `failure` or `release`.
   */
  tryAcquire(key: string): boolean {
    const e = this.#entries.get(key);
    if (!e || e.openedAt === null) return true;
    if (this.#opts.now() - e.openedAt < this.#opts.cooldownMs) return false;
    if (e.probing) return false;
    e.probing = true;
    return true;
  }

  success(key: string): void {
    this.#entries.delete(key);
  }

  failure(key: string): void {
    const e = this.#entries.get(key) ?? { failures: 0, openedAt: null, probing: false };
    this.#entries.set(key, e);
    if (e.probing) {
      // The half-open probe failed: open again for a full cooldown.
      e.probing = false;
      e.openedAt = this.#opts.now();
      return;
    }
    e.failures++;
    if (e.failures >= this.#opts.threshold && e.openedAt === null) e.openedAt = this.#opts.now();
  }

  /** A request ended without a verdict (cancelled): free the half-open probe slot. */
  release(key: string): void {
    const e = this.#entries.get(key);
    if (e) e.probing = false;
  }
}
