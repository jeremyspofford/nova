// One run of a program as the supervisor's child, stopped on purpose (SIGTERM, then SIGKILL after a
// grace period) without that counting as a crash. By default it is the Nova server: started from a
// release's code with an IPC channel, ready once it says where it listens. A service the supervisor
// driver runs (M10e) gives its own command, runs as the leader of its own process group (the whole
// group is ended with it), has no IPC channel, and is made ready by its health check (`markReady`).
// Its group is signalled only while it is known to be the same group: while the leader hasn't been
// reaped, or, after, while /proc still shows a member of it (Linux never reuses a group's number while
// a member lives). Otherwise the number may belong to someone else by now, and nothing is sent.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { members, stat, type ProcId } from './procs.ts';

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

  readonly group: boolean;
  readonly identity: ProcId | null;

  constructor(o: { root: string; env: Record<string, string>; echo?: (s: string) => void; argv?: string[]; group?: boolean }) {
    super();
    this.root = o.root;
    this.group = o.group === true;
    const [cmd, ...args] = o.argv ?? [process.execPath, join(o.root, 'src', 'server.js')];
    this.proc = spawn(cmd!, args, { cwd: o.root, env: o.env, stdio: this.group ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'], detached: this.group });
    // A command that can't start (not found) is an exit like any other, never an unhandled error.
    this.proc.on('error', (e) => { this.#lines.push(`It couldn’t start: ${e.message}`); });
    // Who it is, for a later supervisor: its pid and start time (Linux), read as soon as it exists.
    const st = this.proc.pid ? stat(this.proc.pid) : null;
    this.identity = st ? { pid: st.pid, start: st.start } : null;
    const take = (d: Buffer) => {
      const text = this.#partial + String(d);
      const lines = text.split('\n');
      this.#partial = lines.pop() ?? '';
      for (const l of lines) {
        this.#lines.push(l);
        o.echo?.(`${l}\n`);
        const m = this.group ? null : /Nova is ready at http:\/\/[^:]+:(\d+)/.exec(l);
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
      // Never spawned at all: there is no exit to wait for.
      this.proc.once('error', () => { if (this.proc.pid === undefined) finish(null, null); });
    });
  }

  get pid(): number | null { return this.proc.pid ?? null; }

  // A service is ready when the supervisor says so (its health answered), on the port it was given.
  markReady(port: number): void {
    if (this.port !== null) return;
    this.port = port;
    this.emit('ready', port);
  }
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
    if (!this.alive) { this.#endGroup(); return; }
    this.#signal('SIGTERM');
    const kill = setTimeout(() => { if (this.alive) this.#signal('SIGKILL'); }, graceMs);
    await this.#exited;
    clearTimeout(kill);
    // What the leader left behind in its group goes too.
    this.#endGroup();
  }

  #signal(s: NodeJS.Signals): void {
    if (this.group && this.proc.pid) { try { process.kill(-this.proc.pid, s); return; } catch { /* the group is gone */ } }
    try { this.proc.kill(s); } catch { /* already gone */ }
  }

  // What the leader left behind. With the leader reaped, the group is signalled only if a member is
  // still there to show the number is still this group's.
  #endGroup(): void {
    if (!this.group || !this.proc.pid) return;
    if (!this.alive && !members(this.proc.pid).length) return;
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { /* nothing left */ }
  }

  // The processes in its group now, by pid and start time (Linux; empty elsewhere).
  groupMembers(): ProcId[] {
    if (!this.group || !this.proc.pid) return [];
    return members(this.proc.pid).map((m) => ({ pid: m.pid, start: m.start }));
  }

  exited() {
    return this.#exited;
  }
}
