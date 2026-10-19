// Process sessions shared by the substrates that run a sandbox as a child process (container,
// bubblewrap): sessions per turn, yield and poll, stdin, interrupt and terminate, an output cap
// that keeps the head and the tail, a wall-clock limit (docs/11 §8), and a one-shot run with
// separate stdout and stderr for computers (FR-080). A substrate supplies a launch plan per
// command; the plan's cleanup (closing the egress session and the dev-server bridge) runs when
// the process ends.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { NovaError, uuidv7 } from '@nova/shared';
import type { EgressPolicyOverride } from './sandbox-egress.ts';
import type { ExecRequest, ExecResult, SandboxClient } from './types.ts';

/** Open sessions per turn (FR-184). */
export const MAX_SESSIONS_PER_TURN = 8;

/** What exec tools and computers pass beyond the seam's request. */
export interface ExecRequestExtras {
  /** The turn that owns the session (killed when the turn ends). */
  turnId?: string;
  onOutput?: (chunk: string) => void;
  /** Wall-clock limit of this command (docs/11 §8); the sandbox's default otherwise. */
  timeoutMs?: number;
  /** Whose network policy applies (FR-193); exec tools pass `owner` instead. */
  egress?: {
    accountId: string;
    threadId?: string | null;
    scope?: { kind: 'run' | 'session' | 'agent' | 'sandbox'; id: string } | null;
    /**
     * An explicit policy that replaces the scopes' (an external agent's own declared hosts,
     * FR-203): only these hosts, the global deny list still applies, and no credentials.
     */
    policy?: EgressPolicyOverride;
  };
  /**
   * Make a server inside reachable from the Hub (dev servers, FR-097): the substrate bridges
   * 127.0.0.1:`port` inside to a free port on the Hub's 127.0.0.1, reported in the running
   * result's `published` (sandbox-publish.ts). The command's network is unchanged.
   */
  publish?: { port: number };
}

export type SandboxExecRequest = ExecRequest & ExecRequestExtras;

/** How one command is started. */
export interface LaunchPlan {
  bin: string;
  args: string[];
  /** Bytes the child reads on fd 3 (a seccomp program). */
  fd3?: Uint8Array;
  /** Stop the sandbox itself, beyond killing the client process (`docker kill`). */
  kill?: () => Promise<void>;
  interrupt?: () => Promise<void>;
  /** Runs once the process has ended (closes the egress session). */
  cleanup?: () => Promise<void>;
  /** Shown before the command's output: why it has no network, for example. */
  note?: string;
  /** The dev-server bridge: the port inside and its Hub-side port on 127.0.0.1. */
  published?: { port: number; hostPort: number };
}

/** A command run to completion (computers). */
export interface RunOnceResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessSandboxOptions {
  maxSessionsPerTurn?: number;
  /** Bytes of unread output kept per session; older output is dropped from the middle. */
  outputLimit?: number;
  /** Default wall-clock limit per command; none when unset (a session ends with its turn). */
  wallClockMs?: number;
  /** Folders hidden wherever a root contains them: the Nova data directory (docs/12 §7.2). */
  deniedPaths?: string[];
}

interface Session {
  id: string;
  turnId: string | null;
  child: ChildProcessWithoutNullStreams;
  plan: LaunchPlan;
  unread: string;
  dropped: number;
  exitCode: number | null;
  exited: Promise<void>;
  onOutput: ((chunk: string) => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  published: { port: number; hostPort: number } | undefined;
}

export abstract class ProcessSandbox implements SandboxClient {
  abstract readonly substrate: SandboxClient['substrate'];
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  readonly #outputLimit: number;
  readonly #wallClockMs: number | undefined;
  /** Hidden wherever a root contains them (substrates mount them, sandbox-protect.ts). */
  protected readonly deniedPaths: readonly string[];

  constructor(opts: ProcessSandboxOptions = {}) {
    this.deniedPaths = opts.deniedPaths ?? [];
    this.#maxSessions = opts.maxSessionsPerTurn ?? MAX_SESSIONS_PER_TURN;
    this.#outputLimit = opts.outputLimit ?? 4 * 1024 * 1024;
    this.#wallClockMs = opts.wallClockMs;
  }

  abstract available(): Promise<{ ok: boolean; detail: string }>;

  /** Build the launch for one command; `name` is unique to it. */
  protected abstract plan(req: SandboxExecRequest, name: string): Promise<LaunchPlan>;

