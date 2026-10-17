// The auto-review circuit breaker (FR-085, docs/12 §6.1, docs/09 §12): 3 consecutive reviewer
// denials, or 10 denials in the last 50 reviews, of one run (or of a thread that belongs to no
// run) interrupt it. A trip starts the count over, so a run the user resumes is judged afresh.

export const BREAKER_CONSECUTIVE = 3;
export const BREAKER_WINDOW = 50;
export const BREAKER_WINDOW_DENIALS = 10;
/** Runs and threads tracked at once; the least recently reviewed are forgotten first. */
const MAX_KEYS = 1000;

export interface BreakerTrip {
  consecutiveDenials: number;
  recentDenials: number;
  window: number;
}

interface BreakerState {
  consecutive: number;
  /** The last reviews, oldest first: true for a denial. */
  recent: boolean[];
}

export class ReviewBreaker {
  readonly #state = new Map<string, BreakerState>();

  /** Record one review of `key` (a run id, else a thread id); returns the trip, if it tripped. */
  record(key: string, denied: boolean): BreakerTrip | null {
    const s = this.#state.get(key) ?? { consecutive: 0, recent: [] };
    // Re-inserting keeps the map in least-recently-reviewed order for eviction.
    this.#state.delete(key);
    s.consecutive = denied ? s.consecutive + 1 : 0;
    s.recent.push(denied);
    if (s.recent.length > BREAKER_WINDOW) s.recent.shift();
    const recentDenials = s.recent.filter(Boolean).length;
    if (s.consecutive >= BREAKER_CONSECUTIVE || recentDenials >= BREAKER_WINDOW_DENIALS)
      return { consecutiveDenials: s.consecutive, recentDenials, window: BREAKER_WINDOW };
    this.#state.set(key, s);
    if (this.#state.size > MAX_KEYS) {
      const oldest = this.#state.keys().next().value;
      if (oldest !== undefined) this.#state.delete(oldest);
    }
    return null;
  }

  /** Forget a run's or thread's reviews (the user resumed it, or it ended). */
  reset(key: string): void {
    this.#state.delete(key);
  }

  /** How many runs and threads are tracked (diagnostics). */
  get size(): number {
    return this.#state.size;
  }
}
