// A conversation engine for the M5 loop tests (docs/09 §2, §11): the built-in tools plus the
// context tools sharing a tracker with the loop, an ExecSessions over a scripted sandbox,
// extensions, an audit log and a simulated clock the test advances.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MockProviderOptions } from '@nova/providers';
import {
  ArtifactService,
  ExecSessions,
  ToolRegistry,
  ToolRuntime,
  TurnContextTracker,
  allowAllGate,
  builtinSource,
  builtinTools,
  contextTools,
  type AuditRecord,
  type BoundHit,
  type ContextOptions,
  type ExecRequest,
  type ExecResult,
  type HookDispatcher,
  type ProviderFactory,
  type SandboxClient,
  type ToolDefinition,
  type ToolSourceProvider,
  type ToolGate,
  type TurnAddition,
  type TurnBounds,
  type TurnExtension,
  type TurnOutcome,
  type TurnUsage,
} from '../src/index.ts';
import { makeEnv, type Env } from './helpers.ts';

/** A clock the test moves; the loop measures active time with it. */
export class TestClock {
  ms = Date.UTC(2026, 9, 17, 12, 0, 0);
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

interface FakeSession {
  id: string;
  turnId: string | null;
  cmd: string;
  output: string[];
  exited: number | null;
}

/**
 * A sandbox whose commands are scripted: `sleep` and `serve` keep running, `exit <n>` exits
 * with n, anything else exits 0 and echoes. `say <text>` writes output a later poll returns.
 */
export class FakeSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly sessions = new Map<string, FakeSession>();
  readonly killed: string[] = [];
  readonly killedTurns: string[] = [];
  readonly writes: { id: string; input: unknown }[] = [];
  readonly execs: ExecRequest[] = [];
  #n = 0;

  available(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: true, detail: 'fake' });
  }

  exec(req: ExecRequest & { turnId?: string }): Promise<ExecResult> {
    this.execs.push(req);
    const cmd = req.cmd.trim();
    if (cmd.startsWith('sleep') || cmd.startsWith('serve')) {
      const id = `s${++this.#n}`;
      this.sessions.set(id, { id, turnId: req.turnId ?? null, cmd, output: [], exited: null });
      return Promise.resolve({ status: 'running', sessionId: id, output: `started ${cmd}\n` });
    }
    const exit = /^exit (\d+)$/.exec(cmd);
    if (exit) return Promise.resolve({ status: 'exited', exitCode: Number(exit[1]), output: '' });
    return Promise.resolve({ status: 'exited', exitCode: 0, output: `${cmd}\n` });
  }

  poll(sessionId: string): Promise<ExecResult> {
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.reject(Object.assign(new Error('gone'), { code: 'not_found' }));
    const output = s.output.splice(0).join('');
    if (s.exited !== null) {
      this.sessions.delete(sessionId);
      return Promise.resolve({ status: 'exited', exitCode: s.exited, output });
    }
    return Promise.resolve({ status: 'running', sessionId, output });
  }

  write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    this.writes.push({ id: sessionId, input });
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.reject(Object.assign(new Error('gone'), { code: 'not_found' }));
    if (input.text) s.output.push(`got ${input.text}`);
    if (input.signal === 'terminate') {
      this.sessions.delete(sessionId);
      this.killed.push(sessionId);
    }
    return Promise.resolve();
  }

  killTurn(turnId: string): Promise<void> {
    this.killedTurns.push(turnId);
    for (const s of [...this.sessions.values()]) {
      if (s.turnId !== turnId) continue;
      this.sessions.delete(s.id);
      this.killed.push(s.id);
    }
    return Promise.resolve();
  }
}

/** Bounds that count what the loop records and hit a limit the test sets. */
export class TestBounds implements TurnBounds {
  readonly records: (TurnUsage & { activeMs: number })[] = [];
  checks = 0;
  tokens = 0;
  activeMs = 0;
  /** Hit `tokens` once the recorded tokens reach this. */
  tokenLimit = Infinity;
  /** Hit `time` once active time reaches this. */
  timeLimitMs = Infinity;
  /** Throw from check (a broken extension). */
  fail = false;

  check(): BoundHit | null {
    this.checks++;
    if (this.fail) throw new Error('bounds unavailable');
    if (this.tokens >= this.tokenLimit)
      return { bound: 'tokens', used: this.tokens, limit: this.tokenLimit };
    if (this.activeMs >= this.timeLimitMs)
      return { bound: 'time', used: this.activeMs, limit: this.timeLimitMs };
    return null;
  }

  record(step: TurnUsage & { activeMs: number }): void {
    this.records.push(step);
    this.tokens += step.inputTokens + step.outputTokens;
    this.activeMs += step.activeMs;
  }
}

/** An extension the test scripts; it records every forTurn and every onEnd. */
export class TestExtension implements TurnExtension {
  readonly calls: Parameters<TurnExtension['forTurn']>[0][] = [];
  readonly ends: TurnOutcome[] = [];
  addition: (input: Parameters<TurnExtension['forTurn']>[0]) => TurnAddition | null = () => null;
  throws = false;

