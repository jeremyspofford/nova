// Requests held while the Hub is not verified yet (FR-128, docs/21 §9): a window opened during an
// offline start may ask the Hub for things before the statement check has passed. Each request
// waits until the Hub is verified (then it goes out) or fails: when the check fails, after
// `timeoutMs`, or at once when `limit` requests are already waiting. Nothing reaches an
// unverified Hub.

export type HoldOutcome =
  | { allow: true }
  | { allow: false; reason: 'timeout' | 'full' | 'unreachable' | 'refused' | 'closed' };

interface Held {
  release(outcome: HoldOutcome): void;
  timer: NodeJS.Timeout;
}

export class RequestHold {
  readonly #limit: number;
  readonly #timeoutMs: number;
  readonly #onHold: () => void;
  readonly #onDenied: (count: number, reason: string) => void;
  #held: Held[] = [];

  constructor(
    opts: {
      limit?: number;
      timeoutMs?: number;
      /** A request started waiting: a good moment to check the Hub. */
      onHold?: () => void;
      /** Requests failed (to say so once, not per request). */
      onDenied?: (count: number, reason: string) => void;
    } = {},
  ) {
    this.#limit = opts.limit ?? 64;
    this.#timeoutMs = opts.timeoutMs ?? 8000;
    this.#onHold = opts.onHold ?? (() => undefined);
    this.#onDenied = opts.onDenied ?? (() => undefined);
  }

  get size(): number {
    return this.#held.length;
  }

  hold(release: (outcome: HoldOutcome) => void): void {
    if (this.#held.length >= this.#limit) {
      this.#onDenied(1, 'full');
      release({ allow: false, reason: 'full' });
      return;
    }
    const entry: Held = {
      release,
      timer: setTimeout(() => {
        this.#held = this.#held.filter((h) => h !== entry);
        this.#onDenied(1, 'timeout');
        release({ allow: false, reason: 'timeout' });
      }, this.#timeoutMs),
    };
    this.#held.push(entry);
    this.#onHold();
  }

  #releaseAll(outcome: HoldOutcome): void {
    const all = this.#held;
    this.#held = [];
    for (const h of all) clearTimeout(h.timer);
    if (!outcome.allow && all.length > 0) this.#onDenied(all.length, outcome.reason);
    for (const h of all) h.release(outcome);
  }

  /** The Hub is verified: every waiting request goes out. */
  open(): void {
    this.#releaseAll({ allow: true });
  }

  /** The check failed (or the shell is closing): every waiting request fails. */
  fail(reason: 'unreachable' | 'refused' | 'closed'): void {
    this.#releaseAll({ allow: false, reason });
  }
}
