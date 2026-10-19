// Interactive exec sessions in the Hub (FR-184, docs/08 §1.1, docs/10 §4 and §6). ExecSessions
// wraps the sandbox the tool runtime uses: it knows who started each still-running command
// (account, thread, turn, tool call), lists them for the terminal pane, kills them on request,
// and carries the `exec.sessions` settings (yield time, output cap) the exec tools read.
//
// Lifetime: a session belongs to the turn that started it, and the turn's end kills it
// (TurnTools.end -> killTurn), as in M3. A turn of a Work run or Code session that ends
// normally hands its sessions to the thread (`retainTurn`), so a later turn of the same run can
// poll them; they are killed when the run is cancelled (ChatService's TurnStarter.cancel), when
// the thread is deleted, when the run ends (`killThread`) or from the terminal pane. A thread
// holds at most 8 open sessions.
import { NovaError, type ExecSessionView } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { EventSink } from '../events.ts';
import { remoteFilesFor, type RemoteFiles } from './fs-remote.ts';
import type { ExecRequestExtras } from './sandbox.ts';
import { clip } from './text.ts';
import type { AuditSink, ExecRequest, ExecResult, SandboxClient } from './types.ts';

/** `exec.sessions` (docs/14 §1). */
export interface ExecSessionSettings {
  /** How long exec.run waits before returning a running session (default 10 s). */
  yieldMs: number;
  /** Tokens of output returned to the model per call (default 10,000). */
  outputTokens: number;
}

/**
 * Availability of the sandbox a thread's commands go to: the router's `availableFor` when the
 * sandbox routes by thread (ThreadSandboxRouter, ExecSessions over it), else its own.
 */
export function sandboxAvailableFor(
  sandbox: SandboxClient,
  accountId: string,
  threadId: string,
): Promise<{ ok: boolean; detail: string }> {
  const routed = sandbox as SandboxClient & {
    availableFor?: (
      accountId: string | null,
      threadId: string | null,
    ) => Promise<{ ok: boolean; detail: string }>;
  };
  return typeof routed.availableFor === 'function'
    ? routed.availableFor(accountId, threadId)
    : sandbox.available();
}

export const DEFAULT_EXEC_SESSION_SETTINGS: ExecSessionSettings = {
  yieldMs: 10_000,
  outputTokens: 10_000,
};

/** Open sessions per thread (a run's limit, docs/08 §1.1). */
export const MAX_SESSIONS_PER_THREAD = 8;

/** Who started a command; exec tools pass it with the request. */
export interface ExecOwner {
  accountId: string;
  threadId: string;
  turnId: string;
  callId: string | null;
}

/** What exec tools send beyond the seam's request. */
export type OwnedExecRequest = ExecRequest & ExecRequestExtras & { owner?: ExecOwner };

export interface ExecSessionsOptions {
  /** `exec.sessions`; a failing or missing value falls back to the defaults. */
  settings?: () => Promise<Partial<ExecSessionSettings> | null | undefined>;
  events?: EventSink;
  audit?: AuditSink;
  redactor?: Redactor;
  now?: () => Date;
  maxPerThread?: number;
}

interface Rec extends ExecOwner {
  id: string;
  cmd: string;
  cwd: string;
  startedAt: string;
  retained: boolean;
}

type EndReason = 'exited' | 'terminated' | 'killed' | 'cancelled' | 'turn_ended';

export class ExecSessions implements SandboxClient {
  readonly #inner: SandboxClient;
  readonly #o: ExecSessionsOptions;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #max: number;
  readonly #sessions = new Map<string, Rec>();
  /** Turns whose sessions outlive them (a run's turn that ended normally). */
  readonly #retain = new Set<string>();

  constructor(inner: SandboxClient, opts: ExecSessionsOptions = {}) {
    this.#inner = inner;
    this.#o = opts;
    this.#redactor = opts.redactor ?? defaultRedactor;
    this.#now = opts.now ?? (() => new Date());
    this.#max = opts.maxPerThread ?? MAX_SESSIONS_PER_THREAD;
  }

