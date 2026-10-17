// Command sandboxes for `exec.*` (FR-184, FR-190; docs/12 §7). M3 ships a container substrate
// driven through the `docker` or `podman` CLI, and an unavailable client that makes exec tools
// fail closed. OS sandboxes (bubblewrap, seatbelt) arrive with FR-107 in M6.
//
// Containers run the turn's roots mounted at their own paths (read-only unless the profile
// grants writing), as a non-root user, with every capability dropped, no new privileges, a pid
// and memory limit, and no network unless the profile allows it. A command that is still
// running when its yield time ends becomes a session the model can poll or write to; every
// session of a turn is killed when the turn is cancelled or ends.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { NovaError, uuidv7 } from '@nova/shared';
import type { ExecRequest, ExecResult, SandboxClient } from './types.ts';

export const DEFAULT_SANDBOX_IMAGE = 'debian:stable-slim';
/** Open sessions per turn (FR-184). */
export const MAX_SESSIONS_PER_TURN = 8;

/** What exec tools pass beyond the seam's request: the owning turn and a progress hook. */
export interface ExecRequestExtras {
  turnId?: string;
  onOutput?: (chunk: string) => void;
}

/** A sandbox that never runs anything: exec tools fail closed with `sandbox_unavailable`. */
export class UnavailableSandbox implements SandboxClient {
  readonly substrate = null;
  readonly #detail: string;
  constructor(
    detail = 'No sandbox is available on this Hub: install Docker or Podman to let Nova run commands.',
  ) {
    this.#detail = detail;
  }
  available(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: false, detail: this.#detail });
  }
  exec(): Promise<ExecResult> {
    return Promise.reject(new NovaError('sandbox_unavailable', this.#detail));
  }
  poll(): Promise<ExecResult> {
    return Promise.reject(new NovaError('sandbox_unavailable', this.#detail));
  }
  write(): Promise<void> {
    return Promise.reject(new NovaError('sandbox_unavailable', this.#detail));
  }
  killTurn(): Promise<void> {
    return Promise.resolve();
  }
}

export interface ContainerSandboxOptions {
  /** `docker`, `podman` or a path to either. */
  bin: string;
  image?: string;
  /** `uid:gid` inside the container; defaults to the Hub's user, or nobody when that is root. */
  user?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  maxSessionsPerTurn?: number;
  /** Bytes of unread output kept per session; older output is dropped from the middle. */
  outputLimit?: number;
  /**
   * What a profile that allows network gets. Allowlists need the egress proxy (M6, docs/12 §8)
   * to be enforced, so the default `none` fails closed; `open` gives the container the engine's
   * default network, unfiltered.
   */
  allowedNetwork?: 'none' | 'open';
}

interface Session {
  id: string;
  name: string;
  turnId: string | null;
  child: ChildProcessWithoutNullStreams;
  unread: string;
  dropped: number;
  exitCode: number | null;
  exited: Promise<void>;
  onOutput: ((chunk: string) => void) | undefined;
}

export class ContainerSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly #bin: string;
  readonly #image: string;
  readonly #user: string;
  readonly #memory: string;
  readonly #cpus: string;
  readonly #pids: number;
  readonly #maxSessions: number;
  readonly #outputLimit: number;
  readonly #openNetwork: boolean;
  readonly #sessions = new Map<string, Session>();
  #probe: { at: number; value: { ok: boolean; detail: string } } | null = null;

  constructor(opts: ContainerSandboxOptions) {
    this.#bin = opts.bin;
    this.#image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
    const uid = process.getuid?.() ?? 65534;
    const gid = process.getgid?.() ?? 65534;
    this.#user = opts.user ?? (uid === 0 ? '65534:65534' : `${uid}:${gid}`);
    this.#memory = opts.memory ?? '2g';
    this.#cpus = opts.cpus ?? '2';
    this.#pids = opts.pidsLimit ?? 512;
    this.#maxSessions = opts.maxSessionsPerTurn ?? MAX_SESSIONS_PER_TURN;
    this.#outputLimit = opts.outputLimit ?? 4 * 1024 * 1024;
    this.#openNetwork = opts.allowedNetwork === 'open';
  }

  get image(): string {
    return this.#image;
  }

  /** Whether the container engine answers; cached for 30 s. */
  async available(): Promise<{ ok: boolean; detail: string }> {
    if (this.#probe && Date.now() - this.#probe.at < 30_000) return this.#probe.value;
    const value = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      execFile(
        this.#bin,
        ['version', '--format', '{{.Server.Version}}'],
        { timeout: 5_000 },
        (err, stdout) => {
          const version = String(stdout).trim();
          if (err || !version)
            resolve({
              ok: false,
              detail: `${this.#bin} is installed but its engine is not running`,
            });
          else resolve({ ok: true, detail: `${this.#bin} ${version}, image ${this.#image}` });
        },
      );
    });
    this.#probe = { at: Date.now(), value };
    return value;
  }

  /** Arguments for `<bin> run`, exposed for tests. */
  runArgs(req: ExecRequest, name: string): string[] {
    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      name,
      '--user',
      this.#user,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(this.#pids),
      '--memory',
      this.#memory,
      '--cpus',
      this.#cpus,
      '--workdir',
      req.cwd,
      '-e',
      'HOME=/tmp',
    ];
    // No network unless the profile allows it and the Hub opted into unfiltered access; until
    // the egress proxy enforces allowlists (M6), an allowlist fails closed.
    if (req.network === 'off' || !this.#openNetwork) args.push('--network', 'none');
    for (const root of req.roots) {
      // The host's filesystem root is never mounted: a profile's "whole filesystem" is the
      // container's own (docs/12 §7.1).
      if (root.path === '/' || /^[A-Za-z]:[\\/]?$/.test(root.path)) continue;
      if (root.path.includes(',') || root.path.includes('\n'))
        throw new NovaError('validation', `a folder path cannot contain commas: ${root.path}`);
      args.push(
        '--mount',
        `type=bind,source=${root.path},target=${root.path}${root.access === 'write' ? '' : ',readonly'}`,
      );
    }
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) args.push('-e', `${k}=${v}`);
    }
    args.push(this.#image, 'sh', '-c', req.cmd);
    return args;
  }

  async exec(req: ExecRequest & ExecRequestExtras): Promise<ExecResult> {
    const turnId = req.turnId ?? null;
    if (turnId !== null) {
      const open = [...this.#sessions.values()].filter(
        (s) => s.turnId === turnId && s.exitCode === null,
      ).length;
      if (open >= this.#maxSessions)
        throw new NovaError(
          'validation',
          `at most ${this.#maxSessions} commands can run at once; stop one with exec.write first`,
          { details: { reason: 'too_many_sessions' } },
        );
    }
    const id = uuidv7();
    const name = `nova-exec-${id}`;
    const child = spawn(this.#bin, this.runArgs(req, name), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveExit!: () => void;
    const s: Session = {
      id,
      name,
      turnId,
      child,
      unread: '',
      dropped: 0,
      exitCode: null,
      exited: new Promise<void>((r) => (resolveExit = r)),
      onOutput: req.onOutput,
    };
    // One decoder per stream: a character split across two chunks is decoded whole.
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (b: Buffer) => {
        const text = decoder.write(b);
        if (text) this.#append(s, text);
      });
      stream.on('end', () => {
        const rest = decoder.end();
        if (rest) this.#append(s, rest);
      });
    }
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      this.#append(s, `${err.message}\n`);
      s.exitCode ??= 127;
      resolveExit();
    });
    child.on('close', (code, signal) => {
      s.exitCode ??= code ?? (signal ? 128 + 9 : 1);
      resolveExit();
    });
    this.#sessions.set(id, s);
    return this.#wait(s, req.yieldMs, req.signal);
  }

  async poll(sessionId: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new NovaError('not_found', `no running command with session id ${sessionId}`);
    return this.#wait(s, yieldMs, signal);
  }

  async write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new NovaError('not_found', `no running command with session id ${sessionId}`);
    if (input.text !== undefined && s.exitCode === null && s.child.stdin.writable)
      s.child.stdin.write(input.text);
    if (input.closeStdin) s.child.stdin.end();
    if (input.signal === 'interrupt') await this.#cli(['kill', '--signal', 'INT', s.name]);
    if (input.signal === 'terminate') await this.#kill(s);
  }

