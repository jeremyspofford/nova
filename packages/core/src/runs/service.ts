// The Work run supervisor (docs/09 §1-§4, §9, §12, §13; FR-051..FR-054, FR-057, FR-058, FR-181,
// FR-182, FR-186, FR-187, FR-220). A run is a `work` thread plus a `run` row; its turns run in the
// one chat loop through the late-bound TurnStarter (ADR-076). The supervisor owns the lifecycle:
// autonomy and the plan, budgets checked before every model step (TurnBounds), pauses with a
// progress summary, verified outcomes, the goal with its blocked rule and idle continuation,
// sub-agents with their limits and queue, chat escalation, and resuming after a restart.
//
// Locking: every state change of a run happens under the run's lock. Starting or cancelling a
// turn happens outside it, because a turn's end calls back into the supervisor (onEnd), which
// takes the lock again.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type BudgetAmounts,
  type ExpectedOutput,
  type GoalStatus,
  type GoalView,
  type Page,
  type RunAutonomy,
  type RunPauseReason,
  type RunStatus,
  type RunView,
  type StatusView,
  type SubagentView,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type {
  BoundHit,
  ContextBlock,
  CreateRunInput,
  RunFinish,
  RunStarter,
  StartTurnInput,
  ThreadPolicy,
  ThreadPolicySource,
  ThreadStatusSource,
  TurnAddition,
  TurnExtension,
  TurnOutcome,
  TurnStarter,
  TurnTrigger,
} from '../runtime/types.ts';
import { titleFrom, type ThreadService } from '../threads.ts';
import { argsOf, fail, num, ok, str } from '../tools/builtin.ts';
import { resolveInRoots } from '../tools/roots.ts';
import type {
  AuditRecord,
  AuditSink,
  Notifier,
  Origin,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolRoot,
  ToolSourceProvider,
} from '../tools/types.ts';
import {
  BLOCKED_AFTER,
  checkAgentStatus,
  goalHit,
  goalLimits,
  nextBlockerCount,
  normalizeBlockerKey,
  remainingText,
  userTransition,
  type GoalLimits,
} from './goals.ts';
import {
  CHILDREN_DONE_TEXT,
  DEEP_RESEARCH,
  PAUSE_WORDS,
  READ_ONLY_TOOLS,
  START_TEXT,
  clipText,
  continueText,
  formatPlan,
  goalContinuationText,
  howToRun,
  progressSummary,
  subagentBrief,
} from './prompts.ts';
import { MAX_WAIT_SECONDS, runTools, type RunToolHost, type RunTools } from './tools.ts';
import {
  isFinal,
  parseJson,
  toGoalView,
  toRunView,
  toStepView,
  toSubagentView,
  type GoalRow,
  type RunResult,
  type RunRow,
  type RunStepRow,
  type SubagentRow,
  type Usage,
} from './views.ts';

const { run: runT, goal: goalT, runStep: stepT, subagent: subT } = schema;

/** Settings the supervisor reads per project (docs/14 §1). */
export interface RunSettings {
  defaultBudgets(
    projectId: string | null,
  ): Promise<{ timeSeconds: number; tokens: number; costUsd: number | null }>;
  autonomy(projectId: string | null): Promise<RunAutonomy>;
  subagents(projectId: string | null): Promise<{ maxChildren: number; maxConcurrent: number }>;
  escalation(projectId: string | null): Promise<'propose' | 'auto' | 'off'>;
}

/** Timer functions, replaced by a simulated clock in tests. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/**
 * Verifies a scheduled run's `message` output with the delivery receipt (FR-187): the scheduler
 * delivers the result and answers whether a provider receipt came back (or that its notification
 * condition was not met, which counts as verified "no news").
 */
export type DeliveryCheck = (input: {
  accountId: string;
  runId: string;
  originRef: string | null;
  summary: string;
}) => Promise<{ ok: true; evidence: string } | { ok: false; reason: string }>;

export interface RunServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  threads: ThreadService;
  settings: RunSettings;
  audit?: AuditSink;
  notifier?: Notifier;
  /** The roots of a thread, for `file` outputs (FR-187). */
  roots?: (accountId: string, threadId: string, projectId: string | null) => Promise<ToolRoot[]>;
  /** Where artifact blobs live; when set, a saved artifact's blob must exist. */
  dataDir?: string;
  log?: Logger;
  now?: () => Date;
  timers?: Timers;
  /** Idle time before a goal continuation starts (docs/09 §2.1): 5 s. */
  goalDebounceMs?: number;
  /** When a run paused on a provider usage limit is tried again: 15 min. */
  usageRetryMs?: number;
  /** Consecutive failed turns before a run fails instead of pausing: 3. */
  maxErrors?: number;
}

/** The derived status of threads, from the shared thread status service (FR-215). */
export type StatusLookup = (
  accountId: string,
  threadIds: string[],
) => Promise<Map<string, StatusView>>;

/** POST /runs and the RunStarter seam, plus what only the Hub's own callers pass. */
export interface CreateRunOptions extends CreateRunInput {
  /**
   * M6: the always-on agent that delegated the run (FR-059, FR-083): recorded as run.agent_id, so
   * pausing or deleting the agent reaches it. A child run inherits its parent's.
   */
  agentId?: string | null;
  template?: 'deep_research';
  goal?: { objective: string; budgets?: BudgetAmounts };
  plan?: { title: string; detail?: string }[];
  attachmentIds?: string[];
}

export interface ListRunsQuery {
  status?: 'active' | 'all';
  projectId?: string;
  cursor?: string;
  limit?: number;
}

interface ActiveTurn {
  turnId: string;
  /** Whether the turn carries an instruction the signed-in user typed (FR-189). */
  authority: 'user' | 'none';
  trigger: TurnTrigger;
  /** run.complete was called in this turn. */
  complete: boolean;
  /** The blocker key this goal turn reported. */
  blocker: string | null;
  /** A sub-agent's result from run.complete. */
  result: string | null;
}

interface Meter {
  runId: string;
  parent: string | null;
  limits: { timeMs: number; tokens: number; costUsd: number | null };
  used: Usage;
  goal: { id: string; limits: GoalLimits; used: Usage } | null;
}

type ThreadKind =
  { kind: 'run'; run: RunRow } | { kind: 'child'; run: RunRow; sub: SubagentRow } | null;

/** Input waiting for the running turn to end; `user` when the user typed or pressed it. */
interface PendingInput {
  text: string;
  user: boolean;
}

/** A turn to start once the run's lock is released. */
type Next = (() => Promise<void>) | null;

interface TurnPlan {
  threadId: string;
  text: string;
  trigger: TurnTrigger;
  triggerRef?: string | null;
  authority: StartTurnInput['authority'];
  authorKind: StartTurnInput['authorKind'];
  goalId?: string | null;
  attachmentIds?: string[];
}

const ACTIVE_STATUSES: RunStatus[] = ['planning', 'running', 'waiting_approval', 'paused'];
const LIVE: ReadonlySet<RunStatus> = new Set(['running', 'waiting_approval']);
const ORIGINS: ReadonlySet<string> = new Set<Origin>([
  'user',
  'tool',
  'page',
  'file',
  'email',
  'channel',
  'mcp',
  'plugin',
  'memory',
  'capture',
  'external_agent',
  'system',
]);
const TOOL_NAME = /^[a-z][a-z0-9_.:-]{0,199}$/i;
const MAX_HANDLED = 2000;

/** Approval policy of a run's autonomy level (docs/09 §10, docs/12 §2.1). */
const AUTONOMY_POLICY = {
  ask_first: 'ask_always',
  standard: 'defaults',
  autonomous: 'review',
} as const;

export class RunService implements RunToolHost {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #threads: ThreadService;
  readonly #settings: RunSettings;
  readonly #audit: AuditSink | undefined;
  readonly #notifier: Notifier | undefined;
  readonly #roots: RunServiceOptions['roots'];
  readonly #dataDir: string | undefined;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #timers: Timers;
  readonly #debounceMs: number;
  readonly #usageRetryMs: number;
  readonly #maxErrors: number;
  readonly #tools: RunTools;
  #turns: TurnStarter | null = null;
  #delivery: DeliveryCheck | null = null;
  #statusOf: StatusLookup | null = null;
  #reviewReset: ((key: string) => void) | null = null;
  #closed = false;
  /** Turns running on run and sub-agent threads, by thread. */
  readonly #active = new Map<string, ActiveTurn>();
  /** Turns the supervisor is starting, until the loop asks the extension about them. */
  readonly #pending = new Map<string, { authority: 'user' | 'none'; trigger: TurnTrigger }>();
  /** Turns the loop queued behind a running one (it starts them when the thread is free). */
  readonly #queued = new Map<
    string,
    { threadId: string; authority: 'user' | 'none'; trigger: TurnTrigger }
  >();
  /** Threads whose turn the supervisor cancelled itself (pause, cancel). */
  readonly #cancelling = new Set<string>();
  readonly #handled = new Set<string>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #meters = new Map<string, Meter>();
  readonly #flushes = new Map<string, Promise<void>>();
  readonly #finishWaiters = new Map<string, ((f: RunFinish) => void)[]>();
  readonly #subWaiters = new Map<string, Set<() => void>>();
  readonly #goalTimers = new Map<string, unknown>();
  readonly #retryTimers = new Map<string, unknown>();
  readonly #background = new Set<Promise<unknown>>();

  /** Shapes every turn on run and sub-agent threads; offers work.start in chats (FR-186). */
  readonly extension: TurnExtension;
  /** For the scheduler, chat escalation and delegation (FR-059). */
  readonly starter: RunStarter;
  /** Blocked run threads and sub-agent threads, for the derived thread status (FR-215). */
  readonly status: ThreadStatusSource;
  /** A run's autonomy as an approval policy for the gate (docs/09 §10). */
  readonly policy: ThreadPolicySource;
  /**
   * Every run tool as one source. The handlers refuse calls outside their threads, so this works
   * without per-turn tools; with them, `extension` offers each thread only its own.
   */
  readonly toolSource: ToolSourceProvider;

