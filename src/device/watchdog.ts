// The boot agent's watchdog (ADR-3; Era 1's novad supervisor, 6e2cf142 services/novad/src/
// supervisor.rs, is the reference). It keeps the runtime agent running: when it exits on its own it
// is started again after a wait that doubles each time (base, 2×, 4×… up to a cap). Three crashes
// within a minute put it in safe mode: the runtime stays down, and the boot agent says so in its
// heartbeat, until a new runtime arrives or the person runs `recover`.
import { EventEmitter } from 'node:events';

export interface ChildLike {
  readonly pid?: number | undefined;
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WatchdogOptions<C extends ChildLike> {
  start: () => C;
  backoffMs?: number;
  maxBackoffMs?: number;
  crashes?: number;
  windowMs?: number;
  now?: () => number;
}

export class Watchdog<C extends ChildLike> extends EventEmitter {
  child: C | null = null;
  safeMode = false;
  #o: Required<Omit<WatchdogOptions<C>, 'start'>> & { start: () => C };
  #crashes: number[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopping = false;
  #expected = new WeakSet<object>();

  constructor(o: WatchdogOptions<C>) {
    super();
    this.#o = { backoffMs: 1000, maxBackoffMs: 30_000, crashes: 3, windowMs: 60_000, now: Date.now, ...o };
  }

  // Starts the runtime, unless it is running, waiting to restart, or in safe mode.
  run(): void {
    this.#stopping = false;
    if (this.child || this.#timer || this.safeMode) return;
    this.#spawn();
  }

  // Ends the runtime on purpose (an update, a revocation, shutdown): not a crash. `then` runs once
  // it has exited.
  async stop(signal: NodeJS.Signals = 'SIGTERM', graceMs = 3000): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const c = this.child;
    if (!c) return;
    this.#expected.add(c);
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => c.kill('SIGKILL'), graceMs);
      c.on('exit', () => { clearTimeout(kill); resolve(); });
      c.kill(signal);
    });
  }

  // Stops and starts it again (a new runtime was installed), and forgets past crashes and safe mode.
  async restart(): Promise<void> {
    await this.stop();
    this.reset();
    this.run();
  }

  reset(): void {
    this.#crashes = [];
    this.safeMode = false;
  }

  #spawn(): void {
    const c = this.#o.start();
    this.child = c;
    this.emit('start', c);
    c.on('exit', (code, signal) => {
      if (this.child === c) this.child = null;
      if (this.#stopping || this.#expected.has(c)) return;
      const now = this.#o.now();
      this.#crashes = [...this.#crashes.filter((t) => now - t < this.#o.windowMs), now];
      this.emit('crash', { code, signal, count: this.#crashes.length });
      if (this.#crashes.length >= this.#o.crashes) {
        this.safeMode = true;
        this.emit('safe_mode', { crashes: this.#crashes.length });
        return;
      }
      const wait = Math.min(this.#o.maxBackoffMs, this.#o.backoffMs * 2 ** (this.#crashes.length - 1));
      this.emit('backoff', wait);
      this.#timer = setTimeout(() => { this.#timer = null; if (!this.#stopping && !this.safeMode) this.#spawn(); }, wait);
    });
  }
}
