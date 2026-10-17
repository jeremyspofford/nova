// Test harness for Work runs: a simulated clock with timers, and a scripted turn starter standing
// in for the chat loop (ADR-076). It asks the run extension about each turn like the loop does,
// checks the bounds before every model step, records usage after it, calls the run tools with a
// real ToolContext and reports the outcome through onEnd.
/* eslint-disable @typescript-eslint/require-await */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NovaError, uuidv7, type RunAutonomy } from '@nova/shared';
import { Logger } from '@nova/telemetry';
import {
  ArtifactService,
  RunService,
  UnavailableSandbox,
  type AuditRecord,
  type BoundHit,
  type NotificationInput,
  type RunServiceOptions,
  type StartTurnInput,
  type StartedTurn,
  type ToolContext,
  type ToolResult,
  type TurnAddition,
  type TurnOutcome,
  type TurnStarter,
  type TurnStopReason,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

export { ACCOUNT };

export class FakeClock {
  t = Date.parse('2026-10-17T09:00:00.000Z');
  #seq = 0;
  readonly #timers: { id: number; at: number; fn: () => void }[] = [];
  readonly now = () => new Date(this.t);
  readonly timers = {
    set: (fn: () => void, ms: number): unknown => {
      const id = ++this.#seq;
      this.#timers.push({ id, at: this.t + ms, fn });
      return id;
    },
    clear: (h: unknown): void => {
      const i = this.#timers.findIndex((x) => x.id === h);
      if (i >= 0) this.#timers.splice(i, 1);
    },
  };

  pending(): number {
    return this.#timers.length;
  }

  /** Move time forward, firing due timers in order. */
  async advance(ms: number, settle?: () => Promise<void>): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.#timers.sort((a, b) => a.at - b.at);
      const next = this.#timers[0];
      if (!next || next.at > end) break;
      this.#timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      if (settle) await settle();
    }
    this.t = end;
    if (settle) await settle();
  }
}

export interface ScriptResult {
  reply?: string;
  stop?: TurnStopReason;
  error?: { code: string; message: string };
}

export interface FakeTurn {
  input: StartTurnInput;
  turnId: string;
  addition: TurnAddition | null;
  signal: AbortSignal;
  /** The bound that stopped the turn, if any. */
  hit: BoundHit | null;
  /** One model step: false (and the turn must end) when a bound is reached first. */
  step(u?: { tokens?: number; costUsd?: number; activeMs?: number }): boolean;
  call(name: string, args?: unknown): Promise<ToolResult>;
  saveArtifact(title: string, content?: string): Promise<string>;
  /** Wait until the test releases this thread's turn, or it is cancelled. */
  hold(): Promise<void>;
  /** The thread waits for an approval until the returned function is called. */
  waitApproval(): Promise<() => Promise<void>>;
}

export type Script = (t: FakeTurn) => Promise<ScriptResult | undefined>;

export class FakeTurns implements TurnStarter {
  readonly started: StartTurnInput[] = [];
  readonly outcomes: TurnOutcome[] = [];
  readonly running = new Map<string, { controller: AbortController; done: Promise<TurnOutcome> }>();
  readonly #holds = new Map<string, () => void>();
  script: Script = async (t) => {
    t.step();
    return { reply: 'Done.' };
  };
  readonly env: Env;
  readonly runs: () => RunService;
  readonly artifacts: ArtifactService;

  constructor(env: Env, runs: () => RunService, artifacts: ArtifactService) {
    this.env = env;
    this.runs = runs;
    this.artifacts = artifacts;
  }

  release(threadId: string): void {
    const r = this.#holds.get(threadId);
    this.#holds.delete(threadId);
    r?.();
  }

  isHeld(threadId: string): boolean {
    return this.#holds.has(threadId);
  }

  /** Set when the test ends: no new turns start. */
  closed = false;