  async killTurn(turnId: string): Promise<void> {
    const mine = [...this.#sessions.values()].filter((s) => s.turnId === turnId);
    await Promise.all(mine.map((s) => this.#kill(s)));
  }

  /** Kill every session (Hub shutdown). */
  async killAll(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => this.#kill(s)));
  }

  /** Open sessions of a turn (tests, diagnostics). */
  sessions(turnId?: string): string[] {
    return [...this.#sessions.values()]
      .filter((s) => turnId === undefined || s.turnId === turnId)
      .map((s) => s.id);
  }

  async #kill(s: Session): Promise<void> {
    this.#sessions.delete(s.id);
    if (s.exitCode !== null) return;
    await this.#cli(['kill', s.name]);
    s.child.kill('SIGKILL');
  }

  #cli(args: string[]): Promise<void> {
    return new Promise((resolve) => {
      execFile(this.#bin, args, { timeout: 10_000 }, () => resolve());
    });
  }

  #append(s: Session, chunk: string): void {
    s.onOutput?.(chunk);
    s.unread += chunk;
    if (s.unread.length > this.#outputLimit) {
      // Keep the start and the most recent output; the middle is reported as dropped.
      const head = Math.floor(this.#outputLimit / 4);
      const cut = s.unread.length - this.#outputLimit;
      s.dropped += cut;
      s.unread = s.unread.slice(0, head) + s.unread.slice(head + cut);
    }
  }

  #take(s: Session): string {
    let out = s.unread;
    if (s.dropped) {
      out = `${out.slice(0, Math.floor(this.#outputLimit / 4))}\n[... ${s.dropped} characters of output dropped ...]\n${out.slice(Math.floor(this.#outputLimit / 4))}`;
      s.dropped = 0;
    }
    s.unread = '';
    return out;
  }

  async #wait(s: Session, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      s.exited,
      new Promise<void>((r) => {
        timer = setTimeout(r, Math.max(0, yieldMs));
      }),
      new Promise<void>((r) => {
        if (signal.aborted) r();
        onAbort = () => r();
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (s.exitCode !== null) {
      // Let the last output events land before reading the buffer.
      await new Promise((r) => setImmediate(r));
      this.#sessions.delete(s.id);
      return { status: 'exited', exitCode: s.exitCode, output: this.#take(s) };
    }
    return { status: 'running', sessionId: s.id, output: this.#take(s) };
  }
}

/** Find an executable on PATH. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface DetectSandboxOptions {
  /** `off` disables commands; `docker` or `podman` forces one; `auto` (default) picks one. */
  mode?: string;
  image?: string;
  allowedNetwork?: 'none' | 'open';
  env?: NodeJS.ProcessEnv;
}

/** The container sandbox when docker or podman is installed, else the unavailable client. */
export function detectSandbox(opts: DetectSandboxOptions = {}): SandboxClient {
  const mode = (opts.mode ?? 'auto').toLowerCase();
  if (mode === 'off') return new UnavailableSandbox('Running commands is turned off on this Hub.');
  const names = mode === 'docker' || mode === 'podman' ? [mode] : ['docker', 'podman'];
  for (const n of names) {
    const bin = findOnPath(n, opts.env);
    if (bin)
      return new ContainerSandbox({
        bin,
        ...(opts.image ? { image: opts.image } : {}),
        ...(opts.allowedNetwork ? { allowedNetwork: opts.allowedNetwork } : {}),
      });
  }
  return new UnavailableSandbox();
}
