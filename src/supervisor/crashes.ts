// The supervisor's crash rule (M7 plan §2), for the console and every service it runs (M10e): a crash
// is restarted after a wait that doubles each time, and too many within a window means stop trying.
export interface CrashRule { crashes: number; windowMs: number; backoffMs: number; maxBackoffMs: number }

export class CrashWindow {
  readonly rule: CrashRule;
  #at: number[] = [];

  constructor(rule: CrashRule) {
    this.rule = rule;
  }

  // Counts one (a crash, or a restart something asked for), and says how many are in the window.
  record(now = Date.now()): number {
    this.#at = [...this.#at.filter((x) => now - x < this.rule.windowMs), now];
    return this.#at.length;
  }

  get count(): number {
    return this.#at.length;
  }

  // Too many within the window: held, not restarted.
  get tooMany(): boolean {
    return this.#at.length >= this.rule.crashes;
  }

  // How long to wait before the next start.
  wait(): number {
    return Math.min(this.rule.maxBackoffMs, this.rule.backoffMs * 2 ** (Math.max(1, this.#at.length) - 1));
  }

  reset(): void {
    this.#at = [];
  }
}
