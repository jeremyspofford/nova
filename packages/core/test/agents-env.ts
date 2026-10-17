// Test harness for always-on agents: a simulated clock, a scripted turn starter standing in for
// the chat loop (it asks the agent extension about each turn like the loop does, checks the
// bounds before every model step and reports the outcome through onEnd), a real ScheduleService
// on the same clock, and Work runs that only record what the agents area asks of them.
/* eslint-disable @typescript-eslint/require-await */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NovaError, uuidv7, type RunAutonomy } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { Logger } from '@nova/telemetry';
import {
  AgentService,
  ScheduleService,
  UnavailableSandbox,
  type AgentRuns,
  type AgentServiceOptions,
  type AuditRecord,
  type BoundHit,
  type CreateRunInput,
  type NotificationInput,
  type RunFinish,
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
import { FakeClock } from './runs-env.ts';

export { ACCOUNT, FakeClock };

export interface ScriptResult {
  reply?: string;
  stop?: TurnStopReason;
  error?: { code: string; message: string };
}

export interface AgentTurn {
  input: StartTurnInput;
  turnId: string;
  addition: TurnAddition | null;
  /** The extension refused the turn (a paused agent): the loop shows the reason. */
  refused: string | null;
  signal: AbortSignal;
  hit: BoundHit | null;
  step(u?: { tokens?: number; costUsd?: number; activeMs?: number }): boolean;
  call(name: string, args?: unknown): Promise<ToolResult>;
  hold(): Promise<void>;
}

export type Script = (t: AgentTurn) => Promise<ScriptResult | undefined>;

export class FakeAgentTurns implements TurnStarter {
  readonly started: (StartTurnInput & { turnId: string })[] = [];
  readonly outcomes: TurnOutcome[] = [];
  readonly turns: AgentTurn[] = [];
  readonly running = new Map<string, { controller: AbortController; done: Promise<TurnOutcome> }>();
  readonly #holds = new Map<string, () => void>();
  script: Script = async (t) => {
    t.step();
    return { reply: 'Done.' };
  };
  closed = false;
  readonly env: Env;
  readonly agents: () => AgentService;

  constructor(env: Env, agents: () => AgentService) {
    this.env = env;
    this.agents = agents;
  }

  release(threadId: string): void {
    const r = this.#holds.get(threadId);
    this.#holds.delete(threadId);
    r?.();
  }

  /** The user types in a thread (trigger `user`, the user's authority). */
  type(threadId: string, text: string): Promise<StartedTurn> {
    return this.startTurn({
      accountId: ACCOUNT,
      threadId,
      text,
      trigger: 'user',
      authority: { kind: 'user', source: 'composer' },
      authorKind: 'user',
    });
  }

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
          .get(input.threadId) as {
          n: number;
        }
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
    const typed = input.authority.kind === 'user' && input.authorKind === 'user';
    db.raw
      .prepare(
        `INSERT INTO message (id, thread_id, turn_id, role, author_kind, provenance, status,
           created_at, updated_at)
         VALUES (?, ?, ?, 'user', ?, ?, 'complete', ?, ?)`,
      )
      .run(messageId, input.threadId, turnId, input.authorKind, typed ? 'typed' : 'tool', now, now);
    db.raw
      .prepare(
        "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, 'text', ?, ?)",
      )
      .run(uuidv7(), messageId, input.text, now);
    db.raw.prepare("UPDATE thread SET state = 'streaming' WHERE id = ?").run(input.threadId);
    this.started.push({ ...input, turnId });
    let addition: TurnAddition | null = null;
    let refused: string | null = null;
    try {
      addition = await this.agents().extension.forTurn({
        accountId: input.accountId,
        threadId: input.threadId,
        turnId,
        mode: thread.mode,
        trigger: input.trigger,
        projectId: thread.projectId,
      });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    const controller = new AbortController();
    let steps = 0;
    let activeMs = 0;
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const fake: AgentTurn = {
      input,
      turnId,
      addition,
      refused,
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
        const list = await this.agents().toolSource.list(input.accountId, {
          threadId: input.threadId,
          mode: thread.mode,
        });
        const tool = list.find((t) => t.descriptor.name === name);
        if (!tool) return { ok: false, error: { code: 'unknown_tool', message: name } };
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
      hold: () =>
        new Promise<void>((resolve) => {
          if (controller.signal.aborted) return resolve();
          this.#holds.set(input.threadId, resolve);
          controller.signal.addEventListener('abort', () => {
            this.#holds.delete(input.threadId);
            resolve();
          });
        }),
    };
    this.turns.push(fake);
    const done = (async (): Promise<TurnOutcome> => {
      await Promise.resolve();
      let res: ScriptResult | undefined;
      if (refused) res = { stop: 'error', error: { code: 'extension_failed', message: refused } };
      else {
        try {
          res = await this.script(fake);
        } catch (err) {
          res = { stop: 'error', error: { code: 'error', message: String(err) } };
        }
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

/** Work runs that record what the agents area asks: delegation, pause, resume, cancel. */
export class FakeRuns implements AgentRuns {
  readonly created: (CreateRunInput & { agentId?: string | null })[] = [];
  readonly calls: string[] = [];
  readonly #done = new Map<string, (f: RunFinish) => void>();
  readonly #waits = new Map<string, Promise<RunFinish>>();
  readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async createRun(input: CreateRunInput & { agentId?: string | null }) {
    this.created.push(input);
    const thread = await this.env.threads.create(ACCOUNT, { mode: 'work', title: input.title });
    const runId = uuidv7();
    const now = new Date().toISOString();
    this.env.db.raw
      .prepare(
        `INSERT INTO run (id, account_id, thread_id, agent_id, origin, origin_ref, title, objective,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        runId,
        input.accountId,
        thread.id,
        input.agentId ?? null,
        input.origin,
        input.originRef ?? null,
        input.title ?? 'run',
        input.objective,
        now,
        now,
      );
    this.#waits.set(runId, new Promise((resolve) => this.#done.set(runId, resolve)));
    return { runId, threadId: thread.id };
  }

  whenFinished(_accountId: string, runId: string) {
    return this.#waits.get(runId) ?? new Promise<RunFinish>(() => undefined);
  }

  finish(runId: string, summary = 'All done.') {
    this.env.db.raw.prepare("UPDATE run SET status = 'done' WHERE id = ?").run(runId);
    this.#done.get(runId)?.({ runId, status: 'done', summary, artifactIds: [] });
  }

  async pause(_accountId: string, runId: string) {
    this.calls.push(`pause:${runId}`);
    this.env.db.raw
      .prepare("UPDATE run SET status = 'paused', pause_reason = 'user' WHERE id = ?")
      .run(runId);
  }

  async resume(_accountId: string, runId: string) {
    this.calls.push(`resume:${runId}`);
    this.env.db.raw
      .prepare("UPDATE run SET status = 'running', pause_reason = NULL WHERE id = ?")
      .run(runId);
  }

  async cancel(_accountId: string, runId: string) {
    this.calls.push(`cancel:${runId}`);
    this.env.db.raw
      .prepare("UPDATE run SET status = 'cancelled', pause_reason = NULL WHERE id = ?")
      .run(runId);
  }
}

export interface AgentsEnv {
  env: Env;
  agents: AgentService;
  turns: FakeAgentTurns;
  runs: FakeRuns;
  scheduler: ScheduleService;
  clock: FakeClock;
  audit: AuditRecord[];
  notes: NotificationInput[];
  settings: {
    budgets: { timeSeconds: number; tokens: number; costUsd: number | null };
    autonomy: RunAutonomy;
    proactive: { enabledByDefault: boolean; intervalMinutes: number };
    wakes: { minMinutes: number; horizonDays: number; perDay: number };
    reviewModel: string | null;
  };
  quiet: { window: { start: string; end: string } | null };
  dataDir: string;
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function makeAgentsEnv(opts: Partial<AgentServiceOptions> = {}): Promise<AgentsEnv> {
  const env = await makeEnv();
  const dataDir = join(env.dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const clock = new FakeClock();
  const audit: AuditRecord[] = [];
  const notes: NotificationInput[] = [];
  const settings: AgentsEnv['settings'] = {
    budgets: { timeSeconds: 1800, tokens: 500_000, costUsd: null },
    autonomy: 'standard',
    proactive: { enabledByDefault: true, intervalMinutes: 60 },
    wakes: { minMinutes: 5, horizonDays: 30, perDay: 24 },
    reviewModel: null,
  };
  const quiet: AgentsEnv['quiet'] = { window: null };
  const agents = new AgentService({
    db: env.db,
    events: env.events,
    threads: env.threads,
    dataDir,
    settings: {
      defaultBudgets: async () => settings.budgets,
      autonomy: async () => settings.autonomy,
      proactive: async () => settings.proactive,
      wakes: async () => settings.wakes,
      reviewModel: async () => settings.reviewModel,
    },
    audit: { append: async (r) => void audit.push(r) },
    notifier: { notify: async (n) => void notes.push(n) },
    now: clock.now,
    timers: clock.timers,
    goalDebounceMs: 5_000,
    ...opts,
  });
  const turns = new FakeAgentTurns(env, () => agents);
  const runs = new FakeRuns(env);
  const scheduler = new ScheduleService({
    db: env.db,
    events: env.events,
    secrets: new MemorySecretStore(),
    audit: { append: async (r) => void audit.push(r as AuditRecord) },
    now: clock.now,
    timers: { setTimeout: clock.timers.set, clearTimeout: clock.timers.clear },
  });
  agents.useTurns(turns);
  agents.useRuns(runs);
  agents.useScheduler(scheduler);
  agents.useQuietHours(async (_accountId, at) => {
    const w = quiet.window;
    if (!w) return null;
    const t = at.getTime();
    return t >= Date.parse(w.start) && t < Date.parse(w.end) ? w : null;
  });
  scheduler.useAgents(agents.scheduleTarget);
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await Promise.allSettled([...turns.running.values()].map((r) => r.done));
      await agents.idle();
      await scheduler.idle();
      await new Promise((r) => setImmediate(r));
      if (!turns.running.size) {
        await agents.idle();
        return;
      }
    }
  };
  return {
    env,
    agents,
    turns,
    runs,
    scheduler,
    clock,
    audit,
    notes,
    settings,
    quiet,
    dataDir,
    settle,
    close: async () => {
      turns.closed = true;
      for (const t of turns.running.values()) t.controller.abort();
      await settle();
      await scheduler.stop();
      await agents.close();
      await env.close();
    },
  };
}

/** Event names recorded by the in-memory sink, filtered by prefix. */
export function eventNames(env: Env, prefix: string): string[] {
  return env.events.names().filter((n) => n.startsWith(prefix));
}