  async startTurn(input: StartTurnInput): Promise<StartedTurn> {
    if (this.closed) throw new NovaError('conflict', 'the loop is shutting down');
    if (this.running.has(input.threadId)) throw new NovaError('conflict', 'a turn is running');
    const db = this.env.db;
    const turnId = uuidv7();
    const messageId = uuidv7();
    const now = new Date().toISOString();
    const thread = db.raw
      .prepare('SELECT mode, project_id AS projectId FROM thread WHERE id = ?')
      .get(input.threadId) as {
      mode: 'chat' | 'work' | 'code' | 'agent';
      projectId: string | null;
    };
    const idx =
      (
        db.raw
          .prepare('SELECT COUNT(*) AS n FROM turn WHERE thread_id = ?')
          .get(input.threadId) as { n: number }
      ).n + 1;
    db.raw
      .prepare(
        `INSERT INTO turn (id, thread_id, idx, status, trigger, trigger_ref, run_id, goal_id,
           execution_location, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, 'hub', ?, ?, ?)`,
      )
      .run(
        turnId,
        input.threadId,
        idx,
        input.trigger,
        input.triggerRef ?? null,
        input.runId ?? null,
        input.goalId ?? null,
        now,
        now,
        now,
      );
    db.raw
      .prepare(
        `INSERT INTO message (id, thread_id, turn_id, role, author_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, 'user', ?, 'complete', ?, ?)`,
      )
      .run(messageId, input.threadId, turnId, input.authorKind, now, now);
    db.raw
      .prepare(
        "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, 'text', ?, ?)",
      )
      .run(uuidv7(), messageId, input.text, now);
    db.raw.prepare("UPDATE thread SET state = 'streaming' WHERE id = ?").run(input.threadId);
    this.started.push(input);
    const addition = await this.runs().extension.forTurn({
      accountId: input.accountId,
      threadId: input.threadId,
      turnId,
      mode: thread.mode,
      trigger: input.trigger,
      projectId: thread.projectId,
    });
    const controller = new AbortController();
    let steps = 0;
    let activeMs = 0;
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const fake: FakeTurn = {
      input,
      turnId,
      addition,
      signal: controller.signal,
      hit: null,
      step: (u = {}) => {
        const hit = addition?.bounds?.check() ?? null;
        if (hit) {
          fake.hit = hit;
          return false;
        }
        steps += 1;
        const s = {
          inputTokens: u.tokens ?? 100,
          outputTokens: 0,
          costUsd: u.costUsd ?? 0,
          activeMs: u.activeMs ?? 1000,
        };
        usage.inputTokens += s.inputTokens;
        usage.costUsd += s.costUsd;
        activeMs += s.activeMs;
        addition?.bounds?.record(s);
        return true;
      },
      call: async (name, args = {}) => {
        const list = await this.runs().toolSource.list(input.accountId);
        const tool = list.find((t) => t.descriptor.name === name);
        if (!tool) throw new Error(`no tool ${name}`);
        const ctx: ToolContext = {
          accountId: input.accountId,
          threadId: input.threadId,
          turnId,
          callId: uuidv7(),
          projectId: thread.projectId,
          origin: 'model',
          profile: { id: 'workspace', hash: 'x' },
          roots: [],
          sandbox: new UnavailableSandbox(),
          signal: controller.signal,
          log: new Logger({ module: 'test', sinks: [] }),
        };
        return tool.handler(args, ctx);
      },
      saveArtifact: async (title, content = '# Report\n\nText [1].\n\n1. https://example.org') => {
        const v = await this.artifacts.save({
          accountId: input.accountId,
          threadId: input.threadId,
          messageId: null,
          kind: 'markdown',
          title,
          content,
        });
        return v.id;
      },
      hold: () =>
        new Promise<void>((resolve) => {
          if (controller.signal.aborted) return resolve();
          this.#holds.set(input.threadId, resolve);
          controller.signal.addEventListener('abort', () => {
            this.#holds.delete(input.threadId);
            resolve();
          });
        }),
      waitApproval: async () => {
        db.raw
          .prepare("UPDATE thread SET state = 'waiting_approval' WHERE id = ?")
          .run(input.threadId);
        await this.runs().onThreadStatus(input.threadId, 'needs_input');
        return async () => {
          db.raw.prepare("UPDATE thread SET state = 'streaming' WHERE id = ?").run(input.threadId);
          await this.runs().onThreadStatus(input.threadId, 'running');
        };
      },
    };
    const done = (async (): Promise<TurnOutcome> => {
      await Promise.resolve();
      let res: ScriptResult | undefined;
      try {
        res = await this.script(fake);
      } catch (err) {
        res = { stop: 'error', error: { code: 'error', message: String(err) } };
      }
      let stop: TurnStopReason = res?.stop ?? 'end';
      if (fake.hit) stop = 'budget';
      if (controller.signal.aborted) stop = 'cancelled';
      const outcome: TurnOutcome = {
        turnId,
        status: stop === 'end' ? 'completed' : stop === 'error' ? 'failed' : 'interrupted',
        stop,
        replyText: res?.reply ?? '',
        steps,
        usage,
        activeMs,
      };
      if (fake.hit) outcome.bound = fake.hit;
      if (res?.error) outcome.error = res.error;
      const end = new Date().toISOString();
      db.raw
        .prepare(
          'UPDATE turn SET status = ?, stop_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(outcome.status, stop, end, end, turnId);
      db.raw.prepare("UPDATE thread SET state = 'idle' WHERE id = ?").run(input.threadId);
      this.running.delete(input.threadId);
      this.outcomes.push(outcome);
      await addition?.onEnd?.(outcome);
      return outcome;
    })();
    this.running.set(input.threadId, { controller, done });
    return { turnId, messageId, done };
  }

  async cancel(_accountId: string, threadId: string): Promise<void> {
    const r = this.running.get(threadId);
    if (!r) return;
    r.controller.abort();
    await r.done.catch(() => undefined);
  }
}

export interface RunsEnv {
  env: Env;
  runs: RunService;
  turns: FakeTurns;
  clock: FakeClock;
  artifacts: ArtifactService;
  audit: AuditRecord[];
  notes: NotificationInput[];
  settings: {
    budgets: { timeSeconds: number; tokens: number; costUsd: number | null };
    autonomy: RunAutonomy;
    subagents: { maxChildren: number; maxConcurrent: number };
    escalation: 'propose' | 'auto' | 'off';
  };
  dataDir: string;
  /** Wait until no scripted turn runs and the supervisor is idle. */
  settle(): Promise<void>;
  /** A second supervisor on the same database (a Hub restart). */
  restart(opts?: Partial<RunServiceOptions>): RunService;
  close(): Promise<void>;
}

export async function makeRunsEnv(opts: Partial<RunServiceOptions> = {}): Promise<RunsEnv> {
  const env = await makeEnv();
  const dataDir = join(env.dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const clock = new FakeClock();
  const artifacts = new ArtifactService({ db: env.db, events: env.events, dataDir });
  const audit: AuditRecord[] = [];
  const notes: NotificationInput[] = [];
  const settings: RunsEnv['settings'] = {
    budgets: { timeSeconds: 3600, tokens: 2_000_000, costUsd: null },
    autonomy: 'standard',
    subagents: { maxChildren: 6, maxConcurrent: 4 },
    escalation: 'propose',
  };
  const build = (extra: Partial<RunServiceOptions> = {}) =>
    new RunService({
      db: env.db,
      events: env.events,
      threads: env.threads,
      settings: {
        defaultBudgets: async () => settings.budgets,
        autonomy: async () => settings.autonomy,
        subagents: async () => settings.subagents,
        escalation: async () => settings.escalation,
      },
      audit: { append: async (r) => void audit.push(r) },
      notifier: { notify: async (n) => void notes.push(n) },
      dataDir,
      now: clock.now,
      timers: clock.timers,
      ...opts,
      ...extra,
    });
  let runs = build();
  const turns = new FakeTurns(env, () => runs, artifacts);
  runs.useTurns(turns);
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      const waits = [...turns.running.values()].map((r) => r.done);
      await Promise.allSettled(waits);
      await runs.idle();
      await new Promise((r) => setImmediate(r));
      if (!turns.running.size) {
        await runs.idle();
        return;
      }
    }
  };
  return {
    env,
    get runs() {
      return runs;
    },
    turns,
    clock,
    artifacts,
    audit,
    notes,
    settings,
    dataDir,
    settle,
    restart: (extra) => {
      runs = build(extra);
      runs.useTurns(turns);
      return runs;
    },
    close: async () => {
      turns.closed = true;
      for (const t of turns.running.values()) t.controller.abort();
      await settle();
      await runs.close();
      await env.close();
    },
  };
}

/** Event names recorded by the in-memory sink, filtered by prefix. */
export function eventNames(env: Env, prefix: string): string[] {
  return env.events.names().filter((n) => n.startsWith(prefix));
}