  forTurn(input: Parameters<TurnExtension['forTurn']>[0]): Promise<TurnAddition | null> {
    this.calls.push(input);
    if (this.throws) return Promise.reject(new Error('the run store is unavailable'));
    const a = this.addition(input);
    if (!a) return Promise.resolve(null);
    return Promise.resolve({
      ...a,
      onEnd: async (o: TurnOutcome) => {
        this.ends.push(o);
        await a.onEnd?.(o);
      },
    });
  }
}

export interface M5EnvOptions {
  mock?: MockProviderOptions;
  /** Providers other than the default mock (a second kind for model summaries). */
  factory?: ProviderFactory;
  extensions?: TurnExtension[];
  hooks?: HookDispatcher;
  gate?: ToolGate;
  sandbox?: SandboxClient;
  context?: Omit<ContextOptions, 'tracker'>;
  /** No tool runtime at all. */
  noTools?: boolean;
  clock?: TestClock;
  /** More built-in tools (a mode's or another area's). */
  builtins?: ToolDefinition[];
  /** Tool sources after the built-ins (MCP, plugins, scoped mode tools). */
  sources?: ToolSourceProvider[];
}

export interface M5Env extends Env {
  runtime: ToolRuntime | null;
  sessions: ExecSessions | null;
  tracker: TurnContextTracker;
  workspace: string;
  audit: AuditRecord[];
}

export async function makeM5Env(opts: M5EnvOptions = {}): Promise<M5Env> {
  const tracker = new TurnContextTracker();
  const audit: AuditRecord[] = [];
  let runtime: ToolRuntime | null = null;
  let sessions: ExecSessions | null = null;
  let workspace = '';
  const sink = { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) };
  const env = await makeEnv({
    ...(opts.mock ? { mock: opts.mock } : {}),
    ...(opts.factory ? { factory: opts.factory } : {}),
    chat: {
      audit: sink,
      context: { tracker, ...opts.context },
      ...(opts.extensions ? { extensions: opts.extensions } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.clock ? { now: opts.clock.now } : {}),
    },
    ...(opts.noTools
      ? {}
      : {
          tools: ({ db, events, dataDir }) => {
            workspace = join(dataDir, 'workspace');
            mkdirSync(workspace, { recursive: true });
            const artifacts = new ArtifactService({ db, events, dataDir });
            const searxngUrl = () => Promise.resolve(null);
            const builtins = [
              ...builtinTools({
                artifacts,
                searxngUrl,
                paths: { denied: [dataDir], allowed: [workspace] },
              }),
              ...contextTools(tracker),
            ];
            const extra: ToolSourceProvider = {
              source: 'builtin',
              list: () => Promise.resolve(opts.builtins ?? []),
            };
            sessions = new ExecSessions(opts.sandbox ?? new FakeSandbox(), {
              events,
              audit: sink,
            });
            runtime = new ToolRuntime({
              db,
              events,
              gate: opts.gate ?? allowAllGate,
              registry: new ToolRegistry({
                sources: [builtinSource(builtins, searxngUrl), extra, ...(opts.sources ?? [])],
              }),
              sandbox: sessions,
              audit: sink,
              scope: () =>
                Promise.resolve({
                  roots: [{ path: workspace, access: 'write', label: 'Workspace' }],
                  profile: { id: 'workspace', hash: 'test-hash' },
                  network: 'off',
                }),
              paths: { denied: [dataDir], allowed: [workspace] },
              ...(opts.hooks ? { hooks: opts.hooks } : {}),
            });
            return runtime;
          },
        }),
  });
  return { ...env, runtime, sessions, tracker, workspace, audit };
}

/** Rows of a thread's turns, oldest first. */
export function turnRows(env: Env, threadId: string) {
  return env.db.raw
    .prepare(
      `SELECT id, idx, status, trigger, trigger_ref AS triggerRef, run_id AS runId,
         goal_id AS goalId, stop_reason AS stopReason, step_count AS steps, usage_json AS usage
       FROM turn WHERE thread_id = ? ORDER BY idx`,
    )
    .all(threadId) as {
    id: string;
    idx: number;
    status: string;
    trigger: string;
    triggerRef: string | null;
    runId: string | null;
    goalId: string | null;
    stopReason: string | null;
    steps: number;
    usage: string | null;
  }[];
}

/** A tool call as a scripted mock step (one call per step). */
export function callStep(id: string, name: string, args: unknown) {
  return [
    { type: 'tool_call_start' as const, index: 0, id, name },
    { type: 'tool_call_delta' as const, index: 0, argsDelta: JSON.stringify(args) },
    { type: 'tool_call_end' as const, index: 0, args },
    { type: 'usage' as const, inputTokens: 100, outputTokens: 10, costUsd: 0 },
    { type: 'stop' as const, reason: 'tool_calls' as const },
  ];
}
