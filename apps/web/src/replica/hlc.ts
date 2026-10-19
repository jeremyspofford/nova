// The client's hybrid logical clock (ADR-010, docs/13 §2.2), in the Hub's exact format
// (packages/core/src/sync/hlc.ts): 15-digit physical milliseconds, 4 hex digits of logical counter
// and the node, here this device's id. Fixed widths make plain string order clock order. The clock
// only moves forward: it starts from the last value it issued, takes in every clock it pulls or
// is answered, and counts up within one millisecond.
import { HLC_PATTERN } from '@nova/shared';

export interface Hlc {
  pt: number;
  c: number;
  node: string;
}

const MAX_COUNTER = 0xffff;
const MAX_PT = 999_999_999_999_999;

export function formatHlc(h: Hlc): string {
  return `${String(h.pt).padStart(15, '0')}-${h.c.toString(16).padStart(4, '0')}-${h.node}`;
}

export function parseHlc(value: string): Hlc | null {
  const m = HLC_PATTERN.exec(value);
  if (!m) return null;
  return { pt: Number(m[1]), c: parseInt(m[2] ?? '0', 16), node: m[3] ?? '' };
}

/** The wall-clock time a clock value carries (Unix ms), or null for a value that does not parse. */
export function hlcMs(value: string | null | undefined): number | null {
  if (!value) return null;
  return parseHlc(value)?.pt ?? null;
}

/** Negative when `a` is older than `b`. */
export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export class HybridClock {
  readonly node: string;
  readonly #now: () => number;
  #pt = 0;
  #c = 0;

  constructor(opts: { node: string; now?: () => number; initial?: string | null }) {
    this.node = opts.node;
    this.#now = opts.now ?? Date.now;
    const start = opts.initial ? parseHlc(opts.initial) : null;
    if (start) {
      this.#pt = start.pt;
      this.#c = start.c;
    }
  }

  last(): string {
    return formatHlc({ pt: this.#pt, c: this.#c, node: this.node });
  }

  /** A value for a change made here: later than every value issued or seen. */
  tick(): string {
    const wall = this.#wall();
    if (wall > this.#pt) {
      this.#pt = wall;
      this.#c = 0;
    } else this.#bump(this.#c + 1);
    return this.last();
  }

  /** Take in another node's clock, so the next local value is later than it. */
  receive(remote: string): string {
    const r = parseHlc(remote);
    if (!r) return this.last();
    const pt = Math.max(this.#pt, r.pt, this.#wall());
    if (pt === this.#pt && pt === r.pt) this.#bump(Math.max(this.#c, r.c) + 1);
    else if (pt === this.#pt) this.#bump(this.#c + 1);
    else if (pt === r.pt) {
      this.#pt = pt;
      this.#bump(r.c + 1);
    } else {
      this.#pt = pt;
      this.#c = 0;
    }
    return this.last();
  }

  #wall(): number {
    return Math.min(MAX_PT, Math.max(0, Math.floor(this.#now())));
  }

  #bump(c: number): void {
    if (c > MAX_COUNTER) {
      this.#pt += 1;
      this.#c = 0;
    } else this.#c = c;
  }
}
