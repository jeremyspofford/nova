// One run of the Nova server as the supervisor's child: started from a release's code with an IPC
// channel, ready once it says where it listens, and stopped on purpose (SIGTERM, then SIGKILL after
// a grace period) without that counting as a crash.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

const KEEP_LINES = 200;

export class ServerProcess extends EventEmitter {
  readonly proc: ChildProcess;
  readonly root: string;
  readonly startedAt = Date.now();
  port: number | null = null;
  #lines: string[] = [];
  #partial = '';
  #stopping = false;
  #exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(o: { root: string; env: Record<string, string>; echo?: (s: string) => void }) {
    super();
    this.root = o.root;
    this.proc = spawn(process.execPath, [join(o.root, 'src', 'server.js')], { cwd: o.root, env: o.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const take = (d: Buffer) => {
      const text = this.#partial + String(d);
      const lines = text.split('\n');
      this.#partial = lines.pop() ?? '';
      for (const l of lines) {
        this.#lines.push(l);
        o.echo?.(`${l}\n`);
        const m = /Nova is ready at http:\/\/[^:]+:(\d+)/.exec(l);
        if (m && this.port === null) { this.port = Number(m[1]); this.emit('ready', this.port); }
      }
      if (this.#lines.length > KEEP_LINES) this.#lines.splice(0, this.#lines.length - KEEP_LINES);
    };
    this.proc.stdout!.on('data', take);
    this.proc.stderr!.on('data', take);
    this.proc.on('message', (m) => this.emit('message', m));
    // 'close', not 'exit': by then everything it wrote has been read, so its last words are kept.
    // A process it started that still holds the output open must not hide the exit: two seconds
    // after 'exit', it counts as closed.
    this.#exited = new Promise((resolve) => {
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (this.#partial) this.#lines.push(this.#partial);
        resolve({ code, signal });
        this.emit('exit', { code, signal, expected: this.#stopping });
      };
      this.proc.once('close', finish);
      this.proc.once('exit', (code, signal) => { setTimeout(() => finish(code, signal), 2000).unref(); });
    });
  }

  get pid(): number | null { return this.proc.pid ?? null; }
  get alive(): boolean { return this.proc.exitCode === null && this.proc.signalCode === null; }
  get stopping(): boolean { return this.#stopping; }

  // The last lines it wrote, for the reason when it stopped.
  tail(n = 20): string {
    return this.#lines.slice(-n).join('\n');
  }

  // Resolves with the port once ready, or null if it stopped or didn't get there in time.
  ready(timeoutMs: number): Promise<number | null> {
    if (this.port !== null) return Promise.resolve(this.port);
    if (!this.alive) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (v: number | null) => { clearTimeout(t); this.off('ready', onReady); this.off('exit', onExit); resolve(v); };
      const onReady = (p: number) => done(p);
      const onExit = () => done(null);
      const t = setTimeout(() => done(null), timeoutMs);
      this.on('ready', onReady);
      this.on('exit', onExit);
    });
  }

  send(msg: unknown): boolean {
    try { return this.proc.connected ? this.proc.send(msg as object) : false; } catch { return false; }
  }

  // Ends it on purpose: not a crash.
  async stop(graceMs = 10_000): Promise<void> {
    this.#stopping = true;
    if (!this.alive) return;
    this.proc.kill('SIGTERM');
    const kill = setTimeout(() => { if (this.alive) this.proc.kill('SIGKILL'); }, graceMs);
    await this.#exited;
    clearTimeout(kill);
  }

  exited() {
    return this.#exited;
  }
}
