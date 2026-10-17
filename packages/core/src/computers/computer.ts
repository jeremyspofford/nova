// A computer backed by a folder on the Hub and the local sandbox substrate (FR-080, docs/11 §1-
// §2): the agent's own computer (`local_container`) and the mock cloud computer use it. Layout:
// <root>/home is the persistent home and work folder (files, and software installed per user:
// pip --user, npm prefixes, ~/.local/bin), <root>/browser the browser profile, which is never
// mounted into the sandbox (a browser profile is a credential location, docs/12 §7.2).
// Commands run in the sandbox with the home folder as their only writable root and HOME, and
// their network goes through the egress proxy under the agent's scope. Snapshots copy the
// folder; restoring swaps it back. Paths are resolved inside the home folder, refusing `..` and
// symlink escapes.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { mkdir, open, readdir, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NovaError, uuidv7 } from '@nova/shared';
import type {
  ProcessSandbox,
  RunOnceResult,
  SandboxExecRequest,
} from '../tools/sandbox-process.ts';
import type { AuditSink, SandboxClient, ToolRoot } from '../tools/types.ts';
import type {
  BrowserController,
  Computer,
  ComputerDirent,
  ComputerExecResult,
  ComputerExecSpec,
  ComputerKind,
  ComputerStat,
  ComputerStatus,
  ScreenController,
  SnapshotRef,
} from './types.ts';

const MAX_READ = 10 * 1024 * 1024;

/** What a computer needs from its service: state, snapshots, factories, audit. */
export interface ComputerHost {
  /** Record a state change (persisted, `computer.state.changed`). */
  setState(id: string, to: ComputerStatus['state'], detail?: string | null): Promise<void>;
  state(id: string): ComputerStatus['state'];
  touch(id: string): void;
  recordSnapshot(input: {
    computerId: string;
    id: string;
    label: string | null;
    path: string;
    sizeBytes: number;
    createdAt: string;
  }): Promise<void>;
  snapshotPath(computerId: string, snapshotId: string): string | null;
  browser?(computer: DirComputer): Promise<BrowserController | null>;
  screen?(computer: DirComputer): Promise<ScreenController | null>;
  audit?: AuditSink;
  /** Kill the sessions exec tools started on this computer (the turn router's). */
  stopSessions?(computerId: string): Promise<void>;
  limits(): Promise<{ wallClockMs: number }>;
  now(): Date;
}

export interface DirComputerOptions {
  id: string;
  accountId: string;
  kind: Exclude<ComputerKind, 'local_host'>;
  agentId: string | null;
  /** <dataDir>/computers/<id> (or the mock cloud runner's folder). */
  root: string;
  /** Where its snapshots go: blobs/snapshots/<id>. */
  snapshotsDir: string;
  sandbox: () => SandboxClient;
  host: ComputerHost;
  /** `cloud_stub` for the mock cloud runner; otherwise from the sandbox. */
  substrateLabel?: ComputerStatus['substrate'];
  /** Said in `status().detail` while running. */
  description?: string;
}

/** POSIX shell quoting for one argument. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./=:@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function substrateOf(sb: SandboxClient): ComputerStatus['substrate'] {
  switch (sb.substrate) {
    case 'container':
      return 'container';
    case 'os_sandbox':
      return 'bwrap';
    case 'micro_vm':
      return 'micro_vm';
    case 'cloud':
      return 'cloud_stub';
    default:
      return null;
  }
}

function hasRunOnce(sb: SandboxClient): sb is SandboxClient & Pick<ProcessSandbox, 'runOnce'> {
  return typeof (sb as Partial<ProcessSandbox>).runOnce === 'function';
}

function direntKind(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (st.isSymbolicLink()) return 'symlink' as const;
  if (st.isDirectory()) return 'dir' as const;
  if (st.isFile()) return 'file' as const;
  return 'other' as const;
}

/** Bytes used by a folder (symlinks counted as links). */
export function folderSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += lstatSync(p).size;
        } catch {
          // Gone meanwhile.
        }
      }
    }
  };
  walk(dir);
  return total;
}

export class DirComputer implements Computer {
  readonly id: string;
  readonly kind: Exclude<ComputerKind, 'local_host'>;
  readonly accountId: string;
  readonly agentId: string | null;
  readonly root: string;
  readonly #o: DirComputerOptions;
  readonly #running = new Set<AbortController>();
  #lock: Promise<unknown> = Promise.resolve();

  constructor(opts: DirComputerOptions) {
    this.#o = opts;
    this.id = opts.id;
    this.kind = opts.kind;
    this.accountId = opts.accountId;
    this.agentId = opts.agentId;
    this.root = opts.root;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    mkdirSync(this.browserProfileDir, { recursive: true, mode: 0o700 });
  }

  /** The persistent home and work folder (the sandbox's writable root and HOME). */
  get home(): string {
    return join(this.root, 'home');
  }

  /** The agent browser's own profile (never mounted into the sandbox). */
  get browserProfileDir(): string {
    return join(this.root, 'browser');
  }

  /** The roots tools and the sandbox use on this computer. */
  roots(): ToolRoot[] {
    return [{ path: this.home, access: 'write', label: 'computer' }];
  }

