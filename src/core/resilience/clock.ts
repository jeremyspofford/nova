// Noticing the clock jump (M7 plan §3, the chaos pass). Wall-clock time can jump (a machine that
// slept with a dead battery, a bad time server, someone setting the date by hand); the time that
// has passed in this process can't. Each look compares the two: when the wall clock moved more
// than five minutes away from the time that really passed, the clock jumped. On start, a record
// written "in the future" (newer than now) says it went back while Nova was off.
export const JUMP_MS = 5 * 60_000;

export interface Jump { direction: 'forward' | 'back'; ms: number; at: string; while: 'running' | 'stopped' }

export class ClockWatch {
  #now: () => Date;
  #mono: () => number;
  #last: { wall: number; mono: number } | null = null;

  constructor(o: { now: () => Date; monotonic?: () => number }) {
    this.#now = o.now;
    this.#mono = o.monotonic ?? (() => performance.now());
  }

  // Null, or the jump since the last look.
  look(): Jump | null {
    const wall = this.#now().getTime();
    const mono = this.#mono();
    const last = this.#last;
    this.#last = { wall, mono };
    if (!last) return null;
    const drift = (wall - last.wall) - (mono - last.mono);
    if (Math.abs(drift) < JUMP_MS) return null;
    return { direction: drift > 0 ? 'forward' : 'back', ms: Math.abs(drift), at: new Date(wall).toISOString(), while: 'running' };
  }

  // The newest time Nova wrote down before this start. If it is ahead of now, the clock went back.
  static atStart(newest: string | null, now: Date): Jump | null {
    if (!newest) return null;
    const ahead = Date.parse(newest) - now.getTime();
    return ahead >= JUMP_MS ? { direction: 'back', ms: ahead, at: now.toISOString(), while: 'stopped' } : null;
  }
}

export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min} minutes`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}