  get substrate(): SandboxClient['substrate'] {
    return this.#inner.substrate;
  }

  /** The sandbox underneath (hooks and terminals use it directly). */
  get inner(): SandboxClient {
    return this.#inner;
  }

  available(): Promise<{ ok: boolean; detail: string }> {
    return this.#inner.available();
  }

  /**
   * Whether the sandbox this thread's commands go to can run them (M7): a Code session or Work
   * run in a cloud, SSH or device environment runs them there, so a Hub without a sandbox of its
   * own still runs them; every other thread still needs the Hub's (fail closed).
   */
  availableFor(accountId: string, threadId: string): Promise<{ ok: boolean; detail: string }> {
    return sandboxAvailableFor(this.#inner, accountId, threadId);
  }

  /** Where this thread's files are (M7): the router underneath knows (fs-remote.ts). */
  filesFor(accountId: string, threadId: string): RemoteFiles | null | undefined {
    return remoteFilesFor(this.#inner, accountId, threadId);
  }

  /** The `exec.sessions` settings, clamped to their schema bounds. */
  async config(): Promise<ExecSessionSettings> {
    let v: Partial<ExecSessionSettings> | null | undefined;
    try {
      v = await this.#o.settings?.();
    } catch {
      v = null;
    }
    const d = DEFAULT_EXEC_SESSION_SETTINGS;
    return {
      yieldMs: clampInt(v?.yieldMs, 100, 60_000, d.yieldMs),
      outputTokens: clampInt(v?.outputTokens, 500, 50_000, d.outputTokens),
    };
  }

  async exec(req: OwnedExecRequest): Promise<ExecResult> {
    const owner = req.owner;
    if (owner && this.open(owner.threadId) >= this.#max)
      throw new NovaError(
        'validation',
        `at most ${this.#max} commands can run at once in a thread; stop one with exec.write first`,
        { details: { reason: 'too_many_sessions' } },
      );
    const r = await this.#inner.exec(req);
    if (r.status === 'running' && owner) {
      const rec: Rec = {
        ...owner,
        id: r.sessionId,
        cmd: clip(this.#redactor.redactString(req.cmd), 500),
        cwd: req.cwd,
        startedAt: this.#now().toISOString(),
        retained: false,
      };
      this.#sessions.set(rec.id, rec);
      await this.#emit('exec.session.started', rec, {
        sessionId: rec.id,
        threadId: rec.threadId,
        turnId: rec.turnId,
        callId: rec.callId,
        cmd: rec.cmd,
        cwd: rec.cwd,
      });
    }
    return r;
  }

  async poll(sessionId: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    let r: ExecResult;
    try {
      r = await this.#inner.poll(sessionId, yieldMs, signal);
    } catch (err) {
      await this.#forget(sessionId, 'exited');
      throw err;
    }
    if (r.status === 'exited') await this.#forget(sessionId, 'exited', r.exitCode);
    return r;
  }

  async write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    await this.#inner.write(sessionId, input);
    if (input.signal === 'terminate') await this.#forget(sessionId, 'terminated');
  }

  /**
   * The end of a turn (TurnTools.end): kills its sessions, unless the turn was retained, in
   * which case they now belong to the thread.
   */
  async killTurn(turnId: string): Promise<void> {
    if (this.#retain.delete(turnId)) {
      for (const s of this.#sessions.values()) if (s.turnId === turnId) s.retained = true;
      return;
    }
    const mine = [...this.#sessions.values()].filter((s) => s.turnId === turnId);
    for (const s of mine) await this.#forget(s.id, 'turn_ended');
    await this.#inner.killTurn(turnId);
  }

  /** Keep a turn's sessions after it ends: they belong to its thread (a run's turn). */
  retainTurn(turnId: string): void {
    if ([...this.#sessions.values()].some((s) => s.turnId === turnId)) this.#retain.add(turnId);
  }

  /** Kill every session of a thread (a run cancelled or ended, the thread deleted). */
  async killThread(
    accountId: string,
    threadId: string,
    reason: 'cancelled' | 'killed' = 'cancelled',
  ): Promise<number> {
    const mine = [...this.#sessions.values()].filter(
      (s) => s.accountId === accountId && s.threadId === threadId,
    );
    for (const s of mine) await this.#terminate(s, reason, 'system');
    return mine.length;
  }

  /** Kill one session from the terminal pane; false when it is not the account's. */
  async kill(accountId: string, sessionId: string): Promise<boolean> {
    const s = this.#sessions.get(sessionId);
    if (s?.accountId !== accountId) return false;
    await this.#terminate(s, 'killed', 'user');
    return true;
  }

  /** Kill every session (Hub shutdown). */
  async killAll(): Promise<void> {
    this.#sessions.clear();
    this.#retain.clear();
    const inner = this.#inner as { killAll?: () => Promise<void> };
    if (inner.killAll) await inner.killAll.call(this.#inner);
  }

  /** Who a running session belongs to, or null. */
  owner(sessionId: string): (ExecOwner & { retained: boolean }) | null {
    const s = this.#sessions.get(sessionId);
    if (!s) return null;
    return {
      accountId: s.accountId,
      threadId: s.threadId,
      turnId: s.turnId,
      callId: s.callId,
      retained: s.retained,
    };
  }

  /** Open sessions of a thread. */
  open(threadId: string): number {
    let n = 0;
    for (const s of this.#sessions.values()) if (s.threadId === threadId) n++;
    return n;
  }

  /** The account's running sessions, oldest first; one thread's when `threadId` is given. */
  list(accountId: string, threadId?: string): ExecSessionView[] {
    return [...this.#sessions.values()]
      .filter(
        (s) => s.accountId === accountId && (threadId === undefined || s.threadId === threadId),
      )
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
      .map((s) => ({
        id: s.id,
        threadId: s.threadId,
        turnId: s.turnId,
        callId: s.callId,
        cmd: s.cmd,
        cwd: s.cwd,
        startedAt: s.startedAt,
        retained: s.retained,
      }));
  }

  async #terminate(s: Rec, reason: EndReason, actor: 'user' | 'system'): Promise<void> {
    this.#sessions.delete(s.id);
    try {
      await this.#inner.write(s.id, { signal: 'terminate' });
    } catch {
      // Already gone (it exited, or its turn's end killed it).
    }
    await this.#emit('exec.session.ended', s, { sessionId: s.id, threadId: s.threadId, reason });
    try {
      await this.#o.audit?.append({
        accountId: s.accountId,
        actor,
        kind: 'tool_call',
        action: 'exec.session.kill',
        resource: s.cwd,
        decision: null,
        result: reason,
        threadId: s.threadId,
        turnId: s.turnId,
        detail: { sessionId: s.id, callId: s.callId },
      });
    } catch {
      // The audit sink reports its own failures.
    }
  }

  async #forget(sessionId: string, reason: EndReason, exitCode?: number): Promise<void> {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    this.#sessions.delete(sessionId);
    const payload: Record<string, unknown> = { sessionId, threadId: s.threadId, reason };
    if (exitCode !== undefined) payload.exitCode = exitCode;
    await this.#emit('exec.session.ended', s, payload);
  }

  async #emit(name: string, s: ExecOwner, payload: Record<string, unknown>): Promise<void> {
    if (!this.#o.events) return;
    try {
      const correlation: { threadId: string; turnId: string; callId?: string } = {
        threadId: s.threadId,
        turnId: s.turnId,
      };
      if (s.callId) correlation.callId = s.callId;
      await this.#o.events.emit({ name, accountId: s.accountId, correlation, payload });
    } catch {
      // Events are best effort here; the session itself is unaffected.
    }
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}