  /** A prefix for session names (`nova-exec`). */
  protected get namePrefix(): string {
    return 'nova-exec';
  }

  async exec(req: SandboxExecRequest): Promise<ExecResult> {
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
    const plan = await this.plan(req, `${this.namePrefix}-${id}`);
    const child = this.#spawn(plan);
    let resolveExit!: () => void;
    const s: Session = {
      id,
      turnId,
      child,
      plan,
      unread: '',
      dropped: 0,
      exitCode: null,
      exited: new Promise<void>((r) => (resolveExit = r)),
      onOutput: req.onOutput,
      timer: undefined,
      published: plan.published,
    };
    if (plan.note) this.#append(s, `${plan.note}\n`);
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
    let cleaned = false;
    const ended = () => {
      clearTimeout(s.timer);
      resolveExit();
      if (cleaned) return;
      cleaned = true;
      void plan.cleanup?.().catch(() => undefined);
    };
    child.on('error', (err) => {
      this.#append(s, `${err.message}\n`);
      s.exitCode ??= 127;
      ended();
    });
    child.on('close', (code, signal) => {
      s.exitCode ??= code ?? (signal ? 128 + 9 : 1);
      ended();
    });
    const limit = req.timeoutMs ?? this.#wallClockMs;
    if (limit !== undefined && limit > 0) {
      s.timer = setTimeout(() => {
        this.#append(s, `\nnova: stopped after ${Math.round(limit / 1000)} s (wall-clock limit)\n`);
        void this.#stop(s);
      }, limit);
    }
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
    if (input.signal === 'interrupt') {
      if (s.plan.interrupt) await s.plan.interrupt();
      else s.child.kill('SIGINT');
    }
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

  /**
   * Run one command to completion with separate stdout and stderr (computers): stdin is written
   * and closed, the wall-clock limit and the signal stop it.
   */
  async runOnce(
    req: SandboxExecRequest & { stdin?: string },
    signal: AbortSignal,
  ): Promise<RunOnceResult> {
    const plan = await this.plan(req, `${this.namePrefix}-${uuidv7()}`);
    const child = this.#spawn(plan);
    const max = this.#outputLimit;
    const out = { stdout: plan.note ? `${plan.note}\n` : '', stderr: '' };
    for (const [key, stream] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ] as const) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (b: Buffer) => {
        if (out[key].length < max) out[key] += decoder.write(b);
      });
      stream.on('end', () => {
        out[key] += decoder.end();
        if (out[key].length > max) out[key] = `${out[key].slice(0, max)}\n[output truncated]\n`;
      });
    }
    child.stdin.on('error', () => undefined);
    child.stdin.end(req.stdin ?? '');
    let timedOut = false;
    const stop = async () => {
      await plan.kill?.().catch(() => undefined);
      child.kill('SIGKILL');
      // A descendant may still hold the pipes open: stop reading so the run ends now.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const limit = req.timeoutMs ?? this.#wallClockMs;
    const timer =
      limit !== undefined && limit > 0
        ? setTimeout(() => {
            timedOut = true;
            void stop();
          }, limit)
        : undefined;
    const onAbort = () => void stop();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        out.stderr += `${err.message}\n`;
        resolve(127);
      });
      child.on('close', (code, sig) => resolve(code ?? (sig ? 128 + 9 : null)));
    });
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await plan.cleanup?.().catch(() => undefined);
    return { exitCode: timedOut ? null : exitCode, ...out, timedOut };
  }

  #spawn(plan: LaunchPlan): ChildProcessWithoutNullStreams {
    if (!plan.fd3) return spawn(plan.bin, plan.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const child = spawn(plan.bin, plan.args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const fd3 = child.stdio[3] as Writable | null;
    fd3?.on('error', () => undefined);
    fd3?.end(Buffer.from(plan.fd3));
    return child;
  }

  async #stop(s: Session): Promise<void> {
    if (s.exitCode !== null) return;
    await s.plan.kill?.().catch(() => undefined);
    s.child.kill('SIGKILL');
    // A descendant may still hold the pipes open: stop reading so the session ends now.
    s.child.stdout.destroy();
    s.child.stderr.destroy();
  }

  async #kill(s: Session): Promise<void> {
    this.#sessions.delete(s.id);
    clearTimeout(s.timer);
    await this.#stop(s);
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
    const running: ExecResult = { status: 'running', sessionId: s.id, output: this.#take(s) };
    if (s.published) running.published = { ...s.published };
    return running;
  }
}