  /** The egress scope of this computer's commands. */
  get egressScope(): { kind: 'agent' | 'sandbox'; id: string } {
    return this.agentId ? { kind: 'agent', id: this.agentId } : { kind: 'sandbox', id: this.id };
  }

  /** Serialize snapshot, restore and stop on this computer. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  /** A path inside the home folder; `..` and symlinks that leave it are refused. */
  resolvePath(p: string): string {
    const home = realpathSync(this.home);
    const abs = isAbsolute(p) ? resolve(p) : resolve(home, p);
    const inside = (x: string) => x === home || x.startsWith(home + sep);
    // The home folder may be reached through its non-canonical path too.
    const viaRoot = resolve(this.home);
    const candidate = inside(abs)
      ? abs
      : abs === viaRoot || abs.startsWith(viaRoot + sep)
        ? join(home, relative(viaRoot, abs))
        : null;
    if (!candidate) throw new NovaError('policy_denied', `${p} is outside this computer's files`);
    // The deepest existing ancestor must resolve inside too (no symlink escape).
    let probe = candidate;
    while (!existsSync(probe) && probe !== home) probe = dirname(probe);
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      throw new NovaError('policy_denied', `${p} is outside this computer's files`);
    }
    if (!inside(real))
      throw new NovaError('policy_denied', `${p} is outside this computer's files`);
    return candidate;
  }

  async #mark(): Promise<void> {
    this.#o.host.touch(this.id);
    if (this.#o.host.state(this.id) !== 'running') await this.#o.host.setState(this.id, 'running');
  }

  async #audit(
    action: string,
    resource: string,
    input: string,
    result: string | null,
    actor?: string,
  ): Promise<void> {
    try {
      await this.#o.host.audit?.append({
        accountId: this.accountId,
        actor: actor ?? (this.agentId ? `agent:${this.agentId}` : 'system'),
        kind: 'computer',
        action,
        resource,
        inputHash: createHash('sha256').update(input).digest('hex'),
        decision: null,
        result,
        detail: { computerId: this.id },
      });
    } catch {
      // The sink reports its own failures.
    }
  }

  readonly fs = {
    read: async (path: string, opts?: { maxBytes?: number }): Promise<Uint8Array> => {
      const p = this.resolvePath(path);
      const max = Math.min(opts?.maxBytes ?? MAX_READ, MAX_READ);
      const fh = await open(p, 'r');
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new NovaError('validation', `${path} is not a file`);
        const buf = Buffer.alloc(Math.min(st.size, max));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return new Uint8Array(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    },
    write: async (
      path: string,
      data: Uint8Array,
      opts?: { createDirs?: boolean },
    ): Promise<void> => {
      const p = this.resolvePath(path);
      if (opts?.createDirs) await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
      await this.#mark();
      await this.#audit('computer.fs.write', `computer:${this.id}`, relative(this.home, p), 'ok');
    },
    list: async (path: string): Promise<ComputerDirent[]> => {
      const p = this.resolvePath(path);
      const entries = await readdir(p, { withFileTypes: true });
      const out: ComputerDirent[] = [];
      for (const e of entries) {
        let size: number | null = null;
        if (e.isFile()) size = (await lstat(join(p, e.name))).size;
        out.push({ name: e.name, kind: direntKind(e), size });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    stat: async (path: string): Promise<ComputerStat> => {
      const st = await lstat(this.resolvePath(path));
      return { kind: direntKind(st), size: st.size, mtimeMs: st.mtimeMs };
    },
    delete: async (path: string): Promise<void> => {
      const p = this.resolvePath(path);
      if (p === realpathSync(this.home))
        throw new NovaError('policy_denied', "the computer's home folder cannot be deleted");
      await rm(p, { recursive: true });
      await this.#mark();
      await this.#audit('computer.fs.delete', `computer:${this.id}`, relative(this.home, p), 'ok');
    },
    move: async (from: string, to: string): Promise<void> => {
      const a = this.resolvePath(from);
      const b = this.resolvePath(to);
      if (a === realpathSync(this.home))
        throw new NovaError('policy_denied', "the computer's home folder cannot be moved");
      await rename(a, b);
      await this.#mark();
      await this.#audit('computer.fs.move', `computer:${this.id}`, `${from}\n${to}`, 'ok');
    },
  };

  /** The request this computer's commands run with: its home as the root, the agent's network. */
  sandboxRequest(
    base: {
      cmd: string;
      cwd?: string;
      network?: ComputerExecSpec['network'];
      env?: Record<string, string>;
    },
    extra: { yieldMs: number; signal: AbortSignal; timeoutMs: number },
  ): SandboxExecRequest {
    return {
      cmd: base.cmd,
      cwd: base.cwd ? this.resolvePath(base.cwd) : realpathSync(this.home),
      roots: this.roots().map((r) => ({ ...r, path: realpathSync(r.path) })),
      // Default: the agent's allowlist through the proxy; a call can only narrow it.
      network: base.network ?? 'allowlist',
      env: { ...(base.env ?? {}), HOME: realpathSync(this.home) },
      yieldMs: extra.yieldMs,
      signal: extra.signal,
      timeoutMs: extra.timeoutMs,
      egress: { accountId: this.accountId, threadId: null, scope: this.egressScope },
    };
  }

  async exec(spec: ComputerExecSpec, signal: AbortSignal): Promise<ComputerExecResult> {
    const sb = this.#o.sandbox();
    const a = await sb.available();
    if (!a.ok) throw new NovaError('sandbox_unavailable', a.detail);
    const cmd = spec.args?.length ? [spec.cmd, ...spec.args].map(shellQuote).join(' ') : spec.cmd;
    const limits = await this.#o.host.limits();
    const timeoutMs = Math.min(spec.timeoutMs ?? limits.wallClockMs, limits.wallClockMs);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) ac.abort();
    this.#running.add(ac);
    await this.#mark();
    try {
      const base: {
        cmd: string;
        cwd?: string;
        network?: ComputerExecSpec['network'];
        env?: Record<string, string>;
      } = { cmd };
      if (spec.cwd !== undefined) base.cwd = spec.cwd;
      if (spec.network !== undefined) base.network = spec.network;
      if (spec.env !== undefined) base.env = spec.env;
      const req = this.sandboxRequest(base, { yieldMs: timeoutMs, signal: ac.signal, timeoutMs });
      let r: RunOnceResult;
      if (hasRunOnce(sb)) {
        r = await sb.runOnce(
          spec.stdin !== undefined ? { ...req, stdin: spec.stdin } : req,
          ac.signal,
        );
      } else {
        // A sandbox without one-shot runs: one combined stream, no stdin.
        const out = await sb.exec(req);
        if (out.status === 'running') {
          await sb.write(out.sessionId, { signal: 'terminate' }).catch(() => undefined);
          r = { exitCode: null, stdout: out.output, stderr: '', timedOut: true };
        } else r = { exitCode: out.exitCode, stdout: out.output, stderr: '', timedOut: false };
      }
      await this.#audit(
        'computer.exec',
        `computer:${this.id}`,
        cmd,
        r.timedOut ? 'timeout' : String(r.exitCode),
      );
      return r;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.#running.delete(ac);
    }
  }

  async browser(): Promise<BrowserController | null> {
    return (await this.#o.host.browser?.(this)) ?? null;
  }

  async screen(): Promise<ScreenController | null> {
    return (await this.#o.host.screen?.(this)) ?? null;
  }

  /** `actor` is who asked (`user` from the API); the computer's agent by default. */
  snapshot(label?: string, actor?: string): Promise<SnapshotRef> {
    return this.#serial(async () => {
      const id = uuidv7();
      const createdAt = this.#o.host.now().toISOString();
      const dest = join(this.#o.snapshotsDir, id);
      mkdirSync(this.#o.snapshotsDir, { recursive: true, mode: 0o700 });
      cpSync(this.root, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
      await this.#o.host.recordSnapshot({
        computerId: this.id,
        id,
        label: label ?? null,
        path: dest,
        sizeBytes: folderSize(dest),
        createdAt,
      });
      await this.#audit('computer.snapshot', `computer:${this.id}`, id, 'ok', actor);
      return { id, label: label ?? null, createdAt };
    });
  }

  restore(ref: SnapshotRef, actor?: string): Promise<void> {
    return this.#serial(async () => {
      const src = this.#o.host.snapshotPath(this.id, ref.id);
      if (!src || !existsSync(src)) throw new NovaError('not_found', 'no such snapshot');
      // Nothing keeps running against the files being replaced.
      this.#abortAll();
      const old = `${this.root}.old-${uuidv7()}`;
      const fresh = `${this.root}.new-${uuidv7()}`;
      cpSync(src, fresh, { recursive: true, verbatimSymlinks: true });
      renameSync(this.root, old);
      renameSync(fresh, this.root);
      rmSync(old, { recursive: true, force: true });
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      mkdirSync(this.browserProfileDir, { recursive: true, mode: 0o700 });
      await this.#audit('computer.restore', `computer:${this.id}`, ref.id, 'ok', actor);
    });
  }

  async status(): Promise<ComputerStatus> {
    const sb = this.#o.sandbox();
    const a = await sb.available();
    const substrate = this.#o.substrateLabel ?? substrateOf(sb);
    if (!a.ok)
      return {
        state: 'degraded',
        substrate,
        detail: `${a.detail} Files can still be read and written; commands are unavailable.`,
      };
    return {
      state: this.#o.host.state(this.id),
      substrate,
      detail: this.#o.description ?? a.detail,
    };
  }

  #abortAll(): void {
    for (const ac of this.#running) ac.abort();
    this.#running.clear();
  }

  stop(actor?: string): Promise<void> {
    return this.#serial(async () => {
      this.#abortAll();
      await this.#o.host.stopSessions?.(this.id);
      if (this.#o.host.state(this.id) !== 'stopped')
        await this.#o.host.setState(this.id, 'stopped');
      await this.#audit('computer.stop', `computer:${this.id}`, this.id, 'ok', actor);
    });
  }
}
