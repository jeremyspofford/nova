// Hybrid logical clocks for sync (ADR-010, docs/13 §2.2). A value is physical milliseconds, a
// logical counter and the node that issued it, written with fixed widths so plain string order is
// clock order (the node breaks ties). The Hub's clock only moves forward: it starts from the last
// value it persisted, takes the larger of its wall clock and every clock it has seen, and counts
// up within one millisecond.
import { HLC_PATTERN } from '@nova/shared';

export interface Hlc {
  /** Physical time, Unix milliseconds. */
  pt: number;
  /** Logical counter within one millisecond. */
  c: number;
  node: string;
}

/** The largest counter; one more moves the physical part ahead by a millisecond. */
export const HLC_MAX_COUNTER = 0xffff;
const MAX_PT = 999_999_999_999_999;

export function formatHlc(h: Hlc): string {
  return `${String(h.pt).padStart(15, '0')}-${h.c.toString(16).padStart(4, '0')}-${h.node}`;
}

export function parseHlc(value: string): Hlc | null {
  const m = HLC_PATTERN.exec(value);
  if (!m) return null;
  return { pt: Number(m[1]), c: parseInt(m[2] ?? '0', 16), node: m[3] ?? '' };
}

/** Negative when `a` is older than `b`; an empty string is older than every clock. */
export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The newer of two clocks. */
export function maxHlc(a: string, b: string): string {
  return compareHlc(a, b) >= 0 ? a : b;
}

export interface HybridClockOptions {
  /** `hub`, or a device id. */
  node: string;
  /** Wall clock in Unix ms (tests inject one). */
  now?: () => number;
  /** The last value issued before a restart. */
  initial?: string | null;
}

export class HybridClock {
  readonly node: string;
  readonly #now: () => number;
  #pt = 0;
  #c = 0;

  constructor(opts: HybridClockOptions) {
    this.node = opts.node;
    this.#now = opts.now ?? Date.now;
    const start = opts.initial ? parseHlc(opts.initial) : null;
    if (start) {
      this.#pt = start.pt;
      this.#c = start.c;
    }
  }

  /** The last value issued (or the start), without moving the clock. */
  last(): string {
    return formatHlc({ pt: this.#pt, c: this.#c, node: this.node });
  }

  /** A new value for a local change: later than every value issued or seen. */
  tick(): string {
    const wall = this.#wall();
    if (wall > this.#pt) {
      this.#pt = wall;
      this.#c = 0;
    } else {
      this.#bump(this.#c + 1);
    }
    return this.last();
  }

  /**
   * Take in a clock from another node (a pushed op): the next local value is later than it.
   * Returns the local clock after the update.
   */
  receive(remote: string): string {
    const r = parseHlc(remote);
    if (!r) return this.last();
    const wall = this.#wall();
    const pt = Math.max(this.#pt, r.pt, wall);
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
    if (c > HLC_MAX_COUNTER) {
      this.#pt += 1;
      this.#c = 0;
    } else {
      this.#c = c;
    }
  }
}

/**
 * Why a pushed clock is refused, or null when it is usable: it must parse, name the pushing
 * device as its node (no device can tie-break as another), and be at most `maxSkewMs` ahead of
 * the Hub's wall clock, so a device whose clock runs far ahead cannot win every merge.
 */
export function hlcProblem(
  value: string,
  opts: { node: string; nowMs: number; maxSkewMs: number },
): 'invalid_hlc' | 'hlc_device_mismatch' | 'clock_skew' | null {
  const h = parseHlc(value);
  if (!h) return 'invalid_hlc';
  if (h.node !== opts.node) return 'hlc_device_mismatch';
  if (h.pt > opts.nowMs + opts.maxSkewMs) return 'clock_skew';
  return null;
}
