// Stream ids and the cross-stream replay guard (FR-137, docs/22 §9.9, ADR-094).
//
// A stream id is a side prefix (`c` for client-opened, `h` for Hub-opened) and a base36 counter
// that only grows: max(previous + 1, now in ms × 1024). The receiver accepts a stream it has not
// seen only above a floor that survives restarts (the Hub persists it per client), so a Relay that
// recorded old ciphertext cannot replay a whole old stream after either side restarts; within a
// stream, sequence numbers and the receive window stop replays (session.ts).

export type StreamSide = 'c' | 'h';
const STREAM_ID = /^([ch])([0-9a-z]{1,12})$/;

export function streamCounter(stream: string): { side: StreamSide; counter: number } | null {
  const m = STREAM_ID.exec(stream);
  if (!m) return null;
  const counter = parseInt(m[2]!, 36);
  if (!Number.isSafeInteger(counter) || counter < 1) return null;
  return { side: m[1] as StreamSide, counter };
}

/** Issues this side's stream ids. */
export class StreamIds {
  readonly #side: StreamSide;
  readonly #now: () => number;
  #last: number;

  constructor(side: StreamSide, opts: { now?: () => number; after?: number } = {}) {
    this.#side = side;
    this.#now = opts.now ?? (() => Date.now());
    this.#last = opts.after ?? 0;
  }

  next(): string {
    this.#last = Math.max(this.#last + 1, this.#now() * 1024);
    return `${this.#side}${this.#last.toString(36)}`;
  }

  /** The peer said our counters were stale (our clock went back): continue above its floor. */
  skipPast(counter: number): void {
    if (counter > this.#last) this.#last = counter;
  }
}

export interface StreamGuardOptions {
  /** The highest counter accepted before a restart; only streams above it are new. */
  floor?: number;
  /** Called when the highest accepted counter grows (the Hub stores it). */
  persist?: (hwm: number) => void;
  /** How many recent counters are remembered for out-of-order arrivals (default 4096). */
  recent?: number;
}

/** Accepts each peer-opened stream once. */
export class StreamGuard {
  readonly #side: StreamSide;
  readonly #persist: ((hwm: number) => void) | undefined;
  readonly #max: number;
  #floor: number;
  #hwm: number;
  readonly #seen = new Set<number>();

  constructor(peerSide: StreamSide, opts: StreamGuardOptions = {}) {
    this.#side = peerSide;
    this.#floor = opts.floor ?? 0;
    this.#hwm = this.#floor;
    this.#persist = opts.persist;
    this.#max = opts.recent ?? 4096;
  }

  get hwm(): number {
    return this.#hwm;
  }

  accept(stream: string): boolean {
    const id = streamCounter(stream);
    if (!id || id.side !== this.#side) return false;
    if (id.counter <= this.#floor || this.#seen.has(id.counter)) return false;
    this.#seen.add(id.counter);
    if (id.counter > this.#hwm) {
      this.#hwm = id.counter;
      this.#persist?.(this.#hwm);
    }
    if (this.#seen.size > this.#max * 2) {
      // Forget the oldest half; the floor rises past them so they stay refused.
      const sorted = [...this.#seen].sort((a, b) => a - b);
      for (const c of sorted.slice(0, sorted.length - this.#max)) {
        this.#seen.delete(c);
        if (c > this.#floor) this.#floor = c;
      }
    }
    return true;
  }
}