  constructor(opts: RunServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#threads = opts.threads;
    this.#settings = opts.settings;
    this.#audit = opts.audit;
    this.#notifier = opts.notifier;
    this.#roots = opts.roots;
    this.#dataDir = opts.dataDir;
    this.#log = opts.log ?? new Logger({ module: 'core.runs', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#timers = opts.timers ?? realTimers;
    this.#debounceMs = opts.goalDebounceMs ?? 5_000;
    this.#usageRetryMs = opts.usageRetryMs ?? 15 * 60_000;
    this.#maxErrors = opts.maxErrors ?? 3;
    this.#tools = runTools(this);
    this.extension = { forTurn: (input) => this.#forTurn(input) };
    this.starter = {
      createRun: async (input) => {
        const row = await this.#create(input);
        return { runId: row.id, threadId: row.threadId };
      },
      whenFinished: (accountId, runId) => this.whenFinished(accountId, runId),
    };
    this.status = {
      blocked: (accountId, threadIds) => this.#blockedThreads(accountId, threadIds),
      children: async (accountId, threadId) => {
        const row = await this.#runByThread(threadId);
        if (row?.accountId !== accountId) return [];
        return (await this.#subs(row.id)).flatMap((s) => (s.threadId ? [s.threadId] : []));
      },
    };
    this.policy = { forThread: (accountId, threadId) => this.#threadPolicy(accountId, threadId) };
    const all = this.#tools.all;
    this.toolSource = {
      source: 'builtin',
      // Per turn, each thread gets only its own run tools; without a scope (catalogs, direct
      // invocation) every one is listed, and the handlers refuse outside their threads.
      list: async (accountId, scope) => {
        if (!scope) return all;
        if (!scope.threadId || (scope.mode !== 'work' && scope.mode !== 'chat')) return [];
        try {
          return await this.toolsFor(accountId, scope.threadId);
        } catch (err) {
          this.#log.warn('could not list run tools', { err });
          return [];
        }
      },
    };
  }

  /** The chat loop that runs turns (the ChatService); bound after it is built. */
  useTurns(starter: TurnStarter): void {
    this.#turns = starter;
  }

  /** The scheduler's delivery receipts for `message` outputs (FR-187). */
  useDelivery(check: DeliveryCheck): void {
    this.#delivery = check;
  }

  /** The shared derived status (FR-215); without it a run derives its own. */
  useStatus(fn: StatusLookup): void {
    this.#statusOf = fn;
  }

  /** Forget the auto-reviewer's denials when the user resumes a run it stopped (FR-085). */
  useReviewReset(fn: (key: string) => void): void {
    this.#reviewReset = fn;
  }

  /** The run tools for a thread (run thread, sub-agent thread or chat). */
  async toolsFor(accountId: string, threadId: string): Promise<ToolDefinition[]> {
    const kind = await this.#kindOf(threadId, accountId);
    if (kind?.kind === 'run') return this.#tools.run;
    if (kind?.kind === 'child') return this.#tools.child;
    const t = this.#threadRow(threadId, accountId);
    if (t?.mode !== 'chat') return [];
    return (await this.#settings.escalation(t.projectId)) === 'off' ? [] : [this.#tools.workStart];
  }

  // ---- runs: create, read, control ---------------------------------------------------------

  async create(input: CreateRunOptions): Promise<RunView> {
    const row = await this.#create(input);
    return this.#view(row);
  }

  async get(accountId: string, runId: string): Promise<RunView> {
    return this.#view(await this.#run(accountId, runId));
  }

  async list(accountId: string, q: ListRunsQuery = {}): Promise<Page<RunView>> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const where: SQL[] = [eq(runT.accountId, accountId)];
    if (q.status !== 'all') where.push(inArray(runT.status, ACTIVE_STATUSES));
    if (q.projectId) where.push(eq(runT.projectId, q.projectId));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push(
        sql`(${runT.updatedAt} < ${c.updatedAt} OR (${runT.updatedAt} = ${c.updatedAt} AND ${runT.id} < ${c.id}))`,
      );
    }
    const rows = await this.#db.orm
      .select()
      .from(runT)
      .where(and(...where))
      .orderBy(desc(runT.updatedAt), desc(runT.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: await Promise.all(items.map((r) => this.#view(r))),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /** Start a run waiting in `planning`: approve an ask-first plan, or accept a proposal. */
  async start(accountId: string, runId: string): Promise<RunView> {
    const next = await this.#lock(runId, async (): Promise<Next> => {
      const row = await this.#run(accountId, runId);
      if (row.status !== 'planning')
        throw new NovaError('conflict', 'the run is not waiting to start', {
          details: { status: row.status },
        });
      const hadTurn = this.#hasMessages(row.threadId);
      const steps = await this.#steps(row.id);
      // The user accepted the objective and plan as written: from now on they carry the user's
      // authority (FR-189), since the model may have written them (FR-186).
      const source = `run:${row.id}`;
      const started = await this.#setStatus(
        row,
        'running',
        { planApproved: steps.length > 0, authority: 'user', authoritySource: source },
        'user',
      );
      await this.#auditRun(started, 'user', 'run.start');
      const plan: TurnPlan = hadTurn
        ? {
            threadId: row.threadId,
            text: START_TEXT,
            trigger: 'user',
            authority: { kind: 'user', source: `${source}:start` },
            authorKind: 'run',
          }
        : this.#firstTurn(started);
      if (!this.#busy(row.threadId)) return () => this.#beginRun(started, plan);
      await this.#queue(started, { text: plan.text, user: true });
      return null;
    });
    if (next) await next();
    await this.#pump(runId);
    return this.get(accountId, runId);
  }

  async pause(accountId: string, runId: string): Promise<RunView> {
    await this.#lock(runId, async () => {
      const row = await this.#run(accountId, runId);
      if (isFinal(row.status)) throw new NovaError('conflict', 'the run has ended');
      if (row.status === 'paused') return;
      const paused = await this.#pause(row, 'user', { actor: 'user' });
      await this.#auditRun(paused, 'user', 'run.pause');
    });
    return this.get(accountId, runId);
  }

  async resume(accountId: string, runId: string): Promise<RunView> {
    const next = await this.#lock(runId, async (): Promise<Next> => {
      const row = await this.#run(accountId, runId);
      if (row.status !== 'paused')
        throw new NovaError('conflict', 'the run is not paused', {
          details: { status: row.status },
        });
      const turn = await this.#resumeLocked(row, 'user', false);
      await this.#auditRun(row, 'user', 'run.resume');
      return turn;
    });
    if (next) await next();
    await this.#pump(runId);
    return this.get(accountId, runId);
  }

  /** New instructions from the user (FR-019): a turn now, or after the running one. */
  async redirect(accountId: string, runId: string, text: string): Promise<RunView> {
    const next = await this.#lock(runId, async (): Promise<Next> => {
      let row = await this.#run(accountId, runId);
      if (isFinal(row.status)) throw new NovaError('conflict', 'the run has ended');
      await this.#auditRun(row, 'user', 'run.redirect', { inputHash: sha256(text) });
      const budgetPause =
        row.status === 'paused' &&
        (row.pauseReason?.startsWith('budget_') === true || row.pauseReason === 'backstop');
      if (this.#busy(row.threadId) || budgetPause) {
        // Applied when the running turn ends, or when the budget is extended.
        await this.#queue(row, { text, user: true });
        return null;
      }
      if (row.status === 'paused') row = await this.#setStatus(row, 'running', {}, 'user');
      const r = row;
      return () => this.#beginRun(r, this.#pendingPlan(r, [{ text, user: true }]));
    });
    if (next) await next();
    await this.#pump(runId);
    return this.get(accountId, runId);
  }

  async cancel(accountId: string, runId: string): Promise<RunView> {
    await this.#lock(runId, async () => {
      const row = await this.#run(accountId, runId);
      if (isFinal(row.status)) return;
      const done = await this.#end(row, 'cancelled', { actor: 'user' });
      await this.#auditRun(done, 'user', 'run.cancel');
    });
    return this.get(accountId, runId);
  }

  /** Extend a bound (FR-182) and resume a run that it paused. */
  async extendBudget(
    accountId: string,
    runId: string,
    ext: { timeSeconds?: number; tokens?: number; costUsd?: number; steps?: true },
  ): Promise<RunView> {
    const next = await this.#lock(runId, async (): Promise<Next> => {
      let row = await this.#run(accountId, runId);
      if (isFinal(row.status)) throw new NovaError('conflict', 'the run has ended');
      const set: Partial<RunRow> = {};
      if (ext.timeSeconds) set.timeBudgetS = row.timeBudgetS + ext.timeSeconds;
      if (ext.tokens) set.tokenBudget = row.tokenBudget + ext.tokens;
      if (ext.costUsd !== undefined && row.costBudgetUsd !== null)
        set.costBudgetUsd = row.costBudgetUsd + ext.costUsd;
      if (Object.keys(set).length) {
        await this.#update(row.id, set);
        row = { ...row, ...set };
        const m = this.#meters.get(row.id);
        if (m) m.limits = runLimits(row);
      }
      const budgets = {
        timeSeconds: row.timeBudgetS,
        tokens: row.tokenBudget,
        costUsd: row.costBudgetUsd,
      };
      await this.#emit('run.budget.extended', row, { runId: row.id, budgets, by: ext }, 'user');
      await this.#auditRun(row, 'user', 'run.budget.extend', { detail: { by: ext } });
      if (row.status !== 'paused') return null;
      const reason = row.pauseReason;
      const fits =
        (reason === 'backstop' && ext.steps === true) ||
        (reason?.startsWith('budget_') === true && this.#overBudget(row) === null);
      if (fits) {
        try {
          return await this.#resumeLocked(row, 'user', true);
        } catch (err) {
          // The goal's own budget still holds it: the run stays paused (FR-182).
          if (!(err instanceof NovaError) || err.code !== 'budget_exhausted') throw err;
        }
      }
      await this.#changed(row);
      return null;
    });
    if (next) await next();
    await this.#pump(runId);
    return this.get(accountId, runId);
  }

  /** The user writes or edits the plan; edits apply at the next turn. */
  async setPlan(
    accountId: string,
    runId: string,
    steps: { title: string; detail?: string }[],
  ): Promise<RunView> {
    await this.#lock(runId, async () => {
      const row = await this.#run(accountId, runId);
      if (isFinal(row.status)) throw new NovaError('conflict', 'the run has ended');
      await this.#replacePlan(row, steps);
      await this.#update(row.id, { planApproved: true });
      await this.#emit(
        'run.plan.amended',
        row,
        { runId: row.id, steps: steps.map((s) => s.title), reason: 'edited by the user' },
        'user',
      );
      await this.#auditRun(row, 'user', 'run.plan.update', { detail: { steps: steps.length } });
      await this.#changed(row);
    });
    return this.get(accountId, runId);
  }

  async subagents(accountId: string, runId: string): Promise<SubagentView[]> {
    const row = await this.#run(accountId, runId);
    return (await this.#subs(row.id)).map(toSubagentView);
  }

  /** The run's thread, for its activity (FR-057). */
  async threadOf(accountId: string, runId: string): Promise<string> {
    return (await this.#run(accountId, runId)).threadId;
  }

  /** Settles when the run reaches a final status (RunStarter). */
  async whenFinished(accountId: string, runId: string): Promise<RunFinish> {
    const row = await this.#run(accountId, runId);
    if (isFinal(row.status)) return finishOf(row);
    return new Promise((resolve) => {
      const list = this.#finishWaiters.get(runId) ?? [];
      list.push(resolve);
      this.#finishWaiters.set(runId, list);
    });
  }

  /**
   * After a Hub restart (FR-052): runs left running or waiting for an approval continue from
   * their last committed state with a continuation turn; paused runs stay paused; a run whose
   * goal waits on the user stays idle. Call after the chat loop recovered its turns.
   */
  async recover(): Promise<number> {
    const rows = await this.#db.orm
      .select()
      .from(runT)
      .where(inArray(runT.status, ['running', 'waiting_approval']));
    let resumed = 0;
    for (const r of rows) {
      const next = await this.#lock(r.id, async (): Promise<Next> => {
        let row = await this.#runById(r.id);
        if (!row || !LIVE.has(row.status)) return null;
        if (row.status === 'waiting_approval') row = await this.#setStatus(row, 'running');
        // Children that were running start again when the parent runs.
        await this.#db.transaction(() =>
          this.#db.orm
            .update(subT)
            .set({ status: 'queued' })
            .where(and(eq(subT.runId, row.id), eq(subT.status, 'running'))),
        );
        const goal = await this.#openGoal(row.id);
        if (goal && goal.status !== 'active') return null;
        const pending = pendingOf(row);
        if (pending.length) await this.#update(row.id, { pendingJson: null });
        // Idle between goal turns: the goal continues as it would have.
        if (goal && !pending.length && this.#lastTurnCompleted(row.threadId)) {
          this.#scheduleGoal(goal);
          return null;
        }
        const r2 = row;
        return () =>
          this.#beginRun(
            r2,
            pending.length ? this.#pendingPlan(r2, pending) : this.#continuation(r2, 'restart'),
          );
      });
      if (next) {
        resumed += 1;
        await next();
        await this.#pump(r.id);
      }
    }
    return resumed;
  }

  /**
   * The auto-reviewer's breaker interrupted the run (FR-085, `review.breaker.tripped`): pause it
   * until the user resumes. A sub-agent's thread pauses its run.
   */
  async onReviewBreaker(input: { runId?: string | null; threadId?: string | null }): Promise<void> {
    let runId = input.runId ?? null;
    if (!runId && input.threadId) runId = (await this.#kindOf(input.threadId))?.run.id ?? null;
    if (!runId) return;
    const id = runId;
    await this.#lock(id, async () => {
      const row = await this.#runById(id);
      if (!row || isFinal(row.status) || row.status === 'paused') return;
      const paused = await this.#pause(row, 'review_breaker', {
        detail: 'the auto-reviewer denied too many actions',
      });
      await this.#notify(paused, 'attention', 'Stopped by review', paused.title);
    });
  }

  /** The chat loop reported a thread waiting for (or done with) an approval (docs/09 §9). */
  async onThreadStatus(threadId: string, status: string): Promise<void> {
    const kind = await this.#kindOf(threadId);
    if (!kind) return;
    const runId = kind.run.id;
    await this.#lock(runId, async () => {
      const row = await this.#runById(runId);
      if (!row) return;
      if (status === 'needs_input' && row.status === 'running')
        await this.#setStatus(row, 'waiting_approval');
      else if (status === 'running' && row.status === 'waiting_approval')
        await this.#setStatus(row, 'running');
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const h of this.#goalTimers.values()) this.#timers.clear(h);
    for (const h of this.#retryTimers.values()) this.#timers.clear(h);
    this.#goalTimers.clear();
    this.#retryTimers.clear();
    for (const set of this.#subWaiters.values()) for (const fn of set) fn();
    await Promise.allSettled([...this.#flushes.values(), ...this.#background]);
  }

  /** Wait for background work (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const waits = [...this.#background, ...this.#flushes.values(), ...this.#locks.values()];
      if (!waits.length) return;
      await Promise.allSettled(waits);
    }
  }

  // ---- goals (FR-181) -----------------------------------------------------------------------

  async getRunGoal(accountId: string, runId: string): Promise<GoalView | null> {
    const row = await this.#run(accountId, runId);
    const g = (await this.#openGoal(row.id)) ?? (await this.#latestGoal(row.id));
    return g ? this.#goalView(g) : null;
  }

  async setRunGoal(
    accountId: string,
    runId: string,
    body: { objective: string; budgets?: BudgetAmounts },
  ): Promise<GoalView> {
    const id = await this.#lock(runId, async () => {
      const row = await this.#run(accountId, runId);
      if (isFinal(row.status)) throw new NovaError('conflict', 'the run has ended');
      const goalId = await this.#putGoal(row, body, 'user');
      await this.#loadMeters(row);
      await this.#kickGoal(row);
      return goalId;
    });
    return this.getGoal(accountId, id);
  }

  async clearRunGoal(accountId: string, runId: string): Promise<void> {
    await this.#lock(runId, async () => {
      const row = await this.#run(accountId, runId);
      const g = await this.#openGoal(row.id);
      if (!g) return;
      this.#clearGoalTimer(g.id);
      await this.#db.transaction(() => this.#db.orm.delete(goalT).where(eq(goalT.id, g.id)));
      const m = this.#meters.get(row.id);
      if (m) m.goal = null;
      await this.#emitGoal('goal.updated', g, { goalId: g.id, changed: ['cleared'] }, 'user');
      await this.#auditGoal(g, 'user', 'goal.clear');
      // A run that only waited on its goal is done now.
      if (LIVE.has(row.status) && !this.#busy(row.threadId)) await this.#finishIfLive(row.id, null);
      else await this.#changed(row);
    });
  }

  async listGoals(accountId: string, status?: GoalStatus): Promise<GoalView[]> {
    const where: SQL[] = [eq(goalT.accountId, accountId)];
    if (status) where.push(eq(goalT.status, status));
    const rows = await this.#db.orm
      .select()
      .from(goalT)
      .where(and(...where))
      .orderBy(desc(goalT.updatedAt), desc(goalT.id))
      .limit(200);
    return rows.map((g) => this.#goalView(g));
  }

  async getGoal(accountId: string, goalId: string): Promise<GoalView> {
    return this.#goalView(await this.#goal(accountId, goalId));
  }

  /** Edit the objective or budgets; applies at the start of the next turn. */
  async updateGoal(
    accountId: string,
    goalId: string,
    patch: { objective?: string; budgets?: BudgetAmounts },
  ): Promise<GoalView> {
    const g = await this.#goal(accountId, goalId);
    await this.#lock(g.runId ?? g.id, async () => {
      const cur = await this.#goal(accountId, goalId);
      const set: Partial<GoalRow> = { updatedAt: this.#iso() };
      const changed: string[] = [];
      if (patch.objective !== undefined) {
        set.objective = patch.objective;
        set.createdBy = 'user';
        changed.push('objective');
      }
      if (patch.budgets) {
        set.timeBudgetS = patch.budgets.timeSeconds ?? null;
        set.tokenBudget = patch.budgets.tokens ?? null;
        set.costBudgetUsd = patch.budgets.costUsd ?? null;
        changed.push('budgets');
      }
      await this.#db.transaction(() =>
        this.#db.orm.update(goalT).set(set).where(eq(goalT.id, cur.id)),
      );
      const m = cur.runId ? this.#meters.get(cur.runId) : undefined;
      if (m?.goal?.id === cur.id) m.goal.limits = goalLimits({ ...cur, ...set });
      await this.#emitGoal('goal.updated', cur, { goalId: cur.id, changed }, 'user');
      await this.#auditGoal(cur, 'user', 'goal.update', { changed });
    });
    return this.getGoal(accountId, goalId);
  }

  /** The user pauses, resumes or completes a goal; never usage_limited or budget_limited. */
  async goalAction(
    accountId: string,
    goalId: string,
    action: 'pause' | 'resume' | 'complete',
  ): Promise<GoalView> {
    const first = await this.#goal(accountId, goalId);
    const next = await this.#lock(first.runId ?? first.id, async (): Promise<Next> => {
      const g = await this.#goal(accountId, goalId);
      const to = userTransition(g.status, action);
      if (!to) return null;
      if (to === 'active') {
        const m = g.runId ? this.#meters.get(g.runId) : undefined;
        const used = m?.goal?.id === g.id ? m.goal.used : goalUsage(g);
        const hit = goalHit(goalLimits(g), used);
        if (hit)
          throw new NovaError('budget_exhausted', 'extend the goal budget first', {
            details: { bound: hit.bound },
          });
      }
      const extra: Partial<GoalRow> = {};
      if (to === 'active') Object.assign(extra, blockerReset());
      if (to === 'complete') {
        extra.completedAt = this.#iso();
        extra.completionSummary = g.progressNote;
      }
      if (to === 'active' && g.status === 'complete') extra.completedAt = null;
      if (to === 'active' && g.status === 'complete' && g.runId) {
        const open = await this.#openGoal(g.runId);
        if (open && open.id !== g.id)
          throw new NovaError('conflict', 'the run already has an open goal');
      }
      const updated = await this.#goalStatus(g, to, 'user', null, extra);
      const row = g.runId ? await this.#runById(g.runId) : null;
      if (!row) return null;
      if (to === 'active') {
        // A run its goal's budget paused goes on once both budgets allow it.
        if (row.status === 'paused' && row.pauseReason !== 'user')
          return this.#overBudget(row) === null ? this.#resumeLocked(row, 'user', true) : null;
        await this.#kickGoal(row, updated);
      }
      // A run that only waited on its goal is done when the user completes it.
      if (to === 'complete' && LIVE.has(row.status) && !this.#busy(row.threadId))
        await this.#finishIfLive(row.id, null);
      return null;
    });
    if (next) await next();
    return this.getGoal(accountId, goalId);
  }

  // ---- the turn extension (docs/09 §2, ADR-076) -----------------------------------------------

  async #forTurn(input: Parameters<TurnExtension['forTurn']>[0]): Promise<TurnAddition | null> {
    // Chats get work.start through the scoped tool listing; nothing else to add there.
    if (input.mode !== 'work') return null;
    const kind = await this.#kindOf(input.threadId, input.accountId);
    if (!kind || isFinal(kind.run.status)) return null;
    const queued = this.#queued.get(input.turnId);
    this.#queued.delete(input.turnId);
    const pending = queued ?? this.#pending.get(input.threadId);
    if (!queued) this.#pending.delete(input.threadId);
    // A turn the supervisor did not start is the user typing in the thread (or a hook).
    const authority = pending ? pending.authority : input.trigger === 'user' ? 'user' : 'none';
    this.#active.set(input.threadId, {
      turnId: input.turnId,
      authority,
      trigger: input.trigger,
      complete: false,
      blocker: null,
      result: null,
    });
    let run = kind.run;
    if (
      kind.kind === 'run' &&
      !pending &&
      input.trigger === 'user' &&
      run.status === 'paused' &&
      run.pauseReason === 'user'
    ) {
      // The user typed in a run they paused: that continues it.
      run = await this.#lock(run.id, async () => {
        const row = await this.#runById(run.id);
        return row?.status === 'paused' && row.pauseReason === 'user'
          ? this.#setStatus(row, 'running', {}, 'user')
          : (row ?? run);
      });
    }
    await this.#loadMeters(run);
    const goal = kind.kind === 'run' ? await this.#openGoal(run.id) : null;
    return {
      // Every turn of the run's thread counts toward it, typed ones included (docs/06 turn).
      runId: run.id,
      goalId: goal?.id ?? null,
      context:
        kind.kind === 'run' ? await this.#runContext(run) : this.#childContext(run, kind.sub),
      bounds: {
        check: () => this.#check(run.id),
        record: (step) => {
          this.#record(run.id, {
            timeMs: step.activeMs,
            tokens: step.inputTokens + step.outputTokens,
            costUsd: step.costUsd,
          });
        },
      },
      onEnd: (outcome) => this.#ended(input.threadId, outcome),
    };
  }

  async #runContext(run: RunRow): Promise<ContextBlock[]> {
    const blocks: ContextBlock[] = [
      // The objective the user typed is trusted; one a model wrote is data (FR-189).
      { label: 'Run objective', text: run.objective, trusted: run.authority === 'user' },
      {
        label: 'How to run',
        text: howToRun(run.autonomy, run.status === 'planning' && run.autonomy === 'ask_first'),
        trusted: true,
      },
    ];
    if (run.template === 'deep_research')
      blocks.push({ label: 'Deep research', text: DEEP_RESEARCH, trusted: true });
    const steps = await this.#steps(run.id);
    if (steps.length)
      blocks.push({
        label: run.planApproved ? 'Approved plan' : 'Plan',
        text: formatPlan(steps.map(toStepView)),
        trusted: run.planApproved,
      });
    const m = this.#meters.get(run.id);
    const goal = await this.#openGoal(run.id);
    const remaining = this.#remaining(run, goal);
    if (goal)
      blocks.push({
        label: 'Goal',
        text: `${goal.objective}\n\nStatus: ${goal.status}. Remaining budget: ${remaining}.`,
        trusted: goal.createdBy === 'user',
      });
    else if (m) blocks.push({ label: 'Budget', text: `Remaining: ${remaining}.`, trusted: true });
    const note = goal?.progressNote ?? run.progressNote;
    if (note) blocks.push({ label: 'Last progress note', text: note, trusted: false });
    if (run.origin === 'chat_escalation' && run.originRef) {
      const chat = this.#chatExcerpt(run.originRef, run.accountId);
      if (chat) blocks.push({ label: 'From the chat', text: chat, trusted: false });
    }
    return blocks;
  }

  #childContext(run: RunRow, sub: SubagentRow): ContextBlock[] {
    return [
      { label: 'Sub-agent', text: subagentBrief(cleanRole(sub.role)), trusted: true },
      { label: 'Run objective', text: run.objective, trusted: run.authority === 'user' },
    ];
  }

  /** The last messages of the chat a run escalated from: its context (FR-186). */
  #chatExcerpt(threadId: string, accountId: string): string | null {
    const rows = this.#db.raw
      .prepare(
        `SELECT m.role AS role, group_concat(p.content, '') AS text FROM message m
         JOIN thread t ON t.id = m.thread_id
         JOIN message_part p ON p.message_id = m.id AND p.type = 'text'
         WHERE m.thread_id = ? AND t.account_id = ? AND m.deleted_at IS NULL
           AND m.role IN ('user', 'assistant')
         GROUP BY m.id ORDER BY m.created_at DESC, m.id DESC LIMIT 10`,
      )
      .all(threadId, accountId) as { role: string; text: string | null }[];
    const lines = rows
      .reverse()
      .filter((r) => r.text?.trim())
      .map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${clipText(r.text!.trim(), 1500)}`);
    return lines.length ? clipText(lines.join('\n\n'), 8000) : null;
  }

  // ---- budgets (FR-182, ADR-058) ------------------------------------------------------------

  async #loadMeters(run: RunRow): Promise<void> {
    let row: RunRow | null = run;
    for (let depth = 0; row && depth < 5; depth++) {
      const goal = await this.#openGoal(row.id);
      let m = this.#meters.get(row.id);
      if (!m) {
        m = {
          runId: row.id,
          parent: row.parentRunId,
          limits: runLimits(row),
          used: { timeMs: row.timeUsedMs, tokens: row.tokensUsed, costUsd: row.costUsedUsd },
          goal: null,
        };
        this.#meters.set(row.id, m);
      } else m.limits = runLimits(row);
      if (!goal || isFinalGoal(goal)) m.goal = null;
      else if (m.goal?.id !== goal.id)
        m.goal = { id: goal.id, limits: goalLimits(goal), used: goalUsage(goal) };
      else m.goal.limits = goalLimits(goal);
      row = row.parentRunId ? await this.#runById(row.parentRunId) : null;
    }
  }

  /** Before each model step: the first run or goal bound used up, the parents' included. */
  #check(runId: string): BoundHit | null {
    let id: string | null = runId;
    for (let depth = 0; id && depth < 5; depth++) {
      const m = this.#meters.get(id);
      if (!m) return null;
      const hit = meterHit(m);
      if (hit) return hit;
      id = m.parent;
    }
    return null;
  }

  /** After each model step: count it for the run, its goal and every parent run. */
  #record(runId: string, delta: Usage): void {
    let id: string | null = runId;
    for (let depth = 0; id && depth < 5; depth++) {
      const m = this.#meters.get(id);
      if (!m) return;
      add(m.used, delta);
      if (m.goal) add(m.goal.used, delta);
      this.#flush(m.runId);
      id = m.parent;
    }
  }

  /** Persist a meter (in order per run) and publish the live consumption. */
  #flush(runId: string): void {
    const prev = this.#flushes.get(runId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const m = this.#meters.get(runId);
        if (!m) return;
        const now = this.#iso();
        await this.#db.transaction(() => {
          this.#db.raw
            .prepare(
              'UPDATE run SET time_used_ms = ?, tokens_used = ?, cost_used_usd = ?, updated_at = ? WHERE id = ?',
            )
            .run(m.used.timeMs, m.used.tokens, m.used.costUsd, now, runId);
          if (m.goal)
            this.#db.raw
              .prepare(
                'UPDATE goal SET time_used_ms = ?, tokens_used = ?, cost_used_usd = ?, updated_at = ? WHERE id = ?',
              )
              .run(m.goal.used.timeMs, m.goal.used.tokens, m.goal.used.costUsd, now, m.goal.id);
        });
        const row = await this.#runById(runId);
        if (!row) return;
        this.#events.emitEphemeral({
          name: 'run.budget.usage',
          accountId: row.accountId,
          correlation: { threadId: row.threadId, runId },
          payload: {
            runId,
            usage: {
              tokens: m.used.tokens,
              timeSeconds: Math.floor(m.used.timeMs / 1000),
              costUsd: m.used.costUsd,
            },
            budgets: {
              timeSeconds: row.timeBudgetS,
              tokens: row.tokenBudget,
              costUsd: row.costBudgetUsd,
            },
          },
        });
        await this.#changed(row);
      })
      .catch((err: unknown) => {
        this.#log.warn('could not save run usage', { err, runId });
      });
    this.#flushes.set(runId, next);
    void next.then(() => {
      if (this.#flushes.get(runId) === next) this.#flushes.delete(runId);
    });
  }

  /** The run bound used up now, from its row and live meter (resume and extend checks). */
  #overBudget(row: RunRow): BoundHit | null {
    const m = this.#meters.get(row.id);
    return meterHit({
      runId: row.id,
      parent: null,
      limits: runLimits(row),
      used: m?.used ?? { timeMs: row.timeUsedMs, tokens: row.tokensUsed, costUsd: row.costUsedUsd },
      goal: null,
    });
  }

  #remaining(run: RunRow, goal: GoalRow | null): string {
    const m = this.#meters.get(run.id);
    const used = m?.used ?? { timeMs: run.timeUsedMs, tokens: run.tokensUsed, costUsd: 0 };
    const goalUsed = goal ? (m?.goal?.id === goal.id ? m.goal.used : goalUsage(goal)) : null;
    return remainingText(runLimits(run), goal ? goalLimits(goal) : null, {
      run: used,
      goal: goalUsed,
    });
  }

  // ---- turn ends -------------------------------------------------------------------------------

  async #ended(threadId: string, o: TurnOutcome): Promise<void> {
    if (this.#handled.has(o.turnId)) return;
    this.#handled.add(o.turnId);
    if (this.#handled.size > MAX_HANDLED) {
      const first = this.#handled.values().next().value;
      if (first !== undefined) this.#handled.delete(first);
    }
    const act = this.#active.get(threadId);
    const flags = act?.turnId === o.turnId ? act : undefined;
    if (flags) this.#active.delete(threadId);
    this.#queued.delete(o.turnId);
    const kind = await this.#kindOf(threadId);
    if (!kind) return;
    try {
      if (kind.kind === 'run') await this.#onRunEnd(kind.run.id, threadId, o, flags);
      else await this.#onChildEnd(kind.sub.id, kind.run.id, threadId, o, flags);
    } catch (err) {
      this.#log.error('could not settle a run after its turn', { err, threadId });
    }
  }

  async #onRunEnd(
    runId: string,
    threadId: string,
    o: TurnOutcome,
    act: ActiveTurn | undefined,
  ): Promise<void> {
    await this.#flushes.get(runId);
    const ourCancel = o.stop === 'cancelled' && this.#cancelling.delete(threadId);
    const next = await this.#lock(runId, async (): Promise<Next> => {
      let row = await this.#runById(runId);
      if (!row || isFinal(row.status)) return null;
      if (this.#active.has(threadId)) return null; // another turn of the run is running
      const goal = await this.#openGoal(runId);
      if (goal && act) await this.#goalTurnEnded(goal, act);
      if (row.status === 'waiting_approval') row = await this.#setStatus(row, 'running');
      const reply = o.replyText.trim();
      const note = reply ? clipText(reply, 4000) : null;
      const summary = async (reason: string) =>
        note ??
        progressSummary({
          steps: o.steps,
          plan: (await this.#steps(runId)).map(toStepView),
          reason,
        });
      switch (o.stop) {
        case 'budget':
        case 'backstop':
          if (row.status === 'paused') return null;
          await this.#budgetPause(row, o, goal, await summary('budget reached'));
          return null;
        case 'approval_timeout':
          await this.#pause(row, 'approval_timeout', {
            note: await summary('an approval timed out'),
            detail: 'an approval was not answered in time',
          });
          await this.#notify(row, 'attention', 'Approval timed out', 'The run is paused.');
          return null;
        case 'location_lost':
          await this.#pause(row, 'error', {
            note: await summary('the execution location was lost'),
            detail: 'the execution location was lost',
          });
          return null;
        case 'error': {
          const code = o.error?.code ?? 'error';
          const message = o.error?.message ?? 'the turn failed';
          if (code === 'rate_limited' || code === 'over_budget') {
            await this.#pause(row, 'usage_limit', {
              note: await summary(message),
              detail: message,
            });
            if (goal?.status === 'active')
              await this.#goalStatus(goal, 'usage_limited', 'system', message);
            this.#scheduleRetry(row.id);
            return null;
          }
          const count = row.errorCount + 1;
          if (count >= this.#maxErrors) {
            await this.#end(row, 'failed', { detail: message, errorCount: count });
            return null;
          }
          await this.#pause(row, 'error', {
            note: await summary('an error'),
            detail: message,
            errorCount: count,
          });
          await this.#notify(row, 'error', 'Run paused after an error', message);
          return null;
        }
        case 'cancelled':
          if (!ourCancel && row.status === 'running') {
            // The user pressed Stop in the run's thread.
            await this.#pause(row, 'user', { note: await summary('stopped'), actor: 'user' });
            return null;
          }
          break;
        case 'end':
          break;
      }
      const set: Partial<RunRow> = {};
      if (o.stop === 'end' && row.errorCount) set.errorCount = 0;
      if (note && o.stop === 'end') set.progressNote = note;
      if (Object.keys(set).length) {
        await this.#update(row.id, set);
        row = { ...row, ...set };
      }
      const pending = pendingOf(row);
      if (pending.length && (row.status === 'running' || row.status === 'planning')) {
        await this.#update(row.id, { pendingJson: null });
        const r = row;
        return () => this.#beginRun(r, this.#pendingPlan(r, pending));
      }
      if (o.stop !== 'end') return null;
      if (row.status === 'planning') {
        await this.#changed(row);
        await this.#notify(row, 'attention', 'Plan ready', 'Review the plan and start the run.');
        return null;
      }
      if (row.status !== 'running') return null;
      // Sub-agents still at work: the run waits for them, then collects their results.
      const open = (await this.#subs(runId)).some(
        (x) => x.status === 'queued' || x.status === 'running',
      );
      if (open && !act?.complete) {
        await this.#changed(row);
        return null;
      }
      const g = goal ? await this.#goalById(goal.id) : null;
      if (act?.complete || !g || g.status === 'complete') {
        await this.#finish(row, note);
        return null;
      }
      if (g.status === 'active') this.#scheduleGoal(g);
      await this.#changed(row);
      return null;
    });
    if (next) await next();
    await this.#pump(runId);
  }

  async #budgetPause(
    row: RunRow,
    o: Pick<TurnOutcome, 'stop' | 'bound' | 'turnId'>,
    goal: GoalRow | null,
    summary: string,
  ): Promise<void> {
    const bound = o.stop === 'backstop' ? 'backstop' : (o.bound?.bound ?? 'time');
    const reason: RunPauseReason = bound === 'backstop' ? 'backstop' : `budget_${bound}`;
    const detail =
      bound === 'backstop'
        ? 'the 200-step limit of a turn was reached'
        : `the ${bound} budget was reached`;
    const paused = await this.#pause(row, reason, { note: summary, detail });
    await this.#emit('run.budget.reached', paused, {
      runId: row.id,
      turnId: o.turnId,
      bound,
      summary,
    });
    if (goal?.status === 'active' && bound !== 'backstop')
      await this.#goalStatus(goal, 'budget_limited', 'system', detail);
    await this.#notify(paused, 'attention', PAUSE_WORDS[reason] ?? 'Paused', summary);
  }

  /** The blocked rule's bookkeeping: a goal turn without a blocker resets the count. */
  async #goalTurnEnded(goal: GoalRow, act: ActiveTurn): Promise<void> {
    if (act.blocker !== null || goal.blockerCount === 0) return;
    await this.#db.transaction(() =>
      this.#db.orm
        .update(goalT)
        .set({ ...blockerReset(), updatedAt: this.#iso() })
        .where(eq(goalT.id, goal.id)),
    );
  }

  /** Finish a live run whose work is over (its goal completed or was cleared). */
  async #finishIfLive(runId: string, note: string | null): Promise<void> {
    const row = await this.#runById(runId);
    if (!row || !LIVE.has(row.status) || this.#busy(row.threadId)) return;
    await this.#finish(row, note ?? row.progressNote);
  }

  /** Verify the declared output (FR-187), record the result and end the run. */
  async #finish(row: RunRow, note: string | null): Promise<void> {
    const recorded = parseJson<RunResult>(row.resultJson);
    const summary = recorded?.summary ?? note ?? row.progressNote ?? '';
    const artifactIds = recorded?.artifactIds.length
      ? recorded.artifactIds
      : this.#artifactsOf(row).map((a) => a.id);
    const check = await this.#verify(row, summary);
    const evidence = [...(recorded?.evidence ?? [])];
    if (check.ok && check.evidence) evidence.push(check.evidence);
    const expected = parseJson<ExpectedOutput>(row.expectedOutputJson);
    const result: RunResult = { summary, artifactIds, evidence };
    await this.#end(row, check.ok ? 'done' : 'output_missing', {
      detail: check.ok ? null : check.reason,
      result,
      verifiedAt: check.ok && expected ? this.#iso() : null,
    });
  }

  async #verify(
    row: RunRow,
    summary: string,
  ): Promise<{ ok: true; evidence?: string } | { ok: false; reason: string }> {
    const out = parseJson<ExpectedOutput>(row.expectedOutputJson);
    if (!out) return { ok: true };
    switch (out.kind) {
      case 'artifact': {
        const want = out.ref ? norm(out.ref) : null;
        const found = this.#artifactsOf(row)
          .filter((a) => !want || norm(a.title ?? '') === want)
          .filter((a) => !this.#dataDir || !a.blobPath || blobExists(this.#dataDir, a.blobPath))
          .at(-1);
        if (!found)
          return {
            ok: false,
            reason: out.ref ? `no artifact titled "${out.ref}" was saved` : 'no artifact was saved',
          };
        return { ok: true, evidence: `artifact ${found.id} saved` };
      }
      case 'file': {
        if (!out.ref) return { ok: false, reason: 'the declared file output names no path' };
        try {
          const roots = (await this.#roots?.(row.accountId, row.threadId, row.projectId)) ?? [];
          const resolved = resolveInRoots(roots, out.ref, 'read');
          const st = await stat(resolved.path);
          if (!st.isFile()) return { ok: false, reason: `${out.ref} is not a file` };
          const hash = await sha256File(resolved.path);
          return { ok: true, evidence: `file ${resolved.path} sha256:${hash}` };
        } catch {
          return { ok: false, reason: `the file ${out.ref} was not written` };
        }
      }
      case 'message': {
        if (row.origin === 'schedule') {
          // Delivered with a provider receipt, never because a transport accepted it (FR-187).
          if (!this.#delivery) return { ok: false, reason: 'no delivery receipt' };
          try {
            const r = await this.#delivery({
              accountId: row.accountId,
              runId: row.id,
              originRef: row.originRef,
              summary,
            });
            return r.ok ? { ok: true, evidence: r.evidence } : { ok: false, reason: r.reason };
          } catch (err) {
            this.#log.warn('delivery check failed', { err, runId: row.id });
            return { ok: false, reason: 'the delivery could not be confirmed' };
          }
        }
        return summary.trim()
          ? { ok: true, evidence: 'final reply written' }
          : { ok: false, reason: 'the run ended without a reply' };
      }
    }
  }

  #artifactsOf(
    row: RunRow,
  ): { id: string; title: string | null; blobPath: string | null; threadId: string }[] {
    const threads = [row.threadId, ...this.#childThreadsSync(row.id)];
    const marks = threads.map(() => '?').join(', ');
    return this.#db.raw
      .prepare(
        `SELECT id, title, blob_path AS blobPath, thread_id AS threadId FROM artifact
         WHERE account_id = ? AND thread_id IN (${marks}) AND sha256 IS NOT NULL
         ORDER BY created_at, id`,
      )
      .all(row.accountId, ...threads) as {
      id: string;
      title: string | null;
      blobPath: string | null;
      threadId: string;
    }[];
  }

  /** End a run: final status, result, children stopped, events, waiters (FR-187). */
  async #end(
    row: RunRow,
    status: 'done' | 'output_missing' | 'failed' | 'cancelled',
    x: {
      detail?: string | null;
      result?: RunResult;
      verifiedAt?: string | null;
      actor?: 'user' | 'system';
      errorCount?: number;
    } = {},
  ): Promise<RunRow> {
    const set: Partial<RunRow> = {
      statusDetail: x.detail ?? null,
      outputVerifiedAt: x.verifiedAt ?? null,
      pendingJson: null,
    };
    if (x.result) {
      set.resultSummary = x.result.summary;
      set.resultJson = JSON.stringify(x.result);
    }
    if (x.errorCount !== undefined) set.errorCount = x.errorCount;
    const ended = await this.#setStatus(row, status, set, x.actor ?? 'system');
    const goal = await this.#openGoal(row.id);
    if (goal) this.#clearGoalTimer(goal.id);
    this.#clearRetry(row.id);
    // Children never outlive their run.
    for (const s of await this.#subs(row.id)) {
      if (s.status === 'queued' || s.status === 'running')
        await this.#endChild(ended, s, 'cancelled');
    }
    await this.#emit(
      'run.completed',
      ended,
      {
        runId: row.id,
        status,
        resultSummary: ended.resultSummary,
        outputVerified: ended.outputVerifiedAt !== null,
      },
      x.actor ?? 'system',
    );
    if (status === 'done') await this.#notify(ended, 'completion', 'Run finished', ended.title);
    else if (status !== 'cancelled')
      await this.#notify(
        ended,
        'error',
        status === 'failed' ? 'Run failed' : 'Run output missing',
        ended.statusDetail ?? ended.title,
      );
    this.#stopThread(ended.accountId, ended.threadId);
    const waiters = this.#finishWaiters.get(row.id) ?? [];
    this.#finishWaiters.delete(row.id);
    const fin = finishOf(ended);
    for (const w of waiters) w(fin);
    this.#meters.delete(row.id);
    return ended;
  }

  /** Pause: status, reason, the progress note; the running turn and children stop. */
  async #pause(
    row: RunRow,
    reason: RunPauseReason,
    x: { note?: string; detail?: string; actor?: 'user' | 'system'; errorCount?: number } = {},
  ): Promise<RunRow> {
    const set: Partial<RunRow> = { pauseReason: reason, statusDetail: x.detail ?? null };
    if (x.note) set.progressNote = x.note;
    if (x.errorCount !== undefined) set.errorCount = x.errorCount;
    const paused = await this.#setStatus(row, 'paused', set, x.actor ?? 'system');
    const goal = await this.#openGoal(row.id);
    if (goal) this.#clearGoalTimer(goal.id);
    if (this.#busy(row.threadId)) this.#stopThread(row.accountId, row.threadId);
    // Pausing the parent pauses its children (FR-090): they start again on resume.
    for (const s of await this.#subs(row.id)) {
      if (s.status !== 'running') continue;
      await this.#db.transaction(() =>
        this.#db.orm.update(subT).set({ status: 'queued' }).where(eq(subT.id, s.id)),
      );
      if (s.threadId) this.#stopThread(row.accountId, s.threadId);
    }
    return paused;
  }

  /** Back to running; returns the turn to start once the lock is released. */
  async #resumeLocked(
    row: RunRow,
    actor: 'user' | 'system',
    extended: boolean,
  ): Promise<(() => Promise<void>) | null> {
    const reason = row.pauseReason;
    if (reason?.startsWith('budget_') && !extended) {
      const hit = this.#overBudget(row);
      if (hit)
        throw new NovaError('budget_exhausted', `the ${hit.bound} budget is used up; extend it`, {
          details: { bound: hit.bound },
        });
    }
    const goal = await this.#openGoal(row.id);
    if (goal && (goal.status === 'budget_limited' || goal.status === 'usage_limited')) {
      const m = this.#meters.get(row.id);
      const used = m?.goal?.id === goal.id ? m.goal.used : goalUsage(goal);
      if (goalHit(goalLimits(goal), used) === null)
        await this.#goalStatus(goal, 'active', actor, null, blockerReset());
      else if (goal.status === 'budget_limited')
        throw new NovaError('budget_exhausted', "the goal's budget is used up; extend it", {
          details: { bound: goalHit(goalLimits(goal), used)?.bound ?? 'time' },
        });
    }
    this.#clearRetry(row.id);
    if (reason === 'review_breaker' && this.#reviewReset) {
      // The user looked at the denials and resumed: the count starts again.
      this.#reviewReset(row.id);
      this.#reviewReset(row.threadId);
    }
    const running = await this.#setStatus(row, 'running', { statusDetail: null }, actor);
    const pending = pendingOf(running);
    if (this.#busy(row.threadId)) {
      // The cancelled turn has not ended yet: the continuation starts when it does.
      if (!pending.length)
        await this.#queue(running, { text: continueText(running.progressNote), user: false });
      return null;
    }
    if (pending.length) await this.#update(row.id, { pendingJson: null });
    const plan = pending.length
      ? this.#pendingPlan(running, pending)
      : this.#continuation(running, 'resume');
    return () => this.#beginRun(running, plan);
  }

  // ---- starting turns --------------------------------------------------------------------------

  #firstTurn(row: RunRow): TurnPlan {
    const trigger: TurnTrigger =
      row.origin === 'schedule' ? 'schedule' : row.origin === 'trigger' ? 'event' : 'user';
    return {
      threadId: row.threadId,
      text: row.objective,
      trigger,
      triggerRef: trigger === 'user' ? row.id : row.originRef,
      authority: this.#authority(row, null),
      authorKind: row.origin === 'schedule' ? 'schedule' : 'run',
    };
  }

  #continuation(row: RunRow, why: 'resume' | 'restart'): TurnPlan {
    return {
      threadId: row.threadId,
      text: continueText(row.progressNote),
      trigger: 'user',
      triggerRef: row.id,
      // Resuming continues the objective with the authority it already has; it never turns a
      // model-written objective into the user's (FR-189).
      authority: this.#authority(row, why),
      authorKind: 'run',
    };
  }

  #authority(row: RunRow, suffix: string | null): StartTurnInput['authority'] {
    if (row.authority === 'user') {
      const base = row.authoritySource ?? `run:${row.id}`;
      return { kind: 'user', source: suffix ? `run:${row.id}:${suffix}` : base };
    }
    const origin =
      row.authoritySource && ORIGINS.has(row.authoritySource) ? row.authoritySource : 'system';
    return { kind: 'none', origin: origin as Origin };
  }

  async #beginRun(row: RunRow, plan: TurnPlan): Promise<void> {
    const started = await this.#begin(row, plan);
    if (started) return;
    await this.#lock(row.id, async () => {
      const cur = await this.#runById(row.id);
      if (cur && (LIVE.has(cur.status) || cur.status === 'planning'))
        await this.#pause(cur, 'error', { detail: 'the turn could not be started' });
    });
  }

  /** Start a turn through the chat loop; false when it could not start. */
  async #begin(row: RunRow, plan: TurnPlan): Promise<boolean> {
    const turns = this.#turns;
    if (!turns || this.#closed) {
      this.#log.warn('no turn starter is bound; the run waits', { runId: row.id });
      return false;
    }
    this.#pending.set(plan.threadId, { authority: plan.authority.kind, trigger: plan.trigger });
    try {
      const input: StartTurnInput = {
        accountId: row.accountId,
        threadId: plan.threadId,
        text: plan.text,
        trigger: plan.trigger,
        triggerRef: plan.triggerRef ?? null,
        runId: row.id,
        goalId: plan.goalId ?? null,
        authority: plan.authority,
        authorKind: plan.authorKind,
      };
      if (row.model) input.model = row.model;
      if (plan.attachmentIds?.length) input.attachmentIds = plan.attachmentIds;
      const started = await turns.startTurn(input);
      const pending = this.#pending.get(plan.threadId);
      if (pending) {
        // Not asked about yet: the loop queued it behind the running turn (or runs without
        // extensions); the extension finds it by its turn id when it starts.
        this.#pending.delete(plan.threadId);
        this.#queued.set(started.turnId, { threadId: plan.threadId, ...pending });
      }
      this.#track(
        started.done.then(
          (o) => this.#ended(plan.threadId, o),
          (err: unknown) => {
            this.#log.warn('a run turn failed to settle', { err, runId: row.id });
          },
        ),
      );
      return true;
    } catch (err) {
      this.#pending.delete(plan.threadId);
      this.#log.warn('could not start a run turn', { err, runId: row.id });
      return false;
    }
  }

  async #queue(row: RunRow, item: PendingInput): Promise<void> {
    const pending = [...pendingOf(row), item].slice(-20);
    await this.#update(row.id, { pendingJson: JSON.stringify(pending) });
    await this.#changed(row);
  }

  /** Waiting input as one turn: the user's authority when any of it is the user's. */
  #pendingPlan(row: RunRow, items: PendingInput[]): TurnPlan {
    const user = items.some((i) => i.user);
    return {
      threadId: row.threadId,
      text: items.map((i) => i.text).join('\n\n'),
      trigger: 'user',
      triggerRef: row.id,
      authority: user
        ? { kind: 'user', source: `run:${row.id}:redirect` }
        : this.#authority(row, 'resume'),
      authorKind: user ? 'user' : 'run',
    };
  }

  #stopThread(accountId: string, threadId: string): void {
    const turns = this.#turns;
    let mine = this.#active.has(threadId) || this.#pending.has(threadId);
    for (const q of this.#queued.values()) if (q.threadId === threadId) mine = true;
    if (!turns || !mine) return;
    this.#cancelling.add(threadId);
    this.#track(
      turns
        .cancel(accountId, threadId)
        .catch((err: unknown) => {
          this.#log.warn('could not cancel a run turn', { err, threadId });
        })
        .finally(() => {
          // The cancelled turn's end has been handled (or there was none).
          this.#cancelling.delete(threadId);
        }),
    );
  }

  #busy(threadId: string): boolean {
    if (this.#active.has(threadId) || this.#pending.has(threadId)) return true;
    for (const q of this.#queued.values()) if (q.threadId === threadId) return true;
    const row = this.#db.raw
      .prepare("SELECT 1 AS x FROM turn WHERE thread_id = ? AND status = 'in_progress' LIMIT 1")
      .get(threadId);
    return row !== undefined;
  }

  #track(p: Promise<unknown>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }

  // ---- goals: internals ------------------------------------------------------------------------

  async #putGoal(
    row: RunRow,
    body: { objective: string; budgets?: BudgetAmounts },
    by: 'user' | 'agent',
  ): Promise<string> {
    const now = this.#iso();
    const open = await this.#openGoal(row.id);
    if (open) {
      const set: Partial<GoalRow> = {
        objective: body.objective,
        createdBy: by,
        updatedAt: now,
        timeBudgetS: body.budgets?.timeSeconds ?? null,
        tokenBudget: body.budgets?.tokens ?? null,
        costBudgetUsd: body.budgets?.costUsd ?? null,
      };
      await this.#db.transaction(() =>
        this.#db.orm.update(goalT).set(set).where(eq(goalT.id, open.id)),
      );
      const m = this.#meters.get(row.id);
      if (m?.goal?.id === open.id) m.goal.limits = goalLimits({ ...open, ...set });
      await this.#emitGoal(
        'goal.updated',
        open,
        { goalId: open.id, changed: ['objective', 'budgets'] },
        by === 'user' ? 'user' : 'system',
      );
      await this.#auditGoal(open, by, 'goal.set');
      return open.id;
    }
    const g: GoalRow = {
      id: uuidv7(),
      accountId: row.accountId,
      runId: row.id,
      agentId: null,
      threadId: row.threadId,
      objective: body.objective,
      createdBy: by,
      status: 'active',
      statusSetBy: by,
      statusReason: null,
      progressNote: null,
      completionSummary: null,
      tokenBudget: body.budgets?.tokens ?? null,
      timeBudgetS: body.budgets?.timeSeconds ?? null,
      costBudgetUsd: body.budgets?.costUsd ?? null,
      tokensUsed: 0,
      timeUsedMs: 0,
      costUsedUsd: 0,
      blockerKey: null,
      blockerDescription: null,
      blockerCount: 0,
      blockerTurnId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await this.#db.transaction(() => this.#db.orm.insert(goalT).values(g));
    const m = this.#meters.get(row.id);
    if (m) m.goal = { id: g.id, limits: goalLimits(g), used: goalUsage(g) };
    await this.#emitGoal(
      'goal.created',
      g,
      {
        goalId: g.id,
        runId: row.id,
        objective: g.objective,
        budgets: body.budgets ?? {},
      },
      by === 'user' ? 'user' : 'system',
    );
    await this.#auditGoal(g, by, 'goal.set');
    return g.id;
  }

  /** Change a goal's status: events, audit, notification (docs/09 §2.1). */
  async #goalStatus(
    g: GoalRow,
    to: GoalStatus,
    by: 'user' | 'agent' | 'system',
    reason: string | null,
    extra: Partial<GoalRow> = {},
  ): Promise<GoalRow> {
    const set: Partial<GoalRow> = {
      status: to,
      statusSetBy: by,
      statusReason: reason,
      updatedAt: this.#iso(),
      ...extra,
    };
    await this.#db.transaction(() => this.#db.orm.update(goalT).set(set).where(eq(goalT.id, g.id)));
    const next = { ...g, ...set };
    const actor = by === 'user' ? 'user' : 'system';
    await this.#emitGoal(
      'goal.status.changed',
      next,
      {
        goalId: g.id,
        from: g.status,
        to,
        setBy: by,
        ...(reason ? { reason } : {}),
        ...(to === 'blocked' && next.blockerKey
          ? { blocker: { key: next.blockerKey, description: next.blockerDescription } }
          : {}),
      },
      actor,
    );
    await this.#emitGoal('goal.updated', next, { goalId: g.id, changed: ['status'] }, actor);
    await this.#auditGoal(next, by, 'goal.status', { from: g.status, to });
    if (to === 'blocked' && g.runId) {
      const row = await this.#runById(g.runId);
      if (row)
        await this.#notify(
          row,
          'attention',
          'Goal blocked',
          next.blockerDescription ?? next.blockerKey ?? 'The goal cannot progress.',
        );
    }
    if (to !== 'active') this.#clearGoalTimer(g.id);
    return next;
  }

  /** A live, idle run with an active goal continues after the debounce. */
  async #kickGoal(row: RunRow, goal?: GoalRow): Promise<void> {
    const g = goal ?? (await this.#openGoal(row.id));
    if (g?.status === 'active' && LIVE.has(row.status) && !this.#busy(row.threadId))
      this.#scheduleGoal(g);
    await this.#changed(row);
  }

  #scheduleGoal(g: GoalRow): void {
    const runId = g.runId;
    if (!runId || this.#closed) return;
    this.#clearGoalTimer(g.id);
    const h = this.#timers.set(() => {
      this.#goalTimers.delete(g.id);
      this.#track(
        this.#continueGoal(runId, g.id).catch((err: unknown) => {
          this.#log.warn('goal continuation failed', { err, goalId: g.id });
        }),
      );
    }, this.#debounceMs);
    this.#goalTimers.set(g.id, h);
  }

  #clearGoalTimer(goalId: string): void {
    const h = this.#goalTimers.get(goalId);
    if (h !== undefined) this.#timers.clear(h);
    this.#goalTimers.delete(goalId);
  }

  /** Idle continuation (docs/09 §2.1): the goal's thread has no turn, input or request. */
  async #continueGoal(runId: string, goalId: string): Promise<void> {
    const next = await this.#lock(runId, async (): Promise<Next> => {
      const row = await this.#runById(runId);
      const g = await this.#openGoal(runId);
      if (row?.status !== 'running' || g?.id !== goalId || g.status !== 'active') return null;
      if (this.#busy(row.threadId) || this.#threadWaiting(row.threadId)) return null;
      await this.#loadMeters(row);
      const text = goalContinuationText({
        objective: g.objective,
        remaining: this.#remaining(row, g),
        progress: g.progressNote ?? row.progressNote,
      });
      return () =>
        this.#beginRun(row, {
          threadId: row.threadId,
          text,
          trigger: 'goal',
          triggerRef: g.id,
          goalId: g.id,
          // A continuation is Nova's own prompt: it authorizes nothing (FR-189).
          authority: { kind: 'none', origin: 'system' },
          authorKind: 'goal',
        });
    });
    if (next) await next();
  }

  /** Queued input or a pending approval or request: the user goes first. */
  #threadWaiting(threadId: string): boolean {
    const t = this.#db.raw.prepare('SELECT state FROM thread WHERE id = ?').get(threadId) as
      { state: string } | undefined;
    if (t && t.state !== 'idle') return true;
    const q = this.#db.raw
      .prepare("SELECT 1 AS x FROM queued_input WHERE thread_id = ? AND status = 'pending' LIMIT 1")
      .get(threadId);
    return q !== undefined;
  }

  #scheduleRetry(runId: string): void {
    if (this.#closed) return;
    this.#clearRetry(runId);
    const h = this.#timers.set(() => {
      this.#retryTimers.delete(runId);
      this.#track(
        this.#retryUsage(runId).catch((err: unknown) => {
          this.#log.warn('usage retry failed', { err, runId });
        }),
      );
    }, this.#usageRetryMs);
    this.#retryTimers.set(runId, h);
  }

  #clearRetry(runId: string): void {
    const h = this.#retryTimers.get(runId);
    if (h !== undefined) this.#timers.clear(h);
    this.#retryTimers.delete(runId);
  }

  /** A provider usage limit may have reset: try again (docs/09 §12). */
  async #retryUsage(runId: string): Promise<void> {
    const next = await this.#lock(runId, async (): Promise<Next> => {
      const row = await this.#runById(runId);
      if (row?.status !== 'paused' || row.pauseReason !== 'usage_limit') return null;
      return this.#resumeLocked(row, 'system', false);
    });
    if (next) await next();
  }

  // ---- sub-agents (FR-053, FR-054, docs/09 §4) -------------------------------------------------

  /** Start queued children while the run is live and below the concurrency limit. */
  async #pump(runId: string): Promise<void> {
    const starts: { sub: SubagentRow; first: boolean }[] = [];
    const run = await this.#lock(runId, async () => {
      const row = await this.#runById(runId);
      if (!row || !LIVE.has(row.status)) return null;
      const limits = await this.#settings.subagents(row.projectId);
      const subs = await this.#subs(row.id);
      let running = subs.filter((s) => s.status === 'running').length;
      for (const s of subs) {
        if (running >= limits.maxConcurrent) break;
        if (s.status !== 'queued') continue;
        let threadId = s.threadId;
        const first = threadId === null;
        if (!threadId) {
          const t = await this.#threads.create(row.accountId, {
            mode: 'work',
            title: clipText(`${cleanRole(s.role)}: ${s.objective}`, 120),
            ...(row.projectId ? { projectId: row.projectId } : {}),
            ...(row.model ? { model: row.model } : {}),
          });
          threadId = t.id;
          await this.#db.transaction(() => {
            this.#db.raw
              .prepare('UPDATE thread SET parent_thread_id = ? WHERE id = ?')
              .run(row.threadId, t.id);
          });
        }
        await this.#db.transaction(() =>
          this.#db.orm
            .update(subT)
            .set({ status: 'running', threadId, endedAt: null })
            .where(eq(subT.id, s.id)),
        );
        starts.push({ sub: { ...s, status: 'running', threadId }, first });
        running += 1;
      }
      return row;
    });
    if (!run) return;
    for (const { sub, first } of starts) await this.#startChild(run, sub, first);
    if (starts.length) await this.#changed(run);
  }

  async #startChild(run: RunRow, sub: SubagentRow, first: boolean): Promise<void> {
    const threadId = sub.threadId!;
    const inbox = parseJson<string[]>(sub.inboxJson) ?? [];
    if (inbox.length)
      await this.#db.transaction(() =>
        this.#db.orm.update(subT).set({ inboxJson: null }).where(eq(subT.id, sub.id)),
      );
    const text = first
      ? [sub.objective, ...inbox].join('\n\n')
      : inbox.join('\n\n') || 'Continue your task.';
    if (first)
      await this.#emit('run.subagent.spawned', run, {
        runId: run.id,
        subagentId: sub.id,
        threadId,
        role: sub.role,
      });
    const started = await this.#begin(run, {
      threadId,
      text,
      trigger: 'user',
      triggerRef: run.id,
      // The model wrote the task: it carries no authority (FR-189).
      authority: { kind: 'none', origin: 'system' },
      authorKind: 'subagent',
    });
    if (!started)
      await this.#lock(run.id, async () => {
        const cur = await this.#subById(sub.id);
        if (cur?.status === 'running')
          await this.#endChild(run, cur, 'failed', 'the sub-agent could not start');
      });
  }

  async #onChildEnd(
    subId: string,
    runId: string,
    threadId: string,
    o: TurnOutcome,
    act: ActiveTurn | undefined,
  ): Promise<void> {
    await this.#flushes.get(runId);
    const ourCancel = o.stop === 'cancelled' && this.#cancelling.delete(threadId);
    const next = await this.#lock(runId, async (): Promise<Next> => {
      const sub = await this.#subById(subId);
      const row = await this.#runById(runId);
      if (!sub || !row || sub.status !== 'running') return null;
      if (this.#active.has(threadId)) return null;
      switch (o.stop) {
        case 'end': {
          const inbox = parseJson<string[]>(sub.inboxJson) ?? [];
          if (inbox.length && LIVE.has(row.status)) {
            return () => this.#startChild(row, sub, false);
          }
          const summary =
            act?.result ?? (o.replyText.trim() || 'The sub-agent finished without a reply.');
          await this.#endChild(row, sub, 'done', clipText(summary, 8000));
          return this.#childrenDone(row);
        }
        case 'budget':
          // The run's budget (children count toward it): pause the run; the child queues.
          if (LIVE.has(row.status)) {
            const goal = await this.#openGoal(runId);
            await this.#budgetPause(
              row,
              o,
              goal,
              progressSummary({
                steps: o.steps,
                plan: (await this.#steps(runId)).map(toStepView),
                reason: 'budget reached',
              }),
            );
          }
          return null;
        case 'cancelled':
          if (ourCancel) return null;
          await this.#endChild(row, sub, 'cancelled', 'stopped by the user');
          return this.#childrenDone(row);
        default:
          await this.#endChild(
            row,
            sub,
            'failed',
            o.error?.message ?? `the sub-agent stopped: ${o.stop.replace(/_/g, ' ')}`,
          );
          return this.#childrenDone(row);
      }
    });
    if (next) await next();
    await this.#pump(runId);
  }

  /** The last child ended while the run waited for it: the run collects the results. */
  async #childrenDone(row: RunRow): Promise<Next> {
    if (row.status !== 'running' || this.#busy(row.threadId)) return null;
    const subs = await this.#subs(row.id);
    if (subs.some((x) => x.status === 'queued' || x.status === 'running')) return null;
    const goal = await this.#openGoal(row.id);
    if (goal && goal.status !== 'active') return null;
    return () =>
      this.#beginRun(row, {
        threadId: row.threadId,
        text: CHILDREN_DONE_TEXT,
        trigger: 'user',
        triggerRef: row.id,
        authority: this.#authority(row, 'children'),
        authorKind: 'run',
      });
  }

  async #endChild(
    run: RunRow,
    sub: SubagentRow,
    status: 'done' | 'failed' | 'cancelled',
    summary?: string,
  ): Promise<void> {
    const set: Partial<SubagentRow> = { status, endedAt: this.#iso(), inboxJson: null };
    if (summary !== undefined) set.resultJson = JSON.stringify({ summary });
    await this.#db.transaction(() => this.#db.orm.update(subT).set(set).where(eq(subT.id, sub.id)));
    if (sub.threadId && status === 'cancelled') this.#stopThread(run.accountId, sub.threadId);
    if (sub.threadId)
      await this.#emit('run.subagent.completed', run, {
        runId: run.id,
        subagentId: sub.id,
        status,
      });
    this.#wakeWaiters(run.id);
    await this.#changed(run);
  }

  #wakeWaiters(runId: string): void {
    for (const fn of this.#subWaiters.get(runId) ?? []) fn();
  }

  // ---- tools (RunToolHost) -------------------------------------------------------------------

  async planSet(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('plan.set');
    const steps = stepsOf(args);
    return this.#lock(kind.run.id, async () => {
      const row = await this.#runById(kind.run.id);
      if (!row || isFinal(row.status)) return fail('run_ended', 'the run has ended');
      const had = (await this.#steps(row.id)).length > 0;
      await this.#replacePlan(row, steps);
      if (row.planApproved) await this.#update(row.id, { planApproved: false });
      await this.#emit(
        had ? 'run.plan.amended' : 'run.plan.proposed',
        row,
        had
          ? { runId: row.id, steps: steps.map((s) => s.title), reason: 'changed by the agent' }
          : { runId: row.id, steps: steps.map((s) => s.title) },
        'system',
        ctx.turnId,
      );
      await this.#changed(row);
      const wait =
        row.status === 'planning'
          ? ' The user reviews it before the work starts: stop here and say the plan is ready.'
          : '';
      return ok(`Plan saved with ${steps.length} steps.${wait}`);
    });
  }

  async planUpdate(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('plan.update');
    const a = argsOf(args);
    const idx = num(a.idx) ?? -1;
    const status = str(a.status) as RunStepRow['status'] | undefined;
    const detail = str(a.detail);
    return this.#lock(kind.run.id, async () => {
      const row = await this.#runById(kind.run.id);
      if (!row || isFinal(row.status)) return fail('run_ended', 'the run has ended');
      const step = (await this.#steps(row.id)).find((s) => s.idx === idx);
      if (!step || !status) return fail('not_found', `the plan has no step ${idx}`);
      const now = this.#iso();
      const set: Partial<RunStepRow> = { status };
      if (detail !== undefined) set.detailJson = JSON.stringify(detail);
      if (status === 'running' && !step.startedAt) set.startedAt = now;
      if (status === 'done' || status === 'failed' || status === 'skipped') set.endedAt = now;
      if (status === 'pending' || status === 'running') set.endedAt = null;
      await this.#db.transaction(() =>
        this.#db.orm.update(stepT).set(set).where(eq(stepT.id, step.id)),
      );
      const payload = {
        runId: row.id,
        stepId: step.id,
        idx: step.idx,
        title: step.title,
        status,
        detail: detail ?? null,
      };
      if (status === 'running')
        await this.#emit('run.step.started', row, payload, 'system', ctx.turnId);
      else if (status !== 'pending')
        await this.#emit('run.step.completed', row, payload, 'system', ctx.turnId);
      await this.#changed(row);
      return ok(`Step ${idx} is ${status}.`);
    });
  }

  async runComplete(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (!kind) return notInRun('run.complete');
    const a = argsOf(args);
    const summary = str(a.summary)?.trim() ?? '';
    if (!summary) return fail('invalid_arguments', 'a summary is required');
    const act = this.#act(ctx);
    if (kind.kind === 'child') {
      if (act) act.result = clipText(summary, 8000);
      return ok('Result recorded; it goes back to the run when this turn ends.');
    }
    const ids = strings(a.artifactIds);
    const known = new Set(this.#artifactsOf(kind.run).map((x) => x.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length)
      return fail('not_found', `these artifacts are not part of this run: ${unknown.join(', ')}`);
    const result: RunResult = { summary, artifactIds: ids, evidence: strings(a.evidence) };
    await this.#update(kind.run.id, {
      resultSummary: summary,
      resultJson: JSON.stringify(result),
    });
    if (act) act.complete = true;
    return ok('Result recorded. The run finishes when this turn ends.');
  }

  async goalGet(ctx: ToolContext): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('goal.get');
    const g = await this.#openGoal(kind.run.id);
    if (!g) return ok('No goal is set for this run.');
    await this.#loadMeters(kind.run);
    const v = this.#goalView(g);
    return ok(
      JSON.stringify({
        id: v.id,
        objective: v.objective,
        status: v.status,
        budgets: v.budgets,
        usage: v.usage,
        remaining: this.#remaining(kind.run, g),
        progressNote: v.progressNote,
        blocker: v.blocker,
      }),
    );
  }

  async goalSet(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('goal.set');
    // Only when the user asked for a goal (docs/09 §2.1): the run's objective and this turn
    // both carry the user's own words.
    if (kind.run.authority !== 'user' || this.#act(ctx)?.authority !== 'user')
      return fail(
        'not_requested',
        'goal.set works only when the user asked for a goal in this run; the user can set one in the run header',
      );
    const a = argsOf(args);
    const objective = str(a.objective)?.trim();
    if (!objective) return fail('invalid_arguments', 'an objective is required');
    const b = argsOf(a.budgets);
    const budgets: BudgetAmounts = {};
    if (num(b.timeSeconds) !== undefined) budgets.timeSeconds = num(b.timeSeconds);
    if (num(b.tokens) !== undefined) budgets.tokens = num(b.tokens);
    if (num(b.costUsd) !== undefined) budgets.costUsd = num(b.costUsd);
    return this.#lock(kind.run.id, async () => {
      const row = await this.#runById(kind.run.id);
      if (!row || isFinal(row.status)) return fail('run_ended', 'the run has ended');
      const id = await this.#putGoal(
        row,
        { objective: clipText(objective, 4000), budgets },
        'agent',
      );
      await this.#loadMeters(row);
      await this.#changed(row);
      return ok(`Goal set (${id}).`);
    });
  }

  async goalUpdate(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('goal.update');
    const a = argsOf(args);
    const status = str(a.status) as GoalStatus | undefined;
    const note = str(a.progressNote)?.trim();
    const blocker = a.blocker === undefined ? null : argsOf(a.blocker);
    const act = this.#act(ctx);
    return this.#lock(kind.run.id, async () => {
      let g = await this.#openGoal(kind.run.id);
      if (!g) return fail('not_found', 'this run has no goal');
      const changed: string[] = [];
      const set: Partial<GoalRow> = { updatedAt: this.#iso() };
      if (note) {
        set.progressNote = clipText(note, 4000);
        changed.push('progressNote');
      }
      if (blocker) {
        const key = normalizeBlockerKey(str(blocker.key) ?? '');
        if (!key) return fail('invalid_arguments', 'the blocker needs a key');
        const turnId = ctx.turnId || 'unknown';
        set.blockerCount = nextBlockerCount(g, key, turnId);
        set.blockerKey = key;
        set.blockerTurnId = turnId;
        set.blockerDescription = str(blocker.description)?.slice(0, 2000) ?? null;
        if (act) act.blocker = key;
        changed.push('blocker');
      }
      if (changed.length) {
        await this.#db.transaction(() =>
          this.#db.orm.update(goalT).set(set).where(eq(goalT.id, g!.id)),
        );
        g = { ...g, ...set };
        await this.#emitGoal(
          'goal.updated',
          g,
          { goalId: g.id, changed, ...(note ? { progressNote: g.progressNote } : {}) },
          'system',
        );
      }
      if (status && status !== g.status) {
        const check = checkAgentStatus(g, status, {
          userAsked: act?.authority === 'user',
          hasSummary: !!(note ?? g.progressNote),
        });
        if (!check.ok) return fail('status_refused', check.message);
        const extra: Partial<GoalRow> = {};
        if (status === 'complete') {
          extra.completedAt = this.#iso();
          extra.completionSummary = note ?? g.progressNote;
        }
        const reason = status === 'blocked' ? (g.blockerDescription ?? g.blockerKey) : null;
        g = await this.#goalStatus(g, status, 'agent', reason, extra);
      }
      return ok(
        status
          ? `Goal is ${g.status}.`
          : blocker
            ? `Blocker recorded (${g.blockerCount} of ${BLOCKED_AFTER} consecutive goal turns).`
            : 'Goal updated.',
      );
    });
  }

  async taskSpawn(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind === 'child')
      return fail('depth_limit', 'sub-agents cannot start sub-agents (depth 1)');
    if (!kind) return notInRun('task.spawn');
    const a = argsOf(args);
    const role = cleanRole(str(a.role) ?? '');
    const objective = str(a.objective)?.trim() ?? '';
    if (!role || !objective)
      return fail('invalid_arguments', 'a role and an objective are required');
    let tools: string[] | null = null;
    if (a.tools !== undefined) {
      tools = [...new Set(strings(a.tools))];
      const bad = tools.filter((t) => !TOOL_NAME.test(t) || t.startsWith('task.'));
      if (bad.length)
        return fail('invalid_arguments', `tools a sub-agent cannot get: ${bad.join(', ')}`);
    }
    const limits = await this.#settings.subagents(kind.run.projectId);
    const created = await this.#lock(kind.run.id, async (): Promise<ToolResult | string> => {
      const row = await this.#runById(kind.run.id);
      if (!row || !LIVE.has(row.status)) return fail('run_not_running', 'the run is not running');
      const count = (await this.#subs(row.id)).length;
      if (count >= limits.maxChildren)
        return fail(
          'limit',
          `this run already has ${count} sub-agents, the most it may have (${limits.maxChildren})`,
        );
      const id = uuidv7();
      await this.#db.transaction(() =>
        this.#db.orm.insert(subT).values({
          id,
          runId: row.id,
          threadId: null,
          role,
          objective: clipText(objective, 8000),
          toolsJson: tools ? JSON.stringify(tools) : null,
          status: 'queued',
          inboxJson: null,
          resultJson: null,
          createdAt: this.#iso(),
          endedAt: null,
        }),
      );
      return id;
    });
    if (typeof created !== 'string') return created;
    await this.#pump(kind.run.id);
    const sub = await this.#subById(created);
    return ok(
      JSON.stringify({
        id: created,
        status: sub?.status ?? 'queued',
        threadId: sub?.threadId ?? null,
      }),
    );
  }

  async taskMessage(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('task.message');
    const a = argsOf(args);
    const id = str(a.id) ?? '';
    const text = str(a.text)?.trim() ?? '';
    const [res, next] = await this.#lock(kind.run.id, async (): Promise<[ToolResult, Next]> => {
      const sub = await this.#subById(id);
      const row = await this.#runById(kind.run.id);
      if (!sub || sub.runId !== kind.run.id || !row)
        return [fail('not_found', `no sub-agent ${id}`), null];
      if (sub.status === 'cancelled')
        return [fail('cancelled', 'that sub-agent was cancelled'), null];
      const inbox = [...(parseJson<string[]>(sub.inboxJson) ?? []), clipText(text, 8000)];
      const restart = sub.status === 'done' || sub.status === 'failed';
      await this.#db.transaction(() =>
        this.#db.orm
          .update(subT)
          .set({
            inboxJson: JSON.stringify(inbox.slice(-20)),
            ...(restart ? { status: 'queued' as const, endedAt: null } : {}),
          })
          .where(eq(subT.id, sub.id)),
      );
      const idle = sub.status === 'running' && sub.threadId !== null && !this.#busy(sub.threadId);
      const msg = ok(
        sub.status === 'running'
          ? 'Sent; the sub-agent reads it when its current turn ends.'
          : 'Sent; the sub-agent starts again with it.',
      );
      return [
        msg,
        idle
          ? () => this.#startChild(row, { ...sub, inboxJson: JSON.stringify(inbox) }, false)
          : null,
      ];
    });
    if (next) await next();
    await this.#pump(kind.run.id);
    return res;
  }

  async taskWait(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('task.wait');
    const a = argsOf(args);
    const ids = [...new Set(strings(a.ids))];
    const seconds = Math.min(Math.max(num(a.timeoutSeconds) ?? 30, 10), MAX_WAIT_SECONDS);
    const subs = await this.#subs(kind.run.id);
    const missing = ids.filter((id) => !subs.some((s) => s.id === id));
    if (missing.length) return fail('not_found', `no sub-agents ${missing.join(', ')} in this run`);
    const settled = async () => {
      const rows = await this.#subs(kind.run.id);
      return rows.filter((s) => ids.includes(s.id));
    };
    const allDone = (rows: SubagentRow[]) =>
      rows.every((s) => s.status === 'done' || s.status === 'failed' || s.status === 'cancelled');
    let rows = await settled();
    if (!allDone(rows) && !ctx.signal.aborted) {
      await new Promise<void>((resolve) => {
        let finished = false;
        const set = this.#subWaiters.get(kind.run.id) ?? new Set<() => void>();
        this.#subWaiters.set(kind.run.id, set);
        const finish = () => {
          if (finished) return;
          finished = true;
          set.delete(onChange);
          if (!set.size) this.#subWaiters.delete(kind.run.id);
          this.#timers.clear(timer);
          ctx.signal.removeEventListener('abort', finish);
          resolve();
        };
        const onChange = () => {
          void settled().then((r) => {
            if (allDone(r) || this.#closed) finish();
          });
        };
        set.add(onChange);
        const timer = this.#timers.set(finish, seconds * 1000);
        ctx.signal.addEventListener('abort', finish, { once: true });
      });
      rows = await settled();
    }
    return ok(
      JSON.stringify({
        done: allDone(rows),
        results: rows.map((s) => {
          const v = toSubagentView(s);
          return { id: v.id, role: v.role, status: v.status, result: v.result };
        }),
      }),
    );
  }

  async taskList(ctx: ToolContext): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('task.list');
    const items = (await this.#subs(kind.run.id)).map((s) => {
      const v = toSubagentView(s);
      return {
        id: v.id,
        role: v.role,
        objective: clipText(v.objective, 300),
        status: v.status,
        result: v.result,
      };
    });
    return ok(JSON.stringify({ items }));
  }

  async taskCancel(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const kind = await this.#kindOf(ctx.threadId, ctx.accountId);
    if (kind?.kind !== 'run') return notInRun('task.cancel');
    const id = str(argsOf(args).id) ?? '';
    const res = await this.#lock(kind.run.id, async () => {
      const sub = await this.#subById(id);
      const row = await this.#runById(kind.run.id);
      if (!sub || sub.runId !== kind.run.id || !row) return fail('not_found', `no sub-agent ${id}`);
      if (sub.status !== 'queued' && sub.status !== 'running')
        return ok(`The sub-agent already ended (${sub.status}).`);
      await this.#endChild(row, sub, 'cancelled', 'cancelled by the run');
      return ok('Sub-agent cancelled.');
    });
    await this.#pump(kind.run.id);
    return res;
  }

  /** Chat escalation (FR-186, ADR-077): propose a run card, or start the run. */
  async workStart(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const t = this.#threadRow(ctx.threadId, ctx.accountId);
    if (t?.mode !== 'chat') return fail('not_in_chat', 'work.start works only in a chat');
    const mode = await this.#settings.escalation(t.projectId);
    if (mode === 'off')
      return fail('escalation_off', 'starting Work runs from chats is turned off');
    const a = argsOf(args);
    const objective = str(a.objective)?.trim() ?? '';
    if (!objective) return fail('invalid_arguments', 'an objective is required');
    const title = str(a.title)?.trim();
    const plan = a.plan === undefined ? undefined : stepsOf({ steps: a.plan });
    const row = await this.#create({
      accountId: ctx.accountId,
      objective,
      ...(title ? { title } : {}),
      projectId: t.projectId,
      origin: 'chat_escalation',
      originRef: ctx.threadId,
      // The model wrote the objective: it carries the user's authority only once the user
      // presses Start (FR-189).
      authority: { kind: 'none', origin: 'system' },
      start: mode === 'auto',
      ...(plan ? { plan } : {}),
    });
    const status = mode === 'auto' ? 'running' : 'proposed';
    return ok(JSON.stringify({ runId: row.id, threadId: row.threadId, status }), {
      runId: row.id,
      threadId: row.threadId,
      status,
    });
  }

  // ---- create ------------------------------------------------------------------------------

  async #create(input: CreateRunOptions): Promise<RunRow> {
    const objective = input.objective.trim();
    if (!objective) throw new NovaError('validation', 'an objective is required');
    const projectId = input.projectId ?? null;
    const id = uuidv7();
    const defaults = await this.#settings.defaultBudgets(projectId);
    const autonomy = input.autonomy ?? (await this.#settings.autonomy(projectId));
    let timeS = input.budgets?.timeSeconds ?? defaults.timeSeconds;
    let tokens = input.budgets?.tokens ?? defaults.tokens;
    let cost = input.budgets?.costUsd !== undefined ? input.budgets.costUsd : defaults.costUsd;
    let parent: RunRow | null = null;
    if (input.parentRunId) {
      parent = await this.#run(input.accountId, input.parentRunId);
      // A delegated run may get a lower cap than its parent, never a higher one (docs/09 §4).
      timeS = Math.min(timeS, parent.timeBudgetS);
      tokens = Math.min(tokens, parent.tokenBudget);
      if (parent.costBudgetUsd !== null) cost = Math.min(cost ?? Infinity, parent.costBudgetUsd);
    }
    const expected =
      input.expectedOutput ??
      (input.template === 'deep_research' ? { kind: 'artifact' as const } : null);
    const title = clipText(input.title?.trim() ?? titleFrom(objective) ?? 'Work run', 200);
    const thread = await this.#threads.create(input.accountId, {
      mode: 'work',
      title,
      ...(projectId ? { projectId } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    const authority = input.authority;
    const now = this.#iso();
    const status: RunStatus = !input.start || autonomy === 'ask_first' ? 'planning' : 'running';
    const row: RunRow = {
      id,
      accountId: input.accountId,
      projectId,
      threadId: thread.id,
      agentId: input.agentId ?? parent?.agentId ?? null,
      parentRunId: parent?.id ?? null,
      origin: input.origin,
      originRef: input.originRef ?? null,
      template: input.template ?? null,
      title,
      objective,
      authority: authority.kind,
      authoritySource:
        authority.kind === 'user' ? authority.source || `run:${id}` : authority.origin,
      model: input.model ?? null,
      status,
      pauseReason: null,
      statusDetail: null,
      autonomy,
      planApproved: false,
      timeBudgetS: timeS,
      tokenBudget: tokens,
      costBudgetUsd: cost,
      timeUsedMs: 0,
      tokensUsed: 0,
      costUsedUsd: 0,
      progressNote: null,
      pendingJson: null,
      errorCount: 0,
      expectedOutputJson: expected ? JSON.stringify(expected) : null,
      outputVerifiedAt: null,
      resultSummary: null,
      resultJson: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    await this.#db.transaction(() => this.#db.orm.insert(runT).values(row));
    const actor = input.origin === 'user' ? 'user' : 'system';
    await this.#emit(
      'run.created',
      row,
      {
        runId: id,
        title,
        objective,
        autonomy,
        origin: input.origin,
        budgets: { timeSeconds: timeS, tokens, costUsd: cost },
      },
      actor,
    );
    await this.#auditRun(row, actor, 'run.create', {
      detail: { origin: input.origin, autonomy, template: input.template ?? null },
    });
    if (input.plan?.length) {
      await this.#replacePlan(row, input.plan);
      await this.#emit('run.plan.proposed', row, {
        runId: id,
        steps: input.plan.map((s) => s.title),
      });
    }
    if (input.goal)
      await this.#putGoal(row, input.goal, authority.kind === 'user' ? 'user' : 'agent');
    if (input.start) {
      const first = this.#firstTurn(row);
      if (input.attachmentIds?.length) first.attachmentIds = input.attachmentIds;
      await this.#beginRun(row, first);
    }
    return (await this.#runById(id)) ?? row;
  }

  // ---- plan ---------------------------------------------------------------------------------

  async #replacePlan(row: RunRow, steps: { title: string; detail?: string }[]): Promise<void> {
    const old = await this.#steps(row.id);
    const rows: RunStepRow[] = steps.map((s, idx) => {
      const prev = old.find((o) => o.idx === idx && o.title === s.title);
      return {
        id: prev?.id ?? uuidv7(),
        runId: row.id,
        idx,
        title: s.title,
        status: prev?.status ?? 'pending',
        detailJson: s.detail !== undefined ? JSON.stringify(s.detail) : (prev?.detailJson ?? null),
        startedAt: prev?.startedAt ?? null,
        endedAt: prev?.endedAt ?? null,
      };
    });
    await this.#db.transaction(async () => {
      await this.#db.orm.delete(stepT).where(eq(stepT.runId, row.id));
      if (rows.length) await this.#db.orm.insert(stepT).values(rows);
    });
  }

  // ---- views and status ---------------------------------------------------------------------

  async #view(row: RunRow): Promise<RunView> {
    const steps = await this.#steps(row.id);
    const goal = (await this.#openGoal(row.id)) ?? (await this.#latestGoal(row.id));
    return toRunView({
      row,
      steps,
      goalId: goal?.id ?? null,
      derived: await this.#derivedView(row, goal),
      used: this.#meters.get(row.id)?.used ?? null,
    });
  }

  #goalView(g: GoalRow): GoalView {
    const m = g.runId ? this.#meters.get(g.runId) : undefined;
    return toGoalView(g, m?.goal?.id === g.id ? m.goal.used : null);
  }

  /**
   * The shared status when the thread status service is bound, except that a plan or proposal
   * waiting for Start needs input, which only the run knows.
   */
  async #derivedView(row: RunRow, goal: GoalRow | null): Promise<StatusView> {
    const local = this.#derived(row, goal);
    if (!this.#statusOf || (row.status === 'planning' && local.status === 'needs_input'))
      return local;
    try {
      return (await this.#statusOf(row.accountId, [row.threadId])).get(row.threadId) ?? local;
    } catch (err) {
      this.#log.warn('thread status lookup failed', { err, runId: row.id });
      return local;
    }
  }

  /** One status from runtime state (FR-215, docs/09 §9). */
  #derived(row: RunRow, goal: GoalRow | null): StatusView {
    const threads = [row.threadId, ...this.#childThreadsSync(row.id)];
    const marks = threads.map(() => '?').join(', ');
    const states = this.#db.raw
      .prepare(`SELECT id, state FROM thread WHERE id IN (${marks})`)
      .all(...threads) as { id: string; state: string }[];
    if (states.some((s) => s.state === 'waiting_approval' || s.state === 'waiting_input'))
      return { status: 'needs_input', reason: 'Approval needed' };
    if (row.status === 'planning' && !this.#busy(row.threadId))
      return {
        status: 'needs_input',
        reason: this.#hasMessages(row.threadId) ? 'Plan ready for review' : 'Waiting to start',
      };
    const blocked = blockedReason(row, goal);
    if (blocked) return { status: 'blocked', reason: blocked };
    if (threads.some((t) => this.#busy(t))) return { status: 'running', reason: null };
    return { status: 'ready', reason: null };
  }

  async #blockedThreads(accountId: string, threadIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!threadIds.length) return out;
    const rows = await this.#db.orm
      .select()
      .from(runT)
      .where(and(eq(runT.accountId, accountId), inArray(runT.threadId, threadIds)));
    for (const r of rows) {
      const reason = blockedReason(r, await this.#openGoal(r.id));
      if (reason) out.set(r.threadId, reason);
    }
    return out;
  }

  async #threadPolicy(accountId: string, threadId: string): Promise<ThreadPolicy | null> {
    const kind = await this.#kindOf(threadId, accountId);
    if (!kind) return null;
    let profileId: string | null = null;
    if (kind.kind === 'child') {
      const allow = parseJson<string[]>(kind.sub.toolsJson);
      // A child limited to reading tools runs with the read-only profile: narrower, never wider.
      if (allow?.length && allow.every((t) => READ_ONLY_TOOLS.has(t))) profileId = 'read-only';
    }
    return {
      approvalPolicy: AUTONOMY_POLICY[kind.run.autonomy],
      profileId,
      roots: null,
      permissionMode: null,
      autoAcceptEdits: false,
    };
  }

  /** Publish the run's current view (ephemeral `run.updated`, every change). */
  async #changed(row: RunRow): Promise<void> {
    const fresh = (await this.#runById(row.id)) ?? row;
    const view = await this.#view(fresh);
    this.#events.emitEphemeral({
      name: 'run.updated',
      accountId: fresh.accountId,
      correlation: { threadId: fresh.threadId, runId: fresh.id },
      payload: { runId: fresh.id, run: view },
    });
  }

  async #setStatus(
    row: RunRow,
    to: RunStatus,
    extra: Partial<RunRow> = {},
    actor: 'user' | 'system' = 'system',
  ): Promise<RunRow> {
    const set: Partial<RunRow> = { status: to, ...extra };
    if (to !== 'paused') set.pauseReason = null;
    if (isFinal(to)) set.endedAt = this.#iso();
    await this.#update(row.id, set);
    const next = (await this.#runById(row.id)) ?? { ...row, ...set };
    if (row.status !== to || (to === 'paused' && row.pauseReason !== next.pauseReason))
      await this.#emit(
        'run.status.changed',
        next,
        {
          runId: row.id,
          from: row.status,
          to,
          ...(to === 'paused' && next.pauseReason ? { pauseReason: next.pauseReason } : {}),
        },
        actor,
      );
    await this.#changed(next);
    return next;
  }

  // ---- storage helpers -----------------------------------------------------------------------

  async #update(id: string, set: Partial<RunRow>): Promise<void> {
    await this.#db.transaction(() =>
      this.#db.orm
        .update(runT)
        .set({ ...set, updatedAt: this.#iso() })
        .where(eq(runT.id, id)),
    );
  }

  async #run(accountId: string, id: string): Promise<RunRow> {
    const rows = await this.#db.orm
      .select()
      .from(runT)
      .where(and(eq(runT.id, id), eq(runT.accountId, accountId)))
      .limit(1);
    const r = rows[0];
    if (!r) throw new NovaError('not_found', 'run not found');
    return r;
  }

  async #runById(id: string): Promise<RunRow | null> {
    const rows = await this.#db.orm.select().from(runT).where(eq(runT.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async #runByThread(threadId: string): Promise<RunRow | null> {
    const rows = await this.#db.orm.select().from(runT).where(eq(runT.threadId, threadId)).limit(1);
    return rows[0] ?? null;
  }

  async #steps(runId: string): Promise<RunStepRow[]> {
    return this.#db.orm.select().from(stepT).where(eq(stepT.runId, runId)).orderBy(asc(stepT.idx));
  }

  async #subs(runId: string): Promise<SubagentRow[]> {
    return this.#db.orm
      .select()
      .from(subT)
      .where(eq(subT.runId, runId))
      .orderBy(asc(subT.createdAt), asc(subT.id));
  }

  async #subById(id: string): Promise<SubagentRow | null> {
    const rows = await this.#db.orm.select().from(subT).where(eq(subT.id, id)).limit(1);
    return rows[0] ?? null;
  }

  #childThreadsSync(runId: string): string[] {
    return (
      this.#db.raw
        .prepare(
          'SELECT thread_id AS threadId FROM subagent WHERE run_id = ? AND thread_id IS NOT NULL',
        )
        .all(runId) as { threadId: string }[]
    ).map((r) => r.threadId);
  }

  async #openGoal(runId: string): Promise<GoalRow | null> {
    const rows = await this.#db.orm
      .select()
      .from(goalT)
      .where(and(eq(goalT.runId, runId), ne(goalT.status, 'complete')))
      .orderBy(desc(goalT.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async #latestGoal(runId: string): Promise<GoalRow | null> {
    const rows = await this.#db.orm
      .select()
      .from(goalT)
      .where(eq(goalT.runId, runId))
      .orderBy(desc(goalT.updatedAt), desc(goalT.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async #goalById(id: string): Promise<GoalRow | null> {
    const rows = await this.#db.orm.select().from(goalT).where(eq(goalT.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async #goal(accountId: string, id: string): Promise<GoalRow> {
    const rows = await this.#db.orm
      .select()
      .from(goalT)
      .where(and(eq(goalT.id, id), eq(goalT.accountId, accountId)))
      .limit(1);
    const g = rows[0];
    if (!g) throw new NovaError('not_found', 'goal not found');
    return g;
  }

  async #kindOf(threadId: string, accountId?: string): Promise<ThreadKind> {
    if (!threadId) return null;
    const run = await this.#runByThread(threadId);
    if (run) return accountId && run.accountId !== accountId ? null : { kind: 'run', run };
    const rows = await this.#db.orm.select().from(subT).where(eq(subT.threadId, threadId)).limit(1);
    const sub = rows[0];
    if (!sub) return null;
    const parent = await this.#runById(sub.runId);
    if (!parent || (accountId && parent.accountId !== accountId)) return null;
    return { kind: 'child', run: parent, sub };
  }

  #threadRow(
    threadId: string,
    accountId: string,
  ): { mode: string; projectId: string | null } | null {
    const row = this.#db.raw
      .prepare(
        'SELECT mode, project_id AS projectId FROM thread WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
      )
      .get(threadId, accountId) as { mode: string; projectId: string | null } | undefined;
    return row ?? null;
  }

  #lastTurnCompleted(threadId: string): boolean {
    const row = this.#db.raw
      .prepare('SELECT status FROM turn WHERE thread_id = ? ORDER BY idx DESC LIMIT 1')
      .get(threadId) as { status: string } | undefined;
    return row?.status === 'completed';
  }

  #hasMessages(threadId: string): boolean {
    return (
      this.#db.raw
        .prepare('SELECT 1 AS x FROM message WHERE thread_id = ? LIMIT 1')
        .get(threadId) !== undefined
    );
  }

  #act(ctx: ToolContext): ActiveTurn | undefined {
    const act = this.#active.get(ctx.threadId);
    return act && (!ctx.turnId || act.turnId === ctx.turnId) ? act : undefined;
  }

  async #lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => mine);
    this.#locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === chained) this.#locks.delete(key);
    }
  }

  async #emit(
    name: string,
    row: Pick<RunRow, 'id' | 'accountId' | 'threadId'>,
    payload: Record<string, unknown>,
    actor: 'user' | 'system' = 'system',
    turnId?: string,
  ): Promise<void> {
    await this.#events.emit({
      name,
      actor,
      accountId: row.accountId,
      correlation: { threadId: row.threadId, runId: row.id, ...(turnId ? { turnId } : {}) },
      payload,
    });
  }

  async #emitGoal(
    name: string,
    g: GoalRow,
    payload: Record<string, unknown>,
    actor: 'user' | 'system',
  ): Promise<void> {
    await this.#events.emit({
      name,
      actor,
      accountId: g.accountId,
      correlation: {
        ...(g.threadId ? { threadId: g.threadId } : {}),
        ...(g.runId ? { runId: g.runId } : {}),
      },
      payload,
    });
  }

  async #auditRun(
    row: RunRow,
    actor: string,
    action: string,
    x: { detail?: Record<string, unknown>; inputHash?: string } = {},
  ): Promise<void> {
    await this.#appendAudit({
      accountId: row.accountId,
      actor,
      kind: 'run',
      action,
      resource: `run:${row.id}`,
      threadId: row.threadId,
      inputHash: x.inputHash ?? null,
      result: row.status,
      detail: { runId: row.id, ...x.detail },
    });
  }

  async #auditGoal(
    g: GoalRow,
    actor: string,
    action: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#appendAudit({
      accountId: g.accountId,
      actor,
      kind: 'run',
      action,
      resource: `goal:${g.id}`,
      threadId: g.threadId,
      result: g.status,
      detail: { goalId: g.id, runId: g.runId, ...detail },
    });
  }

  async #appendAudit(rec: AuditRecord): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append(rec);
    } catch (err) {
      this.#log.warn('could not audit a run change', { err, action: rec.action });
    }
  }

  async #notify(
    row: RunRow,
    kind: 'completion' | 'error' | 'attention',
    title: string,
    body: string,
  ): Promise<void> {
    if (!this.#notifier) return;
    try {
      await this.#notifier.notify({
        accountId: row.accountId,
        kind,
        title,
        body: clipText(body, 500),
        href: `/work/${row.id}`,
        dedupeKey: `run:${row.id}:${title}`,
      });
    } catch (err) {
      this.#log.warn('could not notify about a run', { err, runId: row.id });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

// ---- helpers -----------------------------------------------------------------------------------

function runLimits(row: RunRow): Meter['limits'] {
  return { timeMs: row.timeBudgetS * 1000, tokens: row.tokenBudget, costUsd: row.costBudgetUsd };
}

function goalUsage(g: GoalRow): Usage {
  return { timeMs: g.timeUsedMs, tokens: g.tokensUsed, costUsd: g.costUsedUsd };
}

function isFinalGoal(g: GoalRow): boolean {
  return g.status === 'complete';
}

function add(u: Usage, d: Usage): void {
  u.timeMs += Math.max(0, d.timeMs);
  u.tokens += Math.max(0, d.tokens);
  u.costUsd += Math.max(0, d.costUsd);
}

function meterHit(m: Meter): BoundHit | null {
  if (m.used.timeMs >= m.limits.timeMs)
    return {
      bound: 'time',
      used: Math.floor(m.used.timeMs / 1000),
      limit: Math.floor(m.limits.timeMs / 1000),
    };
  if (m.used.tokens >= m.limits.tokens)
    return { bound: 'tokens', used: m.used.tokens, limit: m.limits.tokens };
  if (m.limits.costUsd !== null && m.used.costUsd >= m.limits.costUsd)
    return { bound: 'cost', used: m.used.costUsd, limit: m.limits.costUsd };
  return m.goal ? goalHit(m.goal.limits, m.goal.used) : null;
}

function blockerReset(): Partial<GoalRow> {
  return { blockerKey: null, blockerDescription: null, blockerCount: 0, blockerTurnId: null };
}

/** Why a run blocks its thread (FR-215): it cannot go on without the user. */
function blockedReason(row: RunRow, goal: GoalRow | null): string | null {
  if (row.status === 'paused' && row.pauseReason && row.pauseReason !== 'user')
    return PAUSE_WORDS[row.pauseReason] ?? 'Paused';
  if (row.status === 'failed') return 'Run failed';
  if (row.status === 'output_missing') return 'Output missing';
  if (isFinal(row.status)) return null;
  if (goal?.status === 'blocked') return 'Goal blocked';
  if (goal?.status === 'budget_limited') return 'Budget reached';
  if (goal?.status === 'usage_limited') return 'Usage limit reached';
  return null;
}

function pendingOf(row: RunRow): PendingInput[] {
  const raw = parseJson<unknown[]>(row.pendingJson) ?? [];
  return raw.flatMap((x) => {
    const o = argsOf(x);
    const text = str(o.text);
    return text ? [{ text, user: o.user === true }] : [];
  });
}

function finishOf(row: RunRow): RunFinish {
  const result = parseJson<RunResult>(row.resultJson);
  return {
    runId: row.id,
    status: row.status as RunFinish['status'],
    summary: row.resultSummary,
    artifactIds: result?.artifactIds ?? [],
  };
}

function stepsOf(args: unknown): { title: string; detail?: string }[] {
  const raw = argsOf(args).steps;
  const list = Array.isArray(raw) ? (raw as unknown[]) : [];
  return list.slice(0, 50).flatMap((s) => {
    const o = argsOf(s);
    const title = str(o.title)?.trim();
    if (!title) return [];
    const detail = str(o.detail);
    return [
      detail
        ? { title: clipText(title, 500), detail: clipText(detail, 2000) }
        : { title: clipText(title, 500) },
    ];
  });
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];
}

/** A role as a short plain label ("researcher"), never instructions. */
function cleanRole(role: string): string {
  return role
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    .trim()
    .slice(0, 40);
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function notInRun(tool: string): ToolResult {
  return fail('not_in_run', `${tool} works only in a Work run`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function blobExists(dataDir: string, blobPath: string): boolean {
  return existsSync(isAbsolute(blobPath) ? blobPath : join(dataDir, blobPath));
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => {
        resolve(h.digest('hex'));
      });
  });
}

function encodeCursor(r: RunRow): string {
  return Buffer.from(JSON.stringify([r.updatedAt, r.id])).toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string')
      return { updatedAt: v[0], id: v[1] };
  } catch {
    // fall through
  }
  throw new NovaError('validation', 'invalid cursor');
}
