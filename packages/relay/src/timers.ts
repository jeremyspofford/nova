// Clock and timers, injectable so tests control time (vitest fake timers replace the globals the
// default reads at call time).

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};
