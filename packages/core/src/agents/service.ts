// Always-on agents (docs/09 §8; FR-079, FR-080, FR-082..FR-084, FR-089, FR-090, FR-181,
// FR-194, FR-206, FR-059, FR-072). An agent is a set of `agent` threads (its main thread, a
// proactive research thread, one thread per channel binding) plus the Work runs it delegated,
// with the user's instructions, responsibilities, rules, goal and notes. Its turns run in the one
// chat loop (ADR-076): the agents area starts them through the TurnStarter (schedule fires,
// self-set wakes, goal continuations, proactive research, background results) and shapes every
// turn on its threads through the TurnExtension (context, budgets, onEnd).
//
// Decisions (docs/09 §8 leaves them open; recorded for ADRs):
// - Budgets are per turn chain (a turn plus its hook continuations): each chain gets the agent's
//   time, token and cost budgets afresh; a goal's budgets cap the goal turns together. No agent
//   run row is made per wake: a run is one thread (uq_run_thread) and an agent has several.
// - Proactive research runs in its own `agent` thread (child of the main one) with trigger
//   `schedule` and trigger_ref `proactive:<agentId>`, the `read-only` profile and a deny rule for
//   every action that is not read-only; its reply becomes an observation note and a suggestion.
// - Pause disables the agent's enabled schedules and pauses its live runs, remembering both, and
//   resume restores them (a wake whose time passed during the pause fires a minute later). Stop
//   cancels the current turns and background runs; status `stopped` lasts until the next turn
//   (any trigger) or a resume, and meanwhile nothing starts on its own (proactive, goal).
// - The user typing in a paused agent's thread resumes it, as a run (docs/09 §3); an agent
//   paused by safety monitoring refuses every turn until the user resumes it.
// - Agent-written notes join the context only of turns the agent starts itself (they would taint
//   a turn the user typed, which would stop "when you say so" rules); in a typed turn the agent
//   reads them with agent.notes.
// - In a `shared` thread only memory that came from shared threads joins the context; private
//   items reach a shared channel only through the channels area's check (FR-088, originOf).
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type ActivityItemView,
  type AgentBackgroundView,
  type AgentMemoryItemView,
  type AgentResponsibilityView,
  type AgentRuleCommand,
  type AgentRuleMatch,
  type AgentRuleView,
  type AgentSuggestionView,
  type AgentThreadView,
  type AgentView,
  type BudgetAmounts,
  type CreateAgentRequest,
  type CreateAgentRuleRequest,
  type DerivedStatus,
  type EventEnvelope,
  type ExternalAgentView,
  type GoalStatus,
  type GoalView,
  type RunAutonomy,
  type StatusView,
  type UpdateAgentRequest,
  type UpdateAgentRuleRequest,
  type AgentRulePreviewItem,
} from '@nova/shared';
import type { PolicyRule } from '@nova/policy';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { createHash } from 'node:crypto';
import { readAttachmentBlob, writeAttachmentBlob } from '../attachments.ts';
import type { EventSink } from '../events.ts';
import { extractFacts, memoryKey } from '../memory.ts';
import { buildActivity } from '../ops/activity.ts';
import { prepareAvatar, sniffImage, type AvatarMime } from '../profile/avatar.ts';
import { removeUnreferencedBlobs } from '../purge.ts';
import { runEventItem } from '../runs/activity.ts';
import {
  BLOCKED_AFTER,
  checkAgentStatus,
  goalHit,
  goalLimits,
  nextBlockerCount,
  normalizeBlockerKey,
  remainingText,
  type GoalLimits,
} from '../runs/goals.ts';
import { clipText, goalContinuationText } from '../runs/prompts.ts';
import { toGoalView, type GoalRow, type Usage } from '../runs/views.ts';
import type {
  BoundHit,
  ContextBlock,
  StartTurnInput,
  StartedTurn,
  ThreadPolicy,
  ThreadPolicySource,
  ThreadStatusSource,
  TurnAddition,
  TurnExtension,
  TurnOutcome,
  TurnStarter,
  TurnTrigger,
} from '../runtime/types.ts';
import type { AgentFireInput, AgentFireTarget, ScheduleInput } from '../scheduler/service.ts';
import type { ThreadService } from '../threads.ts';
import type { AuditRecord, AuditSink, Notifier, ToolSourceProvider } from '../tools/types.ts';
import {
  detectExternalAgent,
  externalAgentDecision,
  looksLikeAgent,
  namesAgent,
  normalizeCounterpart,
} from './external.ts';
import {
  agentGuide,
  backgroundResultText,
  isNothingNew,
  PROACTIVE_GUIDE,
  proactiveText,
  suggestionOf,
  wakeText,
} from './prompts.ts';
import {
  checkAgentRule,
  engineCommandRule,
  engineRules,
  previewMatches,
  rulesSummary,
  type AgentRuleLike,
} from './rules.ts';
import { agentTools, type AgentToolHost } from './tools.ts';
import type {
  AgentBinding,
  AgentComputers,
  AgentDeleteHook,
  AgentPolicySource,
  AgentRuns,
  AgentScheduler,
  AgentSettings,
  AgentThreadLink,
  AgentThreadPolicy,
  ExternalAgentGuard,
  ExternalCounterpart,
  QuietHours,
} from './types.ts';

const {
  agent: agentT,
  agentThread: linkT,
  agentResponsibility: respT,
  agentRule: ruleT,
  agentMemory: memT,
  agentSuggestion: sugT,
  agentWake: wakeT,
  externalAgent: extT,
  goal: goalT,
  memoryItem: itemT,
} = schema;

export type AgentRow = typeof agentT.$inferSelect;
type LinkRow = typeof linkT.$inferSelect;
type RespRow = typeof respT.$inferSelect;
type RuleRow = typeof ruleT.$inferSelect;
type MemRow = typeof memT.$inferSelect;
type SugRow = typeof sugT.$inferSelect;
type ItemRow = typeof itemT.$inferSelect;

/** Timer functions, replaced by a simulated clock in tests. */
export interface AgentTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: AgentTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface AgentServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  threads: ThreadService;
  settings: AgentSettings;
  /** Where blobs live (avatars are sealed blobs, as the account avatar). */
  dataDir: string;
  audit?: AuditSink;
  notifier?: Notifier;
  log?: Logger;
  now?: () => Date;
  timers?: AgentTimers;
  /** Idle time before a goal continuation starts (docs/09 §2.1): 5 s. */
  goalDebounceMs?: number;
  /** How often idle agents are checked for proactive research: 60 s. */
  proactiveCheckMs?: number;
}

/** The derived status of threads, from the shared thread status service (FR-215). */
export type AgentStatusLookup = (
  accountId: string,
  threadIds: string[],
) => Promise<Map<string, StatusView>>;

type TurnKind =
  'typed' | 'channel' | 'fire' | 'goal' | 'proactive' | 'result' | 'session' | 'other';

interface PendingTurn {
  kind: TurnKind;
  authority: 'user' | 'none';
  goalId: string | null;
}

interface ActiveTurn {
  turnId: string;
  agentId: string;
  threadKind: AgentThreadLink['kind'];
  kind: TurnKind;
  authority: 'user' | 'none';
  trigger: TurnTrigger;
  goalId: string | null;
  /** The blocker key this goal turn reported. */
  blocker: string | null;
  /** A proactive turn tried something that is not read-only and was stopped. */
  denied: boolean;
}

interface Meter {
  limits: { timeMs: number; tokens: number; costUsd: number | null };
  used: Usage;
  goal: { id: string; limits: GoalLimits; used: Usage } | null;
}

interface AgentMeta {
  pausedSchedules?: string[];
  pausedRuns?: string[];
}

const AUTONOMY_POLICY = {
  ask_first: 'ask_always',
  standard: 'defaults',
  autonomous: 'review',
} as const;

const PRECEDENCE: Record<DerivedStatus, number> = {
  needs_input: 1,
  blocked: 2,
  running: 3,
  ready: 4,
};

const LIVE_RUN = ['planning', 'running', 'waiting_approval'];
const MAX_NOTES_CONTEXT = 6000;
const MAX_ACTIVITY = 2000;

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function emptyUsage(): Usage {
  return { timeMs: 0, tokens: 0, costUsd: 0 };
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

function goalUsage(g: GoalRow): Usage {
  return { timeMs: g.timeUsedMs, tokens: g.tokensUsed, costUsd: g.costUsedUsd };
}

function respView(r: RespRow): AgentResponsibilityView {
  return {
    id: r.id,
    agentId: r.agentId,
    title: r.title,
    instructions: r.instructions,
    status: r.status,
    goalId: r.goalId,
    progressNote: r.progressNote,
    position: r.position,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function ruleLike(r: RuleRow): AgentRuleLike {
  return {
    id: r.id,
    agentId: r.agentId,
    description: r.description,
    effect: r.effect,
    match: parseJson<AgentRuleMatch>(r.matcherJson) ?? {},
    command: parseJson<AgentRuleCommand>(r.commandJson),
    priority: r.priority,
    enabled: r.enabled,
  };
}

function ruleView(r: RuleRow): AgentRuleView {
  const l = ruleLike(r);
  return {
    id: r.id,
    agentId: r.agentId,
    description: r.description,
    effect: r.effect,
    match: l.match,
    command: l.command,
    priority: r.priority,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function noteView(r: MemRow): AgentMemoryItemView {
  return {
    id: r.id,
    agentId: r.agentId,
    store: 'notes',
    kind: r.kind,
    content: r.content,
    author: r.author,
    source: r.source,
    sourceThreadId: r.sourceThreadId,
    responsibilityId: r.responsibilityId,
    pinned: r.pinned,
    originAudience: r.originAudience,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function itemView(r: ItemRow, agentId: string): AgentMemoryItemView {
  return {
    id: r.id,
    agentId,
    store: 'conversation',
    kind: r.kind === 'preference' ? 'preference' : 'fact',
    content: r.content,
    author: 'user',
    source: 'conversation',
    sourceThreadId: r.sourceThreadId,
    responsibilityId: null,
    pinned: r.pinned,
    originAudience: r.originAudience,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function suggestionView(r: SugRow): AgentSuggestionView {
  return {
    id: r.id,
    agentId: r.agentId,
    noteId: r.noteId,
    title: r.title,
    body: r.body,
    status: r.status,
    threadId: r.threadId,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}

function linkOf(r: LinkRow): AgentThreadLink {
  return {
    agentId: r.agentId,
    threadId: r.threadId,
    kind: r.kind,
    audience: r.audience,
    bindingRef: r.bindingRef,
    runId: r.runId,
  };
}

/** Activity items for the agent's own events (docs/09 §9). */
function agentEventItem(e: EventEnvelope): ActivityItemView | null {
  const p = e.payload;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const notice = (title: string, detail: string | null = null, status: string | null = null) => ({
    id: e.id,
    ts: e.ts,
    kind: 'notice' as const,
    title,
    detail,
    status,
    callId: null,
    turnId: e.correlation?.turnId ?? null,
  });
  switch (e.name) {
    case 'agent.created':
      return notice('Agent created');
    case 'agent.status.changed':
      return notice(`Agent ${s(p.to) ?? 'changed'}`, s(p.reason), s(p.to));
    case 'agent.rule.changed':
      return notice(`Rule ${s(p.change) ?? 'changed'}`, s(p.description));
    case 'agent.research.finding':
      return notice('Proactive research finding', s(p.summary));
    case 'agent.suggestion.updated':
      return notice(`Suggestion ${s(p.status) ?? 'updated'}`);
    case 'agent.budget.reached':
      return notice(`Budget reached: ${s(p.bound) ?? ''}`.trim(), null, 'blocked');
    case 'agent.background.started':
      return notice('Background work started', s(p.title), 'running');
    case 'schedule.wake.set':
      return notice('Wake-up set', s(p.reason));
    case 'schedule.fired':
      return notice('Scheduled turn', null, 'running');
    default:
      return null;
  }
}

/** Parse "45m", "2h", "1d", "90s", ISO "PT30M"/"P2D", or a number of seconds. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v * 1000);
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  const simple =
    /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(t);
  if (simple) {
    const n = Number(simple[1]);
    const unit = simple[2] ?? 's';
    const mult = unit.startsWith('s')
      ? 1000
      : unit.startsWith('m')
        ? 60_000
        : unit.startsWith('h')
          ? 3_600_000
          : 86_400_000;
    return Math.round(n * mult);
  }
  const iso = /^p(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?)?$/.exec(t);
  if (iso && t !== 'p' && t !== 'pt') {
    const [, d, h, m, s] = iso;
    return (
      Number(d ?? 0) * 86_400_000 +
      Number(h ?? 0) * 3_600_000 +
      Number(m ?? 0) * 60_000 +
      Number(s ?? 0) * 1000
    );
  }
  return null;
}

export class AgentService implements AgentToolHost {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #threads: ThreadService;
  readonly #settings: AgentSettings;
  readonly #dataDir: string;
  readonly #audit: AuditSink | undefined;
  readonly #notifier: Notifier | undefined;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #timers: AgentTimers;
  readonly #debounceMs: number;
  readonly #checkMs: number;
  #turns: TurnStarter | null = null;
  #runs: AgentRuns | null = null;
  #scheduler: AgentScheduler | null = null;
  #computers: AgentComputers | null = null;
  #quiet: QuietHours | null = null;
  #statusOf: AgentStatusLookup | null = null;
  readonly #deleteHooks: AgentDeleteHook[] = [];
  #closed = false;
  #started = false;
  #proactiveTimer: unknown = null;

  /** Turns running on agent threads, by thread. */
  readonly #active = new Map<string, ActiveTurn>();
  /** Turns the service is starting, until the loop asks the extension about them. */
  readonly #pending = new Map<string, PendingTurn>();
  /** Turns the loop queued behind a running one, by turn id. */
  readonly #queued = new Map<string, PendingTurn & { threadId: string }>();
  /** The budget meter of each thread's current turn chain. */
  readonly #chains = new Map<string, Meter>();
  readonly #goalTimers = new Map<string, unknown>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #deleting = new Set<string>();
  readonly #writes = new Map<string, Promise<void>>();

  readonly extension: TurnExtension;
  readonly policy: ThreadPolicySource;
  readonly agentPolicy: AgentPolicySource;
  readonly status: ThreadStatusSource;
  readonly toolSource: ToolSourceProvider;
  readonly scheduleTarget: AgentFireTarget;
  readonly externalAgentGuard: ExternalAgentGuard;
  /** The private-to-shared check of the channels area reads where an item came from (FR-088). */
  readonly memory: {
    originOf(accountId: string, itemId: string): Promise<'private' | 'shared' | null>;
    /** Notes that came from private threads, for the channels area's overlap check. */
    privateNotes(
      accountId: string,
      agentId: string | null,
    ): Promise<{ id: string; text: string }[]>;
  };

  constructor(opts: AgentServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#threads = opts.threads;
    this.#settings = opts.settings;
    this.#dataDir = opts.dataDir;
    this.#audit = opts.audit;
    this.#notifier = opts.notifier;
    this.#log = opts.log ?? new Logger({ module: 'core.agents', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#timers = opts.timers ?? realTimers;
    this.#debounceMs = opts.goalDebounceMs ?? 5_000;
    this.#checkMs = opts.proactiveCheckMs ?? 60_000;
    this.extension = { forTurn: (input) => this.#forTurn(input) };
    this.policy = { forThread: (accountId, threadId) => this.#threadPolicy(accountId, threadId) };
    this.agentPolicy = {
      forThread: (accountId, threadId) => this.#agentThreadPolicy(accountId, threadId),
    };
    this.status = {
      blocked: (accountId, threadIds) => this.#blockedThreads(accountId, threadIds),
      children: (accountId, threadId) => this.#childThreads(accountId, threadId),
    };
    const tools = agentTools(this);
    this.toolSource = {
      source: 'builtin',
      list: (accountId, scope) => {
        // Without a scope (catalogs) everything but the goal tools, whose names the runs area
        // lists already; handlers refuse outside agent threads.
        if (!scope) return Promise.resolve(tools.catalog);
        if (scope.mode !== 'agent' || !scope.threadId) return Promise.resolve([]);
        const link = this.#link(scope.threadId);
        if (!link || link.accountId !== accountId) return Promise.resolve([]);
        return Promise.resolve(link.kind === 'proactive' ? tools.read : tools.all);
      },
    };
    this.scheduleTarget = { fire: (input) => this.#fire(input) };
    this.externalAgentGuard = {
      inbound: (input) => this.#inbound(input),
      check: (input) => this.#checkExternal(input),
    };
    this.memory = {
      originOf: (accountId, itemId) => this.#originOf(accountId, itemId),
      privateNotes: (accountId, agentId) => Promise.resolve(this.#privateNotes(accountId, agentId)),
    };
  }

  // ---- wiring ---------------------------------------------------------------------------------

  /** The chat loop that runs turns (the ChatService); bound after it is built. */
  useTurns(starter: TurnStarter): void {
    this.#turns = starter;
  }

  /** Work runs: delegation and background work (FR-059, FR-083), paused with the agent. */
  useRuns(runs: AgentRuns): void {
    this.#runs = runs;
  }

  /** The scheduler: agent schedules and self-set wakes (FR-059, FR-206). */
  useScheduler(scheduler: AgentScheduler): void {
    this.#scheduler = scheduler;
  }

  /** The computers area: each agent's persistent computer (FR-080). */
  useComputers(computers: AgentComputers): void {
    this.#computers = computers;
  }

  /** Quiet hours from the notification rules (channels area). */
  useQuietHours(fn: QuietHours): void {
    this.#quiet = fn;
  }

  /** The shared derived status (FR-215). */
  useStatus(fn: AgentStatusLookup): void {
    this.#statusOf = fn;
  }

  /** Revoke what other areas hold for an agent when it is deleted (FR-090). */
  onDelete(hook: AgentDeleteHook): void {
    this.#deleteHooks.push(hook);
  }

  /** Start the proactive research loop (FR-082). */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#armProactive();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#proactiveTimer !== null) this.#timers.clear(this.#proactiveTimer);
    this.#proactiveTimer = null;
    for (const h of this.#goalTimers.values()) this.#timers.clear(h);
    this.#goalTimers.clear();
    await Promise.allSettled([...this.#background, ...this.#writes.values()]);
  }

  /** Wait for background work (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const waits = [...this.#background, ...this.#locks.values(), ...this.#writes.values()];
      if (!waits.length) return;
      await Promise.allSettled(waits);
    }
  }

  // ---- agents: create, read, update, delete (FR-079, FR-090) ----------------------------------

  async create(accountId: string, req: CreateAgentRequest): Promise<AgentView> {
    const autonomy = req.autonomy ?? (await this.#settings.autonomy());
    await this.#assertAutonomy(autonomy);
    const defaults = await this.#settings.defaultBudgets();
    const proactive = await this.#settings.proactive();
    const avatarPath = req.avatar ? this.#storeAvatar(req.avatar) : null;
    const id = uuidv7();
    const now = this.#iso();
    const name = req.name.trim();
    let threadId: string;
    try {
      const thread = await this.#threads.create(accountId, {
        mode: 'agent',
        title: name,
        // The agent keeps its own memory (FR-089); its threads stay out of chat memory.
        memoryOptOut: true,
        ...(req.model ? { model: req.model } : {}),
      });
      threadId = thread.id;
    } catch (err) {
      if (avatarPath) this.#dropAvatar(avatarPath);
      throw err;
    }
    const row: AgentRow = {
      id,
      accountId,
      name,
      avatarPath,
      instructions: req.instructions?.trim() ?? '',
      status: 'active',
      pauseReason: null,
      statusDetail: null,
      autonomy,
      model: req.model ?? null,
      computerId: null,
      primaryThreadId: threadId,
      proactive: req.proactive ?? proactive.enabledByDefault,
      memoryEnabled: req.memoryEnabled ?? true,
      timeBudgetS: req.budgets?.timeSeconds ?? defaults.timeSeconds,
      tokenBudget: req.budgets?.tokens ?? defaults.tokens,
      costBudgetUsd: req.budgets?.costUsd !== undefined ? req.budgets.costUsd : defaults.costUsd,
      timeUsedMs: 0,
      tokensUsed: 0,
      costUsedUsd: 0,
      lastProactiveAt: null,
      lastActiveAt: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(agentT).values(row);
      await this.#db.orm.insert(linkT).values({
        threadId,
        agentId: id,
        accountId,
        kind: 'main',
        bindingRef: null,
        audience: 'private',
        runId: null,
        createdAt: now,
      });
      for (const [i, r] of (req.responsibilities ?? []).entries())
        await this.#db.orm.insert(respT).values({
          id: uuidv7(),
          agentId: id,
          title: r.title,
          instructions: r.instructions?.trim() || null,
          status: 'active',
          goalId: null,
          progressNote: null,
          position: i,
          createdAt: now,
          updatedAt: now,
        });
    });
    await this.#emit('agent.created', row, { agentId: id }, 'user');
    await this.#auditAgent(row, 'user', 'agent.create', {
      autonomy,
      responsibilities: req.responsibilities?.length ?? 0,
      proactive: row.proactive,
    });
    this.#track(this.#ensureComputer(row));
    return this.#view(row);
  }

  async list(accountId: string): Promise<AgentView[]> {
    const rows = await this.#db.orm
      .select()
      .from(agentT)
      .where(eq(agentT.accountId, accountId))
      .orderBy(asc(agentT.createdAt), asc(agentT.id));
    return Promise.all(rows.map((r) => this.#view(r)));
  }

  async get(accountId: string, id: string): Promise<AgentView> {
    const row = await this.#row(accountId, id);
    if (!row.computerId) this.#track(this.#ensureComputer(row));
    return this.#view(row);
  }

  async update(accountId: string, id: string, req: UpdateAgentRequest): Promise<AgentView> {
    const changed: string[] = [];
    const out = await this.#lock(id, async () => {
      const row = await this.#row(accountId, id);
      const set: Partial<AgentRow> = { updatedAt: this.#iso() };
      if (req.name !== undefined && req.name.trim() !== row.name) {
        set.name = req.name.trim();
        changed.push('name');
      }
      if (req.instructions !== undefined) {
        set.instructions = req.instructions.trim();
        changed.push('instructions');
      }
      if (req.autonomy !== undefined && req.autonomy !== row.autonomy) {
        await this.#assertAutonomy(req.autonomy);
        set.autonomy = req.autonomy;
        changed.push('autonomy');
      }
      if (req.budgets) {
        if (req.budgets.timeSeconds !== undefined) set.timeBudgetS = req.budgets.timeSeconds;
        if (req.budgets.tokens !== undefined) set.tokenBudget = req.budgets.tokens;
        if (req.budgets.costUsd !== undefined) set.costBudgetUsd = req.budgets.costUsd;
        changed.push('budgets');
      }
      if (req.proactive !== undefined) {
        set.proactive = req.proactive;
        changed.push('proactive');
      }
      if (req.model !== undefined) {
        set.model = req.model;
        changed.push('model');
      }
      let oldAvatar: string | null = null;
      if (req.avatar !== undefined) {
        set.avatarPath = req.avatar ? this.#storeAvatar(req.avatar) : null;
        oldAvatar = row.avatarPath;
        changed.push('avatar');
      }
      let purge = false;
      if (req.memoryEnabled !== undefined && req.memoryEnabled !== row.memoryEnabled) {
        set.memoryEnabled = req.memoryEnabled;
        purge = !req.memoryEnabled;
        changed.push('memoryEnabled');
      }
      await this.#db.transaction(() =>
        this.#db.orm.update(agentT).set(set).where(eq(agentT.id, id)),
      );
      if (oldAvatar && oldAvatar !== set.avatarPath) this.#dropAvatar(oldAvatar);
      if (set.name && row.primaryThreadId)
        await this.#threads
          .update(accountId, row.primaryThreadId, { title: set.name })
          .catch(() => undefined);
      const next = { ...row, ...set };
      if (purge) await this.#purgeDerivedMemory(next);
      return next;
    });
    if (changed.length) {
      await this.#emit('agent.updated', out, { agentId: id, changed }, 'user');
      await this.#auditAgent(out, 'user', 'agent.update', { changed });
    }
    return this.#view(out);
  }

  /**
   * Delete an agent (FR-090): irreversible, and actions it already took are not undone. Its turns
   * and background runs stop, other areas revoke what they hold (bindings, grants, triggers, its
   * computer; a failure there stops the delete before anything is removed), then its schedules,
   * goal, memory, threads and rows go. Delegated runs stay in the Work list as history.
   */
  async remove(accountId: string, id: string): Promise<void> {
    const row = await this.#row(accountId, id);
    this.#deleting.add(id);
    try {
      this.#clearGoalTimer(id);
      await this.#cancelTurns(row);
      await this.#controlRuns(row, 'cancel');
      for (const hook of this.#deleteHooks) {
        try {
          await hook(accountId, id);
        } catch (err) {
          this.#log.warn('could not revoke for a deleted agent', { err, agentId: id });
          throw new NovaError(
            'server_error',
            'the agent could not be deleted: revoking its bindings, grants or computer failed; try again',
            { retryable: true },
          );
        }
      }
      let schedules = 0;
      if (this.#scheduler) {
        for (const s of await this.#scheduler.listForAgent(accountId, id)) {
          await this.#scheduler.remove(accountId, s.id, { actor: 'system' }).catch(() => undefined);
          schedules++;
        }
      }
      const links = await this.#links(id);
      await this.#db.transaction(() => {
        this.#db.raw.prepare('DELETE FROM goal WHERE agent_id = ?').run(id);
        this.#db.raw
          .prepare("DELETE FROM memory_item WHERE scope_kind = 'agent' AND scope_ref = ?")
          .run(id);
        this.#db.raw.prepare('DELETE FROM agent WHERE id = ?').run(id);
      });
      for (const l of links) {
        if (l.kind === 'background') continue;
        await this.#threads.remove(accountId, l.threadId).catch(() => undefined);
        this.#chains.delete(l.threadId);
      }
      if (row.avatarPath) this.#dropAvatar(row.avatarPath);
      await this.#emit('agent.deleted', row, { agentId: id }, 'user');
      await this.#auditAgent(row, 'user', 'agent.delete', {
        schedules,
        threads: links.filter((l) => l.kind !== 'background').length,
      });
    } finally {
      this.#deleting.delete(id);
    }
  }

  async avatar(accountId: string, id: string): Promise<{ bytes: Buffer; mime: AvatarMime } | null> {
    const row = await this.#row(accountId, id);
    if (!row.avatarPath) return null;
    let bytes: Buffer;
    try {
      bytes = readAttachmentBlob(this.#dataDir, row.avatarPath);
    } catch (err) {
      if (err instanceof NovaError && err.code === 'not_found') return null;
      throw err;
    }
    const mime = sniffImage(bytes);
    return mime ? { bytes, mime } : null;
  }

  // ---- pause, resume, stop (FR-090) -------------------------------------------------------------

  /**
   * Pause the agent with everything it started: its turns stop, its live background runs pause
   * and its enabled schedules and self-set wakes are disabled until it resumes.
   */
  async pause(
    accountId: string,
    id: string,
    opts: { reason?: 'user' | 'safety'; detail?: string | null; actor?: string } = {},
  ): Promise<AgentView> {
    const reason = opts.reason ?? 'user';
    const actor = opts.actor ?? (reason === 'safety' ? 'system' : 'user');
    let from: AgentRow['status'] = 'active';
    const row = await this.#lock(id, async () => {
      const cur = await this.#row(accountId, id);
      from = cur.status;
      if (cur.status === 'paused' && !(reason === 'safety' && cur.pauseReason === 'user'))
        return null;
      const meta = parseJson<AgentMeta>(cur.metadata) ?? {};
      const schedules = new Set(meta.pausedSchedules ?? []);
      if (this.#scheduler) {
        for (const s of await this.#scheduler.listForAgent(accountId, id)) {
          if (!s.enabled) continue;
          try {
            await this.#scheduler.update(accountId, s.id, { enabled: false }, { actor: 'system' });
            schedules.add(s.id);
          } catch (err) {
            this.#log.warn('could not pause an agent schedule', { err, scheduleId: s.id });
          }
        }
      }
      const runs = new Set(meta.pausedRuns ?? []);
      for (const runId of await this.#controlRuns(cur, 'pause')) runs.add(runId);
      const set: Partial<AgentRow> = {
        status: 'paused',
        pauseReason: reason,
        statusDetail: opts.detail ?? null,
        metadata: JSON.stringify({ pausedSchedules: [...schedules], pausedRuns: [...runs] }),
        updatedAt: this.#iso(),
      };
      await this.#db.transaction(() =>
        this.#db.orm.update(agentT).set(set).where(eq(agentT.id, id)),
      );
      this.#clearGoalTimer(id);
      return { ...cur, ...set };
    });
    if (!row) return this.get(accountId, id);
    await this.#cancelTurns(row);
    await this.#statusChanged(row, from, 'paused', opts.detail ?? reason, actor);
    await this.#emit('agent.paused', row, { agentId: id, reason }, actor);
    await this.#auditAgent(row, actor, reason === 'safety' ? 'agent.auto_pause' : 'agent.pause', {
      reason,
      ...(opts.detail ? { detail: opts.detail } : {}),
    });
    if (reason === 'safety')
      await this.#notify(row, 'attention', `${row.name} was paused for safety`, opts.detail ?? '');
    return this.#view(row);
  }

  /** Safety monitoring stops an agent until the user resumes it (FR-090). */
  autoPause(accountId: string, id: string, reason: string): Promise<AgentView> {
    return this.pause(accountId, id, { reason: 'safety', detail: reason, actor: 'system' });
  }

  /** Resume a paused or stopped agent: its schedules, wakes and runs go on (FR-090). */
  async resume(accountId: string, id: string, actor = 'user'): Promise<AgentView> {
    const cur = await this.#row(accountId, id);
    if (cur.status === 'active') throw new NovaError('conflict', 'the agent is not paused');
    const row = await this.#resumeLocked(cur, actor);
    return this.#view(row);
  }

  /** Stop the current work (FR-090): turns and background runs end; partial results stay. */
  async stop(accountId: string, id: string): Promise<AgentView> {
    const cur = await this.#row(accountId, id);
    await this.#cancelTurns(cur);
    const cancelled = await this.#controlRuns(cur, 'cancel');
    this.#clearGoalTimer(id);
    let row = cur;
    if (cur.status === 'active') {
      row = await this.#lock(id, async () => {
        const fresh = await this.#row(accountId, id);
        if (fresh.status !== 'active') return fresh;
        const set: Partial<AgentRow> = {
          status: 'stopped',
          statusDetail: 'stopped by the user',
          updatedAt: this.#iso(),
        };
        await this.#db.transaction(() =>
          this.#db.orm.update(agentT).set(set).where(eq(agentT.id, id)),
        );
        return { ...fresh, ...set };
      });
      if (row.status === 'stopped')
        await this.#statusChanged(row, 'active', 'stopped', 'stopped by the user', 'user');
    }
    await this.#auditAgent(row, 'user', 'agent.stop', { runs: cancelled.length });
    return this.#view(row);
  }

  async #resumeLocked(cur: AgentRow, actor: string): Promise<AgentRow> {
    const from = cur.status;
    const row = await this.#lock(cur.id, async () => {
      const fresh = await this.#row(cur.accountId, cur.id);
      if (fresh.status === 'active') return null;
      const meta = parseJson<AgentMeta>(fresh.metadata) ?? {};
      const scheduler = this.#scheduler;
      if (scheduler && meta.pausedSchedules?.length) {
        const mine = new Map(
          (await scheduler.listForAgent(fresh.accountId, fresh.id)).map((s) => [s.id, s]),
        );
        const now = this.#now().getTime();
        for (const sid of meta.pausedSchedules) {
          const s = mine.get(sid);
          if (!s) continue;
          // A wake whose time passed during the pause fires a minute after the resume.
          const late = 'at' in s.when && Date.parse(s.when.at) <= now;
          const patch = late
            ? { enabled: true, when: { at: new Date(now + 60_000).toISOString() } }
            : { enabled: true };
          await scheduler
            .update(fresh.accountId, sid, patch, { actor: 'system' })
            .catch((err: unknown) => {
              this.#log.warn('could not resume an agent schedule', { err, scheduleId: sid });
            });
        }
      }
      for (const runId of meta.pausedRuns ?? [])
        await this.#runs?.resume?.(fresh.accountId, runId).catch(() => undefined);
      const set: Partial<AgentRow> = {
        status: 'active',
        pauseReason: null,
        statusDetail: null,
        metadata: null,
        updatedAt: this.#iso(),
      };
      await this.#db.transaction(() =>
        this.#db.orm.update(agentT).set(set).where(eq(agentT.id, fresh.id)),
      );
      return { ...fresh, ...set };
    });
    if (!row) return this.#row(cur.accountId, cur.id);
    await this.#statusChanged(row, from, 'active', null, actor);
    await this.#emit('agent.resumed', row, { agentId: row.id }, actor);
    await this.#auditAgent(row, actor, 'agent.resume', { from });
    await this.#kickGoal(row);
    return row;
  }

  // ---- responsibilities (FR-079) --------------------------------------------------------------

  async listResponsibilities(accountId: string, id: string): Promise<AgentResponsibilityView[]> {
    await this.#row(accountId, id);
    return (await this.#resps(id)).map(respView);
  }

  async addResponsibility(
    accountId: string,
    id: string,
    req: { title: string; instructions?: string | undefined },
  ): Promise<AgentResponsibilityView> {
    const row = await this.#row(accountId, id);
    const now = this.#iso();
    const position = (await this.#resps(id)).length;
    const r: RespRow = {
      id: uuidv7(),
      agentId: id,
      title: req.title.trim(),
      instructions: req.instructions?.trim() || null,
      status: 'active',
      goalId: null,
      progressNote: null,
      position,
      createdAt: now,
      updatedAt: now,
    };
    await this.#db.transaction(() => this.#db.orm.insert(respT).values(r));
    await this.#respChanged(row, r.id, 'created');
    return respView(r);
  }

  async updateResponsibility(
    accountId: string,
    id: string,
    rid: string,
    req: {
      title?: string | undefined;
      instructions?: string | null | undefined;
      status?: 'active' | 'paused' | 'done' | undefined;
      position?: number | undefined;
    },
  ): Promise<AgentResponsibilityView> {
    const row = await this.#row(accountId, id);
    const cur = await this.#resp(id, rid);
    const set: Partial<RespRow> = { updatedAt: this.#iso() };
    if (req.title !== undefined) set.title = req.title.trim();
    if (req.instructions !== undefined) set.instructions = req.instructions?.trim() || null;
    if (req.status !== undefined) set.status = req.status;
    if (req.position !== undefined) set.position = req.position;
    await this.#db.transaction(() => this.#db.orm.update(respT).set(set).where(eq(respT.id, rid)));
    await this.#respChanged(row, rid, 'updated');
    return respView({ ...cur, ...set });
  }

  async removeResponsibility(accountId: string, id: string, rid: string): Promise<void> {
    const row = await this.#row(accountId, id);
    await this.#resp(id, rid);
    await this.#db.transaction(() => this.#db.orm.delete(respT).where(eq(respT.id, rid)));
    await this.#respChanged(row, rid, 'deleted');
  }

  async #respChanged(row: AgentRow, rid: string, change: string): Promise<void> {
    await this.#emit(
      'agent.responsibility.changed',
      row,
      { agentId: row.id, responsibilityId: rid, change },
      'user',
    );
    await this.#auditAgent(
      row,
      'user',
      `agent.responsibility.${change === 'created' ? 'create' : change === 'updated' ? 'update' : 'delete'}`,
      {
        responsibilityId: rid,
      },
    );
  }

  // ---- rules (FR-084) ---------------------------------------------------------------------------

  async listRules(accountId: string, id: string): Promise<AgentRuleView[]> {
    await this.#row(accountId, id);
    return (await this.#rules(id)).map(ruleView);
  }

  async createRule(
    accountId: string,
    id: string,
    req: CreateAgentRuleRequest,
  ): Promise<AgentRuleView> {
    const row = await this.#row(accountId, id);
    const match = req.match ?? {};
    const command = req.command ?? null;
    checkAgentRule({ effect: req.effect, match, command });
    const now = this.#iso();
    const r: RuleRow = {
      id: uuidv7(),
      agentId: id,
      description: req.description.trim(),
      matcherJson: JSON.stringify(match),
      commandJson: command ? JSON.stringify(command) : null,
      effect: req.effect,
      priority: req.priority ?? 100,
      enabled: req.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await this.#db.transaction(() => this.#db.orm.insert(ruleT).values(r));
    await this.#ruleChanged(row, r, 'created');
    return ruleView(r);
  }

  async updateRule(
    accountId: string,
    id: string,
    ruleId: string,
    req: UpdateAgentRuleRequest,
  ): Promise<AgentRuleView> {
    const row = await this.#row(accountId, id);
    const cur = await this.#rule(id, ruleId);
    const curLike = ruleLike(cur);
    const effect = req.effect ?? cur.effect;
    const match = req.match ?? curLike.match;
    const command = req.command !== undefined ? req.command : curLike.command;
    checkAgentRule({ effect, match, command });
    const set: Partial<RuleRow> = {
      effect,
      matcherJson: JSON.stringify(match),
      commandJson: command ? JSON.stringify(command) : null,
      updatedAt: this.#iso(),
    };
    if (req.description !== undefined) set.description = req.description.trim();
    if (req.priority !== undefined) set.priority = req.priority;
    if (req.enabled !== undefined) set.enabled = req.enabled;
    await this.#db.transaction(() =>
      this.#db.orm.update(ruleT).set(set).where(eq(ruleT.id, ruleId)),
    );
    const next = { ...cur, ...set };
    await this.#ruleChanged(row, next, 'updated');
    return ruleView(next);
  }

  async deleteRule(accountId: string, id: string, ruleId: string): Promise<void> {
    const row = await this.#row(accountId, id);
    const cur = await this.#rule(id, ruleId);
    await this.#db.transaction(() => this.#db.orm.delete(ruleT).where(eq(ruleT.id, ruleId)));
    await this.#ruleChanged(row, cur, 'deleted');
  }

  /** Recent tool calls of the agent's threads the rule would have matched (docs/12 §3). */
  async previewRule(
    accountId: string,
    id: string,
    ruleId: string,
    limit = 50,
  ): Promise<AgentRulePreviewItem[]> {
    await this.#row(accountId, id);
    const rule = ruleLike(await this.#rule(id, ruleId));
    const threads = (await this.#links(id)).map((l) => l.threadId);
    if (!threads.length) return [];
    const rows = this.#db.raw
      .prepare(
        `SELECT id, thread_id AS threadId, tool_name AS tool, args_json AS args, status, decision,
           created_at AS createdAt
         FROM tool_call WHERE thread_id IN (${threads.map(() => '?').join(', ')})
         ORDER BY created_at DESC LIMIT 500`,
      )
      .all(...threads) as {
      id: string;
      threadId: string;
      tool: string;
      args: string;
      status: string;
      decision: string | null;
      createdAt: string;
    }[];
    return rows
      .filter((r) => previewMatches(rule, { tool: r.tool, args: parseJson<unknown>(r.args) }))
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((r) => ({
        callId: r.id,
        threadId: r.threadId,
        tool: r.tool,
        status: r.status,
        decision: r.decision,
        createdAt: r.createdAt,
      }));
  }

  async #ruleChanged(row: AgentRow, r: RuleRow, change: string): Promise<void> {
    await this.#emit(
      'agent.rule.changed',
      row,
      { agentId: row.id, ruleId: r.id, change, description: r.description },
      'user',
    );
    await this.#auditAgent(
      row,
      'user',
      `agent.rule.${change === 'created' ? 'create' : change === 'updated' ? 'update' : 'delete'}`,
      { ruleId: r.id, effect: r.effect, enabled: r.enabled },
    );
  }

  // ---- memory (FR-089) ------------------------------------------------------------------------

  /** Notes and conversation memory, pinned first, newest change first. */
  async listMemory(accountId: string, id: string): Promise<AgentMemoryItemView[]> {
    await this.#row(accountId, id);
    const notes = await this.#db.orm
      .select()
      .from(memT)
      .where(eq(memT.agentId, id))
      .orderBy(desc(memT.pinned), desc(memT.updatedAt), desc(memT.id));
    const items = await this.#db.orm
      .select()
      .from(itemT)
      .where(
        and(
          eq(itemT.accountId, accountId),
          eq(itemT.scopeKind, 'agent'),
          eq(itemT.scopeRef, id),
          eq(itemT.status, 'active'),
        ),
      )
      .orderBy(desc(itemT.pinned), desc(itemT.updatedAt), desc(itemT.id));
    return [...notes.map(noteView), ...items.map((i) => itemView(i, id))];
  }

  /** The user adds a note: the user's words, trusted in the agent's context. */
  async addNote(
    accountId: string,
    id: string,
    req: {
      content: string;
      kind?: 'note' | 'fact' | 'preference' | 'observation';
      responsibilityId?: string | undefined;
      pinned?: boolean | undefined;
    },
  ): Promise<AgentMemoryItemView> {
    const row = await this.#row(accountId, id);
    if (req.responsibilityId) await this.#resp(id, req.responsibilityId);
    const note = await this.#insertNote(row, {
      kind: req.kind ?? 'note',
      content: req.content,
      author: 'user',
      source: 'manual',
      sourceThreadId: null,
      responsibilityId: req.responsibilityId ?? null,
      pinned: req.pinned ?? false,
      audience: 'private',
    });
    await this.#auditAgent(row, 'user', 'agent.note.create', { noteId: note.id });
    return noteView(note);
  }

  async updateMemory(
    accountId: string,
    id: string,
    itemId: string,
    req: { content?: string | undefined; pinned?: boolean | undefined },
  ): Promise<AgentMemoryItemView> {
    const row = await this.#row(accountId, id);
    const now = this.#iso();
    const note = await this.#note(id, itemId);
    if (note) {
      const set: Partial<MemRow> = { updatedAt: now };
      // A note the user rewrote is the user's words from now on.
      if (req.content !== undefined) {
        set.content = req.content.trim();
        set.author = 'user';
      }
      if (req.pinned !== undefined) set.pinned = req.pinned;
      await this.#db.transaction(() =>
        this.#db.orm.update(memT).set(set).where(eq(memT.id, itemId)),
      );
      const next = { ...note, ...set };
      await this.#emit('agent.note.updated', row, { agentId: id, noteId: itemId }, 'user');
      await this.#auditAgent(row, 'user', 'agent.note.update', { noteId: itemId });
      return noteView(next);
    }
    const item = await this.#item(accountId, id, itemId);
    const set: Partial<ItemRow> = { updatedAt: now, userEdited: true };
    if (req.content !== undefined) {
      set.content = req.content.trim();
      set.contentKey = memoryKey(set.content);
    }
    if (req.pinned !== undefined) set.pinned = req.pinned;
    await this.#db.transaction(() =>
      this.#db.orm.update(itemT).set(set).where(eq(itemT.id, itemId)),
    );
    await this.#events.emit({
      name: 'memory.item.updated',
      actor: 'user',
      accountId,
      correlation: { agentId: id },
      payload: { itemId, scopeKind: 'agent' },
    });
    await this.#auditAgent(row, 'user', 'agent.memory.update', { itemId });
    return itemView({ ...item, ...set }, id);
  }

  /** Forget one item (FR-089). */
  async deleteMemory(accountId: string, id: string, itemId: string): Promise<void> {
    const row = await this.#row(accountId, id);
    const note = await this.#note(id, itemId);
    if (note) {
      await this.#db.transaction(() => this.#db.orm.delete(memT).where(eq(memT.id, itemId)));
      await this.#emit('agent.note.deleted', row, { agentId: id, noteId: itemId }, 'user');
      await this.#auditAgent(row, 'user', 'agent.note.delete', { noteId: itemId });
      return;
    }
    await this.#item(accountId, id, itemId);
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE memory_item SET supersedes_id = NULL WHERE supersedes_id = ?')
        .run(itemId);
      this.#db.raw.prepare('DELETE FROM memory_item WHERE id = ?').run(itemId);
    });
    await this.#events.emit({
      name: 'memory.item.deleted',
      actor: 'user',
      accountId,
      correlation: { agentId: id },
      payload: { itemId, scopeKind: 'agent' },
    });
    await this.#auditAgent(row, 'user', 'agent.memory.forget', { itemId });
  }

  /** Memory off: notes the agent derived and its conversation memory are purged (FR-089). */
  async #purgeDerivedMemory(row: AgentRow): Promise<void> {
    const counts = await this.#db.transaction(() => {
      const notes = this.#db.raw
        .prepare("DELETE FROM agent_memory WHERE agent_id = ? AND author = 'agent'")
        .run(row.id).changes;
      this.#db.raw
        .prepare(
          `UPDATE memory_item SET supersedes_id = NULL WHERE supersedes_id IN (
             SELECT id FROM memory_item WHERE scope_kind = 'agent' AND scope_ref = ?)`,
        )
        .run(row.id);
      const items = this.#db.raw
        .prepare("DELETE FROM memory_item WHERE scope_kind = 'agent' AND scope_ref = ?")
        .run(row.id).changes;
      return { notes: Number(notes), items: Number(items) };
    });
    await this.#emit('agent.memory.purged', row, { agentId: row.id, ...counts }, 'user');
    await this.#auditAgent(row, 'user', 'agent.memory.purge', counts);
  }

  async #originOf(accountId: string, itemId: string): Promise<'private' | 'shared' | null> {
    const note = this.#db.raw
      .prepare(
        `SELECT m.origin_audience AS a FROM agent_memory m JOIN agent g ON g.id = m.agent_id
         WHERE m.id = ? AND g.account_id = ?`,
      )
      .get(itemId, accountId) as { a: 'private' | 'shared' } | undefined;
    if (note) return Promise.resolve(note.a);
    const item = this.#db.raw
      .prepare('SELECT origin_audience AS a FROM memory_item WHERE id = ? AND account_id = ?')
      .get(itemId, accountId) as { a: 'private' | 'shared' } | undefined;
    return Promise.resolve(item?.a ?? null);
  }

  #privateNotes(accountId: string, agentId: string | null): { id: string; text: string }[] {
    return this.#db.raw
      .prepare(
        `SELECT m.id AS id, m.content AS text FROM agent_memory m JOIN agent g ON g.id = m.agent_id
         WHERE g.account_id = ? AND m.origin_audience = 'private' AND (? IS NULL OR g.id = ?)
         ORDER BY m.updated_at DESC LIMIT 500`,
      )
      .all(accountId, agentId, agentId) as { id: string; text: string }[];
  }

  async #insertNote(
    row: AgentRow,
    n: {
      kind: MemRow['kind'];
      content: string;
      author: MemRow['author'];
      source: MemRow['source'];
      sourceThreadId: string | null;
      responsibilityId: string | null;
      pinned: boolean;
      audience: 'private' | 'shared';
    },
  ): Promise<MemRow> {
    const now = this.#iso();
    const note: MemRow = {
      id: uuidv7(),
      agentId: row.id,
      kind: n.kind,
      content: clipText(n.content.trim(), 8000),
      author: n.author,
      source: n.source,
      sourceThreadId: n.sourceThreadId,
      responsibilityId: n.responsibilityId,
      pinned: n.pinned,
      originAudience: n.audience,
      createdAt: now,
      updatedAt: now,
    };
    await this.#db.transaction(() => this.#db.orm.insert(memT).values(note));
    await this.#emit(
      'agent.note.created',
      row,
      { agentId: row.id, noteId: note.id, kind: note.kind, author: note.author },
      n.author === 'user' ? 'user' : `agent:${row.id}`,
    );
    return note;
  }

  /** Explicit statements in what the user typed become the agent's conversation memory. */
  async #rememberTurn(row: AgentRow, link: AgentThreadLink, turnId: string): Promise<void> {
    if (!row.memoryEnabled) return;
    const texts = this.#db.raw
      .prepare(
        `SELECT p.content AS text FROM message m JOIN message_part p ON p.message_id = m.id
         WHERE m.turn_id = ? AND m.role = 'user' AND m.provenance = 'typed' AND p.type = 'text'`,
      )
      .all(turnId) as { text: string | null }[];
    const facts = extractFacts(texts.map((t) => t.text ?? '').join('\n')).slice(0, 20);
    if (!facts.length) return;
    const now = this.#iso();
    const created: string[] = [];
    await this.#db.transaction(async () => {
      for (const f of facts) {
        const key = memoryKey(f.content);
        if (!key) continue;
        const dup = this.#db.raw
          .prepare(
            `SELECT 1 AS x FROM memory_item WHERE account_id = ? AND scope_kind = 'agent'
             AND scope_ref = ? AND content_key = ? LIMIT 1`,
          )
          .get(row.accountId, row.id, key);
        if (dup) continue;
        const id = uuidv7();
        await this.#db.orm.insert(itemT).values({
          id,
          accountId: row.accountId,
          scopeKind: 'agent',
          scopeRef: row.id,
          content: f.content,
          contentKey: key,
          kind: null,
          category: f.category,
          confidence: 0.8,
          asOf: now,
          validUntil: null,
          sourceKind: 'chat',
          sourceThreadId: link.threadId,
          sourceMessageId: null,
          originAudience: link.audience,
          consolidationRunId: null,
          supersedesId: null,
          status: 'active',
          userEdited: false,
          pinned: false,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        created.push(id);
      }
    });
    for (const itemId of created)
      await this.#events.emit({
        name: 'memory.item.created',
        accountId: row.accountId,
        correlation: { agentId: row.id, threadId: link.threadId },
        payload: { itemId, scopeKind: 'agent' },
      });
  }

  // ---- suggestions (FR-082) ---------------------------------------------------------------------

  async listSuggestions(
    accountId: string,
    id: string,
    status?: 'open' | 'accepted' | 'dismissed',
  ): Promise<AgentSuggestionView[]> {
    await this.#row(accountId, id);
    const where = status
      ? and(eq(sugT.agentId, id), eq(sugT.status, status))
      : eq(sugT.agentId, id);
    const rows = await this.#db.orm
      .select()
      .from(sugT)
      .where(where)
      .orderBy(desc(sugT.createdAt), desc(sugT.id))
      .limit(200);
    return rows.map(suggestionView);
  }

  /**
   * The user accepts or dismisses a suggestion. Accepting only records it: a suggestion is the
   * agent's words, never the user's instruction (FR-189); the user acts by writing to the agent.
   */
  async decideSuggestion(
    accountId: string,
    id: string,
    sid: string,
    action: 'accept' | 'dismiss',
  ): Promise<AgentSuggestionView> {
    const row = await this.#row(accountId, id);
    const rows = await this.#db.orm
      .select()
      .from(sugT)
      .where(and(eq(sugT.id, sid), eq(sugT.agentId, id)))
      .limit(1);
    const cur = rows[0];
    if (!cur) throw new NovaError('not_found', 'suggestion not found');
    if (cur.status !== 'open')
      throw new NovaError('conflict', 'the suggestion was already decided');
    const set: Partial<SugRow> = {
      status: action === 'accept' ? 'accepted' : 'dismissed',
      decidedAt: this.#iso(),
    };
    await this.#db.transaction(() => this.#db.orm.update(sugT).set(set).where(eq(sugT.id, sid)));
    await this.#emit(
      'agent.suggestion.updated',
      row,
      { agentId: id, suggestionId: sid, status: set.status },
      'user',
    );
    await this.#auditAgent(row, 'user', `agent.suggestion.${action}`, { suggestionId: sid });
    return suggestionView({ ...cur, ...set });
  }

  // ---- threads, bindings, background work, activity ----------------------------------------------

  async threadsOf(accountId: string, id: string): Promise<AgentThreadView[]> {
    await this.#row(accountId, id);
    const rows = this.#db.raw
      .prepare(
        `SELECT l.thread_id AS threadId, l.kind, l.binding_ref AS bindingRef, l.audience,
           l.run_id AS runId, l.created_at AS createdAt, t.title
         FROM agent_thread l JOIN thread t ON t.id = l.thread_id
         WHERE l.agent_id = ? AND t.deleted_at IS NULL ORDER BY l.created_at, l.thread_id`,
      )
      .all(id) as Omit<AgentThreadView, 'agentId'>[];
    return rows.map((r) => ({ ...r, agentId: id }));
  }

  /**
   * The thread of a channel binding (FR-088, docs/13 §4, ADR-070), created on first use; a
   * private binding may share the main thread. For the channels area.
   */
  async threadFor(
    accountId: string,
    agentId: string,
    binding: AgentBinding,
  ): Promise<{ threadId: string; created: boolean }> {
    const row = await this.#row(accountId, agentId);
    if (binding.sharePrimary && binding.audience === 'private') {
      const main = await this.#mainThread(row);
      return { threadId: main, created: false };
    }
    const existing = await this.#db.orm
      .select()
      .from(linkT)
      .where(and(eq(linkT.agentId, agentId), eq(linkT.bindingRef, binding.bindingId)))
      .limit(1);
    const found = existing[0];
    if (found) {
      if (found.audience !== binding.audience)
        await this.#db.transaction(() =>
          this.#db.orm
            .update(linkT)
            .set({ audience: binding.audience })
            .where(eq(linkT.threadId, found.threadId)),
        );
      return { threadId: found.threadId, created: false };
    }
    const thread = await this.#threads.create(accountId, {
      mode: 'agent',
      title: clipText(`${row.name} · ${binding.title?.trim() || 'channel'}`, 200),
      memoryOptOut: true,
      ...(row.model ? { model: row.model } : {}),
    });
    await this.#db.transaction(() =>
      this.#db.orm.insert(linkT).values({
        threadId: thread.id,
        agentId,
        accountId,
        kind: 'binding',
        bindingRef: binding.bindingId,
        audience: binding.audience,
        runId: null,
        createdAt: this.#iso(),
      }),
    );
    await this.#auditAgent(row, 'system', 'agent.binding.thread', {
      bindingId: binding.bindingId,
      threadId: thread.id,
      audience: binding.audience,
    });
    return { threadId: thread.id, created: true };
  }

  /**
   * The channels area's BindingThreadResolver: the thread of a binding (ADR-070), or the main
   * thread for a private binding that shares it.
   */
  async bindingThread(input: {
    accountId: string;
    agentId: string | null;
    binding: {
      id: string;
      label?: string | null;
      audience: 'private' | 'shared';
      sharePrimaryThread: boolean;
    };
  }): Promise<string> {
    if (!input.agentId) throw new NovaError('validation', 'the binding has no agent');
    const r = await this.threadFor(input.accountId, input.agentId, {
      bindingId: input.binding.id,
      audience: input.binding.audience,
      title: input.binding.label ?? null,
      sharePrimary: input.binding.sharePrimaryThread,
    });
    return r.threadId;
  }

  /** The agent's main thread (created again if it was removed), e.g. for a trigger's wake. */
  async mainThreadOf(accountId: string, agentId: string): Promise<string> {
    return this.#mainThread(await this.#row(accountId, agentId));
  }

  /** A binding was removed: its thread stays as history but no longer belongs to the agent. */
  async releaseBinding(accountId: string, agentId: string, bindingId: string): Promise<void> {
    await this.#row(accountId, agentId);
    await this.#db.transaction(() =>
      this.#db.orm
        .delete(linkT)
        .where(and(eq(linkT.agentId, agentId), eq(linkT.bindingRef, bindingId))),
    );
  }

  /** Which agent a thread belongs to, if any (channels, browser, computers). */
  agentOfThread(accountId: string, threadId: string): Promise<AgentThreadLink | null> {
    const l = this.#link(threadId);
    return Promise.resolve(l && l.accountId === accountId ? linkOf(l) : null);
  }

  /** Whether the agent exists and may start turns now (not paused). */
  async isActive(accountId: string, agentId: string): Promise<boolean> {
    try {
      const row = await this.#row(accountId, agentId);
      return row.status !== 'paused';
    } catch {
      return false;
    }
  }

  /** The Work runs the agent delegated (FR-083), newest first. */
  async background(accountId: string, id: string): Promise<AgentBackgroundView[]> {
    await this.#row(accountId, id);
    return this.#db.raw
      .prepare(
        `SELECT id AS runId, thread_id AS threadId, title, status, created_at AS createdAt,
           ended_at AS endedAt
         FROM run WHERE account_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 200`,
      )
      .all(accountId, id) as unknown as AgentBackgroundView[];
  }

  /** The agent's activity (FR-090): its threads' traces, background runs and its own events. */
  async activity(accountId: string, id: string): Promise<ActivityItemView[]> {
    await this.#row(accountId, id);
    const threads = (await this.#links(id)).map((l) => l.threadId);
    const inThreads = threads.length
      ? `OR json_extract(correlation_json, '$.threadId') IN (${threads.map(() => '?').join(', ')})`
      : '';
    const rows = this.#db.raw
      .prepare(
        `SELECT id, name, schema_version AS schemaVersion, ts, actor, account_id AS accountId,
           correlation_json AS correlationJson, payload_json AS payloadJson
         FROM event WHERE (account_id IS NULL OR account_id = ?)
           AND (json_extract(correlation_json, '$.agentId') = ? ${inThreads})
         ORDER BY id DESC LIMIT ${MAX_ACTIVITY}`,
      )
      .all(accountId, id, ...threads) as {
      id: string;
      name: string;
      schemaVersion: number;
      ts: string;
      actor: string;
      accountId: string | null;
      correlationJson: string | null;
      payloadJson: string;
    }[];
    const events: EventEnvelope[] = rows.reverse().map((r) => {
      const e: EventEnvelope = {
        id: r.id,
        name: r.name,
        schemaVersion: r.schemaVersion,
        ts: r.ts,
        actor: r.actor,
        payload: parseJson<Record<string, unknown>>(r.payloadJson) ?? {},
      };
      if (r.accountId) e.accountId = r.accountId;
      const c = parseJson<EventEnvelope['correlation']>(r.correlationJson);
      if (c) e.correlation = c;
      return e;
    });
    const items = buildActivity(events);
    for (const e of events) {
      const it = runEventItem(e) ?? agentEventItem(e);
      if (it) items.push(it);
    }
    return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // ---- schedules the user makes for an agent (FR-055, FR-059) -----------------------------------

  async listSchedules(accountId: string, id: string) {
    await this.#row(accountId, id);
    return this.#scheduler ? this.#scheduler.listForAgent(accountId, id) : [];
  }

  /** A schedule the user writes for the agent: its fires carry the user's authority (FR-189). */
  async createSchedule(accountId: string, id: string, input: ScheduleInput) {
    await this.#row(accountId, id);
    const scheduler = this.#requireScheduler();
    return scheduler.createForAgent(accountId, input, {
      agentId: id,
      origin: 'user',
      actor: 'user',
    });
  }

  // ---- goals (FR-181) ---------------------------------------------------------------------------

  async getGoal(accountId: string, id: string): Promise<GoalView | null> {
    await this.#row(accountId, id);
    const g = (await this.#openGoal(id)) ?? (await this.#latestGoal(id));
    return g ? toGoalView(g) : null;
  }

  async setGoal(
    accountId: string,
    id: string,
    body: {
      objective: string;
      budgets?: BudgetAmounts | undefined;
      responsibilityId?: string | undefined;
    },
  ): Promise<GoalView> {
    const row = await this.#row(accountId, id);
    if (body.responsibilityId) await this.#resp(id, body.responsibilityId);
    const goalId = await this.#lock(id, () => this.#putGoal(row, body, 'user'));
    await this.#kickGoal(row);
    const g = await this.#goalById(goalId);
    if (!g) throw new NovaError('not_found', 'goal not found');
    return toGoalView(g);
  }

  async clearGoal(accountId: string, id: string): Promise<void> {
    const row = await this.#row(accountId, id);
    await this.#lock(id, async () => {
      const g = await this.#openGoal(id);
      if (!g) return;
      this.#clearGoalTimer(id);
      await this.#db.transaction(() => this.#db.orm.delete(goalT).where(eq(goalT.id, g.id)));
      for (const m of this.#chains.values()) if (m.goal?.id === g.id) m.goal = null;
      await this.#emitGoal('goal.updated', g, { goalId: g.id, changed: ['cleared'] }, 'user');
      await this.#auditAgent(row, 'user', 'goal.clear', { goalId: g.id });
    });
  }

  /** Statuses changed through /goals/:id/{pause,resume,complete} (the runs area's routes). */
  async onGoalChanged(goalId: string): Promise<void> {
    const g = await this.#goalById(goalId);
    if (!g?.agentId) return;
    if (g.status !== 'active') {
      this.#clearGoalTimer(g.agentId);
      return;
    }
    const row = await this.#rowById(g.agentId);
    if (row) await this.#kickGoal(row);
  }

  async #putGoal(
    row: AgentRow,
    body: {
      objective: string;
      budgets?: BudgetAmounts | undefined;
      responsibilityId?: string | undefined;
    },
    by: 'user' | 'agent',
  ): Promise<string> {
    const now = this.#iso();
    const threadId = await this.#mainThread(row);
    const open = await this.#openGoal(row.id);
    const objective = clipText(body.objective.trim(), 4000);
    let goalId: string;
    if (open) {
      const set: Partial<GoalRow> = {
        objective,
        createdBy: by,
        updatedAt: now,
        timeBudgetS: body.budgets?.timeSeconds ?? null,
        tokenBudget: body.budgets?.tokens ?? null,
        costBudgetUsd: body.budgets?.costUsd ?? null,
      };
      await this.#db.transaction(() =>
        this.#db.orm.update(goalT).set(set).where(eq(goalT.id, open.id)),
      );
      for (const m of this.#chains.values())
        if (m.goal?.id === open.id) m.goal.limits = goalLimits({ ...open, ...set });
      await this.#emitGoal(
        'goal.updated',
        { ...open, ...set },
        { goalId: open.id, changed: ['objective', 'budgets'] },
        by === 'user' ? 'user' : 'system',
      );
      goalId = open.id;
    } else {
      const g: GoalRow = {
        id: uuidv7(),
        accountId: row.accountId,
        runId: null,
        agentId: row.id,
        threadId,
        objective,
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
      await this.#emitGoal(
        'goal.created',
        g,
        { goalId: g.id, agentId: row.id, objective, budgets: body.budgets ?? {} },
        by === 'user' ? 'user' : 'system',
      );
      goalId = g.id;
    }
    if (body.responsibilityId) {
      await this.#db.transaction(async () => {
        await this.#db.orm
          .update(respT)
          .set({ goalId: null, updatedAt: now })
          .where(and(eq(respT.agentId, row.id), eq(respT.goalId, goalId)));
        await this.#db.orm
          .update(respT)
          .set({ goalId, updatedAt: now })
          .where(eq(respT.id, body.responsibilityId!));
      });
    }
    await this.#auditAgent(row, by === 'user' ? 'user' : `agent:${row.id}`, 'goal.set', {
      goalId,
      ...(body.responsibilityId ? { responsibilityId: body.responsibilityId } : {}),
    });
    return goalId;
  }

  async #goalStatus(
    row: AgentRow,
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
    await this.#auditAgent(row, by === 'agent' ? `agent:${row.id}` : by, 'goal.status', {
      goalId: g.id,
      from: g.status,
      to,
    });
    if (to === 'blocked')
      await this.#notify(
        row,
        'attention',
        `${row.name}: goal blocked`,
        next.blockerDescription ?? next.blockerKey ?? 'The goal cannot progress.',
      );
    if (to === 'budget_limited')
      await this.#notify(row, 'attention', `${row.name}: goal budget reached`, reason ?? '');
    if (to !== 'active') this.#clearGoalTimer(row.id);
    return next;
  }

  /** An active goal of an active, idle agent continues after the debounce (docs/09 §2.1). */
  async #kickGoal(row: AgentRow): Promise<void> {
    const g = await this.#openGoal(row.id);
    if (g?.status !== 'active' || row.status !== 'active' || this.#closed) return;
    this.#scheduleGoal(row.id, this.#debounceMs);
  }

  #scheduleGoal(agentId: string, ms: number): void {
    this.#clearGoalTimer(agentId);
    const h = this.#timers.set(
      () => {
        this.#goalTimers.delete(agentId);
        this.#track(
          this.#continueGoal(agentId).catch((err: unknown) => {
            this.#log.warn('agent goal continuation failed', { err, agentId });
          }),
        );
      },
      Math.max(0, ms),
    );
    this.#goalTimers.set(agentId, h);
  }

  #clearGoalTimer(agentId: string): void {
    const h = this.#goalTimers.get(agentId);
    if (h !== undefined) this.#timers.clear(h);
    this.#goalTimers.delete(agentId);
  }

  async #continueGoal(agentId: string): Promise<void> {
    const row = await this.#rowById(agentId);
    if (row?.status !== 'active' || this.#closed) return;
    const g = await this.#openGoal(agentId);
    if (g?.status !== 'active') return;
    const threadId = row.primaryThreadId;
    if (!threadId || this.#threadBusy(threadId)) return;
    // Continuations wait for the end of quiet hours (FR-181, FR-060).
    const quiet = await this.#quietWindow(row.accountId, this.#now());
    if (quiet) {
      this.#scheduleGoal(agentId, Date.parse(quiet.end) - this.#now().getTime());
      return;
    }
    const hit = goalHit(goalLimits(g), goalUsage(g));
    if (hit) {
      await this.#goalStatus(
        row,
        g,
        'budget_limited',
        'system',
        `the ${hit.bound} budget was reached`,
      );
      return;
    }
    const text = goalContinuationText({
      objective: g.objective,
      remaining: remainingText(
        {
          timeMs: row.timeBudgetS * 1000,
          tokens: row.tokenBudget,
          costUsd: row.costBudgetUsd,
        },
        goalLimits(g),
        { run: emptyUsage(), goal: goalUsage(g) },
      ),
      progress: g.progressNote,
    });
    await this.#startOn(row, threadId, {
      kind: 'goal',
      text,
      trigger: 'goal',
      triggerRef: g.id,
      goalId: g.id,
      // A continuation is Nova's own prompt: it authorizes nothing (FR-189).
      authority: { kind: 'none', origin: 'system' },
      authorKind: 'goal',
    });
  }

  // ---- proactive research (FR-082) --------------------------------------------------------------

  /** Start proactive research now (the user asked; still read-only and still not when paused). */
  async researchNow(
    accountId: string,
    id: string,
  ): Promise<{ started: boolean; reason: string | null }> {
    const row = await this.#row(accountId, id);
    if (row.status === 'paused') return { started: false, reason: 'the agent is paused' };
    const proactiveThread = (await this.#links(id)).find((l) => l.kind === 'proactive');
    if (proactiveThread && this.#threadBusy(proactiveThread.threadId))
      return { started: false, reason: 'research is already running' };
    await this.#startProactive(row, 'user');
    return { started: true, reason: null };
  }

  #armProactive(): void {
    if (!this.#started || this.#closed) return;
    if (this.#proactiveTimer !== null) this.#timers.clear(this.#proactiveTimer);
    this.#proactiveTimer = this.#timers.set(() => {
      this.#proactiveTimer = null;
      this.#track(
        this.proactiveTick()
          .catch((err: unknown) => {
            this.#log.warn('proactive research check failed', { err });
          })
          .finally(() => {
            this.#armProactive();
          }),
      );
    }, this.#checkMs);
  }

  /** Start research for every idle agent that is due (the loop calls it; tests may too). */
  async proactiveTick(): Promise<number> {
    if (this.#closed || !this.#turns) return 0;
    const { intervalMinutes } = await this.#settings.proactive();
    const now = this.#now().getTime();
    const rows = await this.#db.orm
      .select()
      .from(agentT)
      .where(and(eq(agentT.status, 'active'), eq(agentT.proactive, true)));
    let started = 0;
    for (const row of rows) {
      if (this.#deleting.has(row.id)) continue;
      // At most once per interval, counted from the last research turn (default hourly).
      if (row.lastProactiveAt && now - Date.parse(row.lastProactiveAt) < intervalMinutes * 60_000)
        continue;
      if (!(await this.#agentIdle(row))) continue;
      if (await this.#quietWindow(row.accountId, this.#now())) continue;
      try {
        await this.#startProactive(row, 'system');
        started++;
      } catch (err) {
        this.#log.warn('proactive research did not start', { err, agentId: row.id });
      }
    }
    return started;
  }

  async #startProactive(row: AgentRow, by: 'user' | 'system'): Promise<void> {
    const threadId = await this.#proactiveThread(row);
    const now = this.#iso();
    // Counted from the start, so a failing start never loops.
    await this.#db.transaction(() =>
      this.#db.orm
        .update(agentT)
        .set({ lastProactiveAt: now, updatedAt: now })
        .where(eq(agentT.id, row.id)),
    );
    const resps = (await this.#resps(row.id)).filter((r) => r.status === 'active');
    await this.#auditAgent(row, by, 'agent.proactive.start', { threadId });
    await this.#startOn(row, threadId, {
      kind: 'proactive',
      text: proactiveText(resps),
      trigger: 'schedule',
      triggerRef: `proactive:${row.id}`,
      goalId: null,
      authority: { kind: 'none', origin: 'system' },
      authorKind: 'system',
    });
  }

  /** No turn, nothing queued, no request or approval waiting, no background run going. */
  async #agentIdle(row: AgentRow): Promise<boolean> {
    for (const l of await this.#links(row.id)) {
      if (l.kind === 'background') continue;
      if (this.#threadBusy(l.threadId)) return false;
    }
    const live = this.#db.raw
      .prepare(
        `SELECT 1 AS x FROM run WHERE agent_id = ? AND status IN (${LIVE_RUN.map(() => '?').join(', ')}) LIMIT 1`,
      )
      .get(row.id, ...LIVE_RUN);
    return live === undefined;
  }

  /** A proactive turn asked for an approval: it may only read, so it stops here (FR-082). */
  async onApprovalRequested(threadId: string): Promise<void> {
    const act = this.#active.get(threadId);
    if (act?.threadKind !== 'proactive' || act.denied) return;
    act.denied = true;
    const row = await this.#rowById(act.agentId);
    if (!row) return;
    await this.#auditAgent(row, 'system', 'agent.proactive.denied', {
      threadId,
      reason: 'proactive research may only read',
    });
    await this.#turns?.cancel(row.accountId, threadId).catch(() => undefined);
  }

  async #proactiveEnded(row: AgentRow, act: ActiveTurn, threadId: string, o: TurnOutcome) {
    if (act.denied || o.stop === 'cancelled') {
      await this.#auditAgent(row, 'system', 'agent.proactive.end', { result: 'stopped', threadId });
      return;
    }
    const reply = o.replyText.trim();
    if (o.status !== 'completed' || isNothingNew(reply)) {
      await this.#auditAgent(row, 'system', 'agent.proactive.end', {
        result: o.status === 'completed' ? 'nothing_new' : o.stop,
        threadId,
      });
      return;
    }
    // Findings go to the agent's notes (visible, editable) and reach the user as a suggestion.
    const fresh = (await this.#rowById(row.id)) ?? row;
    const note = fresh.memoryEnabled
      ? await this.#insertNote(fresh, {
          kind: 'observation',
          content: reply,
          author: 'agent',
          source: 'proactive',
          sourceThreadId: threadId,
          responsibilityId: null,
          pinned: false,
          audience: 'private',
        })
      : null;
    const s = suggestionOf(reply);
    const sug: SugRow = {
      id: uuidv7(),
      agentId: row.id,
      noteId: note?.id ?? null,
      title: s.title,
      body: s.body,
      status: 'open',
      threadId: fresh.primaryThreadId,
      turnId: o.turnId,
      createdAt: this.#iso(),
      decidedAt: null,
    };
    await this.#db.transaction(() => this.#db.orm.insert(sugT).values(sug));
    await this.#emit(
      'agent.research.finding',
      fresh,
      { agentId: row.id, findingId: note?.id ?? sug.id, summary: s.title },
      `agent:${row.id}`,
    );
    await this.#emit(
      'agent.suggestion.created',
      fresh,
      { agentId: row.id, suggestionId: sug.id, title: s.title },
      `agent:${row.id}`,
      fresh.primaryThreadId,
    );
    await this.#auditAgent(row, 'system', 'agent.proactive.end', {
      result: 'finding',
      suggestionId: sug.id,
      noteId: note?.id ?? null,
      threadId,
    });
    await this.#notify(fresh, 'attention', `${fresh.name} has a suggestion`, s.title);
  }

  // ---- delegation, sessions and wakes (tool hosts) ----------------------------------------------

  /** Start background work as a Work run (FR-059, FR-083), in the agent's policy scope. */
  async delegate(
    accountId: string,
    threadId: string,
    input: { objective: string; title?: string | undefined },
  ): Promise<{ runId: string; threadId: string }> {
    const runs = this.#runs;
    if (!runs) throw new NovaError('capability_missing', 'Work runs are not available');
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    const objective = clipText(input.objective.trim(), 8000);
    const title = clipText(
      input.title?.trim() || objective.split('\n')[0] || 'Background work',
      200,
    );
    // Never a broader scope than the agent's: its autonomy, its budgets, no authority of its own
    // (the objective is the agent's words, FR-189).
    const run = await runs.createRun({
      accountId,
      objective,
      title,
      origin: 'delegation',
      originRef: `agent:${row.id}`,
      agentId: row.id,
      autonomy: row.autonomy,
      budgets: {
        timeSeconds: row.timeBudgetS,
        tokens: row.tokenBudget,
        costUsd: row.costBudgetUsd,
      },
      authority: { kind: 'none', origin: 'tool' },
      start: true,
    });
    await this.#db.transaction(() =>
      this.#db.orm.insert(linkT).values({
        threadId: run.threadId,
        agentId: row.id,
        accountId,
        kind: 'background',
        bindingRef: null,
        audience: 'private',
        runId: run.runId,
        createdAt: this.#iso(),
      }),
    );
    await this.#emit(
      'agent.background.started',
      row,
      { agentId: row.id, runId: run.runId, threadId: run.threadId, title },
      `agent:${row.id}`,
    );
    await this.#auditAgent(row, `agent:${row.id}`, 'agent.delegate', {
      runId: run.runId,
      inputHash: hashText(objective),
    });
    // The result returns to the agent as an item in its main thread (docs/09 §4). Not part of
    // idle(): a run can take hours.
    runs.whenFinished(accountId, run.runId).then(
      (finish) => {
        if (!this.#closed) this.#track(this.#backgroundDone(row.id, title, finish));
      },
      (err: unknown) => {
        this.#log.warn('background run did not finish', { err, runId: run.runId });
      },
    );
    return run;
  }

  async #backgroundDone(
    agentId: string,
    title: string,
    finish: { runId: string; status: string; summary: string | null },
  ): Promise<void> {
    const row = await this.#rowById(agentId);
    if (!row || row.status === 'paused' || this.#closed || this.#deleting.has(agentId)) return;
    const threadId = row.primaryThreadId;
    if (!threadId) return;
    try {
      await this.#startOn(row, threadId, {
        kind: 'result',
        text: backgroundResultText({ title, status: finish.status, summary: finish.summary }),
        trigger: 'event',
        triggerRef: finish.runId,
        goalId: null,
        // The run's result is what the run produced: data, not an instruction (FR-189).
        authority: { kind: 'none', origin: 'tool' },
        authorKind: 'system',
      });
    } catch (err) {
      this.#log.warn('could not report background work to the agent', { err, agentId });
    }
  }

  /** Send a message into another of the user's sessions, as the agent (FR-072). */
  async messageSession(
    accountId: string,
    fromThreadId: string,
    targetThreadId: string,
    text: string,
  ): Promise<{ turnId: string }> {
    const link = this.#requireLink(accountId, fromThreadId);
    const row = await this.#row(accountId, link.agentId);
    const target = await this.#threads.row(accountId, targetThreadId);
    const own = this.#link(target.id);
    if (own?.agentId === row.id)
      throw new NovaError('validation', 'that is one of your own threads');
    const turns = this.#turns;
    if (!turns) throw new NovaError('capability_missing', 'turns are not available');
    const body = clipText(text.trim(), 8000);
    // The agent's words: never the user's authority in that session (FR-189).
    const started = await turns.startTurn({
      accountId,
      threadId: target.id,
      text: `Message from your agent ${row.name}:\n\n${body}`,
      trigger: 'event',
      triggerRef: `agent:${row.id}`,
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
    });
    await this.#auditAgent(row, `agent:${row.id}`, 'agent.session.message', {
      threadId: target.id,
      inputHash: hashText(body),
    });
    return { turnId: started.turnId };
  }

  async archiveSession(accountId: string, fromThreadId: string, targetThreadId: string) {
    const link = this.#requireLink(accountId, fromThreadId);
    const row = await this.#row(accountId, link.agentId);
    const own = this.#link(targetThreadId);
    if (own?.agentId === row.id)
      throw new NovaError('validation', 'that is one of your own threads');
    await this.#threads.update(accountId, targetThreadId, { archived: true });
    await this.#auditAgent(row, `agent:${row.id}`, 'agent.session.archive', {
      threadId: targetThreadId,
    });
  }

  async listSessions(
    accountId: string,
    opts: {
      mode?: 'chat' | 'work' | 'code' | 'agent' | undefined;
      q?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const page = await this.#threads.list(accountId, {
      mode: opts.mode,
      q: opts.q,
      limit: Math.max(1, Math.min(opts.limit ?? 20, 50)),
    });
    return page.items.map((t) => ({
      id: t.id,
      title: t.title,
      mode: t.mode,
      updatedAt: t.updatedAt,
    }));
  }

  readSession(accountId: string, threadId: string, limit = 20) {
    const rows = this.#db.raw
      .prepare(
        `SELECT m.role AS role, group_concat(p.content, '') AS text FROM message m
         JOIN thread t ON t.id = m.thread_id
         JOIN message_part p ON p.message_id = m.id AND p.type = 'text'
         WHERE m.thread_id = ? AND t.account_id = ? AND t.deleted_at IS NULL
           AND m.deleted_at IS NULL AND m.role IN ('user', 'assistant')
         GROUP BY m.id ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      )
      .all(threadId, accountId, Math.max(1, Math.min(limit, 50))) as {
      role: string;
      text: string | null;
    }[];
    return rows
      .reverse()
      .filter((r) => r.text?.trim())
      .map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${clipText(r.text!.trim(), 1500)}`)
      .join('\n\n');
  }

  /**
   * schedule.wake (FR-206): at least `minMinutes` ahead, at most `horizonDays`, at most
   * `perDay` per agent in any 24 hours (every wake set counts, cancelled ones too). A wake in
   * quiet hours moves to the end of the window.
   */
  async setWake(
    accountId: string,
    threadId: string,
    input: { at?: string | undefined; in?: unknown; reason: string },
  ): Promise<{ scheduleId: string; at: string; moved: boolean }> {
    const scheduler = this.#requireScheduler();
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    const limits = await this.#settings.wakes();
    const now = this.#now().getTime();
    let at: number;
    if (input.at !== undefined) {
      at = Date.parse(input.at);
      if (Number.isNaN(at)) throw wakeError('at is not a date-time');
    } else {
      const ms = parseDuration(input.in);
      if (ms === null) throw wakeError('give at (a date-time) or in (like "45m", "2h", "1d")');
      at = now + ms;
    }
    if (at - now < limits.minMinutes * 60_000)
      throw wakeError(`a wake must be at least ${limits.minMinutes} minutes ahead`);
    if (at - now > limits.horizonDays * 86_400_000)
      throw wakeError(`a wake can be at most ${limits.horizonDays} days ahead`);
    const since = new Date(now - 86_400_000).toISOString();
    const count = this.#db.raw
      .prepare('SELECT COUNT(*) AS n FROM agent_wake WHERE agent_id = ? AND created_at > ?')
      .get(row.id, since) as { n: number };
    if (count.n >= limits.perDay)
      throw wakeError(`at most ${limits.perDay} self-set wakes a day; this one is refused`);
    const reason = clipText(input.reason.trim(), 500);
    if (!reason) throw wakeError('a wake needs a reason');
    let moved = false;
    const quiet = await this.#quietWindow(accountId, new Date(at));
    if (quiet) {
      at = Date.parse(quiet.end);
      moved = true;
    }
    const atIso = new Date(at).toISOString();
    const view = await scheduler.createForAgent(
      accountId,
      {
        when: { at: atIso },
        timezone: 'UTC',
        title: clipText(`${row.name}: ${reason}`, 200),
        instructions: wakeText(reason, reason),
        deliveryTargets: [],
        catchUp: { policy: 'once' },
      },
      { agentId: row.id, origin: 'agent_self', wakeReason: reason, actor: `agent:${row.id}` },
    );
    await this.#db.transaction(() =>
      this.#db.orm.insert(wakeT).values({
        id: uuidv7(),
        agentId: row.id,
        scheduleId: view.id,
        at: atIso,
        requestedAt: new Date(input.at !== undefined ? Date.parse(input.at) : at).toISOString(),
        reason,
        movedByQuietHours: moved,
        createdAt: this.#iso(),
      }),
    );
    await this.#auditAgent(row, `agent:${row.id}`, 'agent.wake.set', {
      scheduleId: view.id,
      at: atIso,
      movedByQuietHours: moved,
    });
    return { scheduleId: view.id, at: atIso, moved };
  }

  /** schedule.create (FR-059): an agent-made schedule, or an edit of one (with its id). */
  async upsertSchedule(
    accountId: string,
    threadId: string,
    input: ScheduleInput & { id?: string | undefined },
    sent: ReadonlySet<string>,
  ) {
    const scheduler = this.#requireScheduler();
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    // An agent-made schedule delivers only inside Nova: messages to others need the user.
    for (const t of input.deliveryTargets)
      if (t.kind !== 'inapp' && t.kind !== 'os')
        throw new NovaError(
          'policy_denied',
          'an agent-made schedule can deliver only in Nova (inapp, os); ask the user for other targets',
        );
    const actor = `agent:${row.id}`;
    if (input.id) {
      const { id, ...rest } = input;
      const patch = Object.fromEntries(
        Object.entries(rest).filter(([k]) => sent.has(k)),
      ) as Partial<ScheduleInput>;
      const mine = (await scheduler.listForAgent(accountId, row.id)).find((s) => s.id === id);
      if (mine?.origin === 'user')
        throw new NovaError('policy_denied', 'the user made this schedule; only the user edits it');
      return scheduler.update(accountId, id, patch, { actor, agentId: row.id });
    }
    return scheduler.createForAgent(accountId, input, { agentId: row.id, origin: 'agent', actor });
  }

  async cancelSchedule(accountId: string, threadId: string, scheduleId: string) {
    const scheduler = this.#requireScheduler();
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    const mine = (await scheduler.listForAgent(accountId, row.id)).find((s) => s.id === scheduleId);
    if (!mine) throw new NovaError('not_found', 'schedule not found');
    if (mine.origin === 'user')
      throw new NovaError('policy_denied', 'the user made this schedule; only the user cancels it');
    await scheduler.remove(accountId, scheduleId, { actor: `agent:${row.id}` });
  }

  async agentSchedules(accountId: string, threadId: string) {
    const link = this.#requireLink(accountId, threadId);
    return this.#scheduler ? this.#scheduler.listForAgent(accountId, link.agentId) : [];
  }

  /** agent.note: a note the agent writes (untrusted, FR-089). */
  async agentNote(
    accountId: string,
    threadId: string,
    input: {
      content: string;
      kind?: 'note' | 'fact' | 'preference' | undefined;
      responsibilityId?: string | undefined;
    },
  ): Promise<string> {
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    if (!row.memoryEnabled) throw new NovaError('policy_denied', 'memory is off for this agent');
    if (input.responsibilityId) await this.#resp(row.id, input.responsibilityId);
    const note = await this.#insertNote(row, {
      kind: input.kind ?? 'note',
      content: input.content,
      author: 'agent',
      source: 'tool',
      sourceThreadId: threadId,
      responsibilityId: input.responsibilityId ?? null,
      pinned: false,
      audience: link.audience,
    });
    return note.id;
  }

  async agentNotes(accountId: string, threadId: string): Promise<AgentMemoryItemView[]> {
    const link = this.#requireLink(accountId, threadId);
    const items = await this.listMemory(accountId, link.agentId);
    return link.audience === 'shared' ? items.filter((i) => i.originAudience === 'shared') : items;
  }

  async agentProgress(accountId: string, threadId: string, rid: string, note: string) {
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    await this.#resp(row.id, rid);
    await this.#db.transaction(() =>
      this.#db.orm
        .update(respT)
        .set({ progressNote: clipText(note.trim(), 4000), updatedAt: this.#iso() })
        .where(eq(respT.id, rid)),
    );
    await this.#emit(
      'agent.responsibility.changed',
      row,
      { agentId: row.id, responsibilityId: rid, change: 'progress' },
      `agent:${row.id}`,
    );
  }

  backgroundFor(accountId: string, threadId: string) {
    const link = this.#requireLink(accountId, threadId);
    return this.background(accountId, link.agentId);
  }

  /** The turn running on a thread, for the tool handlers. */
  turnOf(
    threadId: string,
  ): { kind: TurnKind; authority: 'user' | 'none'; threadKind: AgentThreadLink['kind'] } | null {
    const a = this.#active.get(threadId);
    return a ? { kind: a.kind, authority: a.authority, threadKind: a.threadKind } : null;
  }

  // ---- goal tools (FR-181) ----------------------------------------------------------------------

  async goalForThread(accountId: string, threadId: string) {
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    const g = await this.#openGoal(row.id);
    if (!g) return null;
    const m = [...this.#chains.values()].find((x) => x.goal?.id === g.id);
    const used = m?.goal?.used ?? goalUsage(g);
    const v = toGoalView(g, used);
    return {
      id: v.id,
      objective: v.objective,
      status: v.status,
      budgets: v.budgets,
      usage: v.usage,
      remaining: remainingText(
        { timeMs: row.timeBudgetS * 1000, tokens: row.tokenBudget, costUsd: row.costBudgetUsd },
        goalLimits(g),
        { run: emptyUsage(), goal: used },
      ),
      progressNote: v.progressNote,
      blocker: v.blocker,
    };
  }

  /** goal.set: only when the user asked for a goal in this turn (docs/09 §2.1). */
  async goalSetFromTool(
    accountId: string,
    threadId: string,
    body: { objective: string; budgets?: BudgetAmounts },
  ): Promise<string> {
    const link = this.#requireLink(accountId, threadId);
    if (this.#active.get(threadId)?.authority !== 'user')
      throw new NovaError(
        'policy_denied',
        'goal.set works only when the user asked for a goal in this turn; the user can set one in the agent header',
      );
    const row = await this.#row(accountId, link.agentId);
    const id = await this.#lock(row.id, () => this.#putGoal(row, body, 'agent'));
    return id;
  }

  async goalUpdateFromTool(
    accountId: string,
    threadId: string,
    turnId: string,
    a: {
      status?: GoalStatus | undefined;
      progressNote?: string | undefined;
      blocker?: { key: string; description?: string | undefined } | undefined;
    },
  ): Promise<string> {
    const link = this.#requireLink(accountId, threadId);
    const row = await this.#row(accountId, link.agentId);
    const act = this.#active.get(threadId);
    return this.#lock(row.id, async () => {
      let g = await this.#openGoal(row.id);
      if (!g) throw new NovaError('not_found', 'this agent has no goal');
      const changed: string[] = [];
      const set: Partial<GoalRow> = { updatedAt: this.#iso() };
      const note = a.progressNote?.trim();
      if (note) {
        set.progressNote = clipText(note, 4000);
        changed.push('progressNote');
      }
      if (a.blocker) {
        const key = normalizeBlockerKey(a.blocker.key);
        if (!key) throw new NovaError('validation', 'the blocker needs a key');
        const tid = turnId || 'unknown';
        set.blockerCount = nextBlockerCount(g, key, tid);
        set.blockerKey = key;
        set.blockerTurnId = tid;
        set.blockerDescription = a.blocker.description?.slice(0, 2000) ?? null;
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
      if (a.status && a.status !== g.status) {
        const check = checkAgentStatus(g, a.status, {
          userAsked: act?.authority === 'user',
          hasSummary: !!(note ?? g.progressNote),
        });
        if (!check.ok) throw new NovaError('policy_denied', check.message);
        const extra: Partial<GoalRow> = {};
        if (a.status === 'complete') {
          extra.completedAt = this.#iso();
          extra.completionSummary = note ?? g.progressNote;
        }
        const reason = a.status === 'blocked' ? (g.blockerDescription ?? g.blockerKey) : null;
        g = await this.#goalStatus(row, g, a.status, 'agent', reason, extra);
      }
      return a.status
        ? `Goal is ${g.status}.`
        : a.blocker
          ? `Blocker recorded (${g.blockerCount} of ${BLOCKED_AFTER} consecutive goal turns).`
          : 'Goal updated.';
    });
  }

  // ---- external agents (FR-194) -----------------------------------------------------------------

  async listExternal(accountId: string): Promise<ExternalAgentView[]> {
    const rows = await this.#db.orm
      .select()
      .from(extT)
      .where(eq(extT.accountId, accountId))
      .orderBy(asc(extT.createdAt));
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      label: r.label,
      createdAt: r.createdAt,
    }));
  }

  async markExternal(
    accountId: string,
    req: { address: string; label?: string | undefined },
  ): Promise<ExternalAgentView> {
    const address = normalizeCounterpart(req.address);
    if (!address) throw new NovaError('validation', 'an address is required');
    const existing = (await this.listExternal(accountId)).find((e) => e.address === address);
    if (existing) return existing;
    const row = {
      id: uuidv7(),
      accountId,
      address,
      label: req.label?.trim() || null,
      createdAt: this.#iso(),
    };
    await this.#db.transaction(() => this.#db.orm.insert(extT).values(row));
    await this.#appendAudit({
      accountId,
      actor: 'user',
      kind: 'agent',
      action: 'external_agent.mark',
      resource: `external_agent:${address}`,
    });
    return { id: row.id, address, label: row.label, createdAt: row.createdAt };
  }

  async unmarkExternal(accountId: string, id: string): Promise<void> {
    const rows = await this.#db.orm
      .select()
      .from(extT)
      .where(and(eq(extT.id, id), eq(extT.accountId, accountId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'external agent not found');
    await this.#db.transaction(() => this.#db.orm.delete(extT).where(eq(extT.id, id)));
    await this.#appendAudit({
      accountId,
      actor: 'user',
      kind: 'agent',
      action: 'external_agent.unmark',
      resource: `external_agent:${row.address}`,
    });
  }

  #marked(accountId: string): string[] {
    return (
      this.#db.raw
        .prepare('SELECT address FROM external_agent WHERE account_id = ?')
        .all(accountId) as { address: string }[]
    ).map((r) => r.address);
  }

  async #inbound(
    input: Parameters<ExternalAgentGuard['inbound']>[0],
  ): ReturnType<ExternalAgentGuard['inbound']> {
    const finding = detectExternalAgent({
      text: input.text,
      sender: input.sender
        ? {
            id: input.sender.id,
            name: input.sender.name ?? null,
            isBot: input.sender.isBot ?? false,
          }
        : null,
      marked: this.#marked(input.accountId),
    });
    if (!finding) return { external: false, accept: true };
    // A Nova agent never accepts a task from an external agent (docs/12 §6.2).
    const reason = `content from the external agent ${finding.counterpart} is data, not a task`;
    await this.#appendAudit({
      accountId: input.accountId,
      actor: input.agentId ? `agent:${input.agentId}` : 'system',
      kind: 'agent',
      action: 'external_agent.denied',
      resource: `external_agent:${finding.counterpart}`,
      decision: 'deny',
      threadId: input.threadId ?? null,
      detail: {
        cause: 'external_agent',
        action: 'accept_task',
        source: input.source,
        evidence: finding.evidence,
        inputHash: hashText(input.text),
      },
    });
    return {
      external: true,
      accept: false,
      counterpart: finding.counterpart,
      evidence: finding.evidence,
      origin: 'external_agent',
      reason,
    };
  }

  async #checkExternal(
    input: Parameters<ExternalAgentGuard['check']>[0],
  ): ReturnType<ExternalAgentGuard['check']> {
    const c: ExternalCounterpart =
      typeof input.counterpart === 'string' ? { id: input.counterpart } : input.counterpart;
    const name = c.name ?? c.id;
    const marked = this.#marked(input.accountId);
    const external =
      c.isBot === true ||
      marked.includes(normalizeCounterpart(c.id)) ||
      marked.includes(normalizeCounterpart(name)) ||
      looksLikeAgent(name);
    if (!external) return { allowed: true, external: false, reason: 'not an AI agent' };
    const counterpart = normalizeCounterpart(name);
    const named = new Set((input.namedAgents ?? []).map(normalizeCounterpart));
    const userText = input.threadId ? this.#currentUserText(input.threadId) : null;
    if (userText && (namesAgent(userText, counterpart) || namesAgent(userText, c.id)))
      named.add(counterpart);
    const decision = externalAgentDecision({
      counterpart,
      namedAgents: [...named],
      agentId: input.agentId ?? null,
    });
    const allowed = decision.effect !== 'deny';
    await this.#appendAudit({
      accountId: input.accountId,
      actor: input.agentId ? `agent:${input.agentId}` : 'system',
      kind: 'agent',
      action: allowed ? 'external_agent.allowed' : 'external_agent.denied',
      resource: `external_agent:${counterpart}`,
      decision: allowed ? 'allow' : 'deny',
      threadId: input.threadId ?? null,
      detail: { cause: 'external_agent', action: input.action, named: allowed },
    });
    return {
      allowed,
      external: true,
      reason: allowed ? `you named ${counterpart} for this task` : decision.reason,
    };
  }

  /** The text the user typed for the thread's current (latest) turn, if the user typed it. */
  #currentUserText(threadId: string): string | null {
    const row = this.#db.raw
      .prepare(
        `SELECT group_concat(p.content, '') AS text FROM turn t
         JOIN message m ON m.turn_id = t.id AND m.role = 'user' AND m.provenance = 'typed'
           AND m.author_kind = 'user'
         JOIN message_part p ON p.message_id = m.id AND p.type = 'text'
         WHERE t.id = (SELECT id FROM turn WHERE thread_id = ? ORDER BY idx DESC LIMIT 1)`,
      )
      .get(threadId) as { text: string | null } | undefined;
    return row?.text ?? null;
  }

  // ---- schedule fires (FR-059, FR-206) ----------------------------------------------------------

  async #fire(input: AgentFireInput): Promise<{
    threadId: string;
    done: Promise<{ status: 'done' | 'failed' | 'cancelled'; summary: string | null }>;
  }> {
    const row = await this.#row(input.accountId, input.agentId);
    if (row.status === 'paused') throw new NovaError('conflict', `${row.name} is paused`);
    if (this.#deleting.has(row.id)) throw new NovaError('conflict', `${row.name} is being deleted`);
    const threadId = await this.#mainThread(row);
    // Only a schedule the user wrote carries the user's authority (FR-189).
    const authority: StartTurnInput['authority'] =
      input.origin === 'user'
        ? { kind: 'user', source: `schedule:${input.scheduleId}` }
        : { kind: 'none', origin: 'system' };
    const text =
      input.origin === 'agent_self' ? wakeText(input.wakeReason, input.text) : input.text;
    const started = await this.#startOn(row, threadId, {
      kind: 'fire',
      text,
      trigger: 'schedule',
      triggerRef: input.scheduleId,
      goalId: null,
      authority,
      authorKind: 'schedule',
    });
    const done = started.done.then((o) => ({
      status:
        o.status === 'completed'
          ? ('done' as const)
          : o.stop === 'cancelled'
            ? ('cancelled' as const)
            : ('failed' as const),
      summary: o.replyText.trim() || null,
    }));
    return { threadId, done };
  }

  // ---- the turn extension (docs/09 §2, §11) -----------------------------------------------------

  async #startOn(
    row: AgentRow,
    threadId: string,
    plan: {
      kind: TurnKind;
      text: string;
      trigger: TurnTrigger;
      triggerRef: string | null;
      goalId: string | null;
      authority: StartTurnInput['authority'];
      authorKind: StartTurnInput['authorKind'];
    },
  ): Promise<StartedTurn> {
    const turns = this.#turns;
    if (!turns || this.#closed)
      throw new NovaError('capability_missing', 'agent turns are not available');
    const pending: PendingTurn = {
      kind: plan.kind,
      authority: plan.authority.kind,
      goalId: plan.goalId,
    };
    this.#pending.set(threadId, pending);
    try {
      const input: StartTurnInput = {
        accountId: row.accountId,
        threadId,
        text: plan.text,
        trigger: plan.trigger,
        triggerRef: plan.triggerRef,
        goalId: plan.goalId,
        authority: plan.authority,
        authorKind: plan.authorKind,
      };
      if (row.model) input.model = row.model;
      const started = await turns.startTurn(input);
      if (this.#pending.get(threadId) === pending) {
        // Not asked about yet: the loop queued it behind the running turn.
        this.#pending.delete(threadId);
        this.#queued.set(started.turnId, { ...pending, threadId });
      }
      return started;
    } catch (err) {
      if (this.#pending.get(threadId) === pending) this.#pending.delete(threadId);
      throw err;
    }
  }

  async #forTurn(input: Parameters<TurnExtension['forTurn']>[0]): Promise<TurnAddition | null> {
    if (input.mode !== 'agent') return null;
    const l = this.#link(input.threadId);
    if (!l || l.accountId !== input.accountId || l.kind === 'background') return null;
    const link = linkOf(l);
    let row = await this.#rowById(link.agentId);
    if (!row) return null;
    const queued = this.#queued.get(input.turnId);
    this.#queued.delete(input.turnId);
    const pending = queued ?? this.#pending.get(input.threadId) ?? null;
    if (!queued && pending) this.#pending.delete(input.threadId);
    const previous = this.#active.get(input.threadId);
    const continuation = input.trigger === 'hook' && previous !== undefined;
    const kind: TurnKind = pending
      ? pending.kind
      : continuation
        ? previous.kind
        : input.trigger === 'user'
          ? this.#typedByUser(input.turnId)
            ? 'typed'
            : 'other'
          : input.trigger === 'channel'
            ? 'channel'
            : 'other';
    if (this.#deleting.has(row.id)) throw new NovaError('conflict', `${row.name} is being deleted`);
    if (row.status === 'paused') {
      // Safety monitoring stopped it: nothing runs until the user resumes it (FR-090).
      if (row.pauseReason === 'safety')
        throw new NovaError(
          'conflict',
          `${row.name} was paused by safety monitoring; resume it to continue`,
        );
      // The user writing to an agent they paused resumes it, as in a run (docs/09 §3).
      if (kind !== 'typed') throw new NovaError('conflict', `${row.name} is paused`);
      row = await this.#resumeLocked(row, 'user');
    } else if (row.status === 'stopped' && kind !== 'proactive' && kind !== 'goal') {
      // Any new turn ends the stop: the user wrote, or a schedule fired (FR-090).
      const stopped = row;
      row = await this.#lock(row.id, async () => {
        const fresh = (await this.#rowById(stopped.id)) ?? stopped;
        if (fresh.status !== 'stopped') return fresh;
        const set: Partial<AgentRow> = {
          status: 'active',
          statusDetail: null,
          updatedAt: this.#iso(),
        };
        await this.#db.transaction(() =>
          this.#db.orm.update(agentT).set(set).where(eq(agentT.id, fresh.id)),
        );
        return { ...fresh, ...set };
      });
      await this.#statusChanged(
        row,
        'stopped',
        'active',
        null,
        kind === 'typed' ? 'user' : 'system',
      );
    } else if (row.status === 'stopped') {
      throw new NovaError('conflict', `${row.name} was stopped`);
    }
    // Only text the user typed carries the user's authority (FR-189).
    const authority = pending
      ? pending.authority
      : continuation
        ? previous.authority
        : kind === 'typed'
          ? 'user'
          : 'none';
    const act: ActiveTurn = continuation
      ? { ...previous, turnId: input.turnId, trigger: input.trigger }
      : {
          turnId: input.turnId,
          agentId: row.id,
          threadKind: link.kind,
          kind,
          authority,
          trigger: input.trigger,
          goalId: pending?.goalId ?? null,
          blocker: null,
          denied: false,
        };
    this.#active.set(input.threadId, act);
    // A new chain gets the agent's budgets afresh; a hook continuation goes on with its chain's.
    let meter = continuation ? this.#chains.get(input.threadId) : undefined;
    if (!meter) {
      meter = {
        limits: {
          timeMs: row.timeBudgetS * 1000,
          tokens: row.tokenBudget,
          costUsd: row.costBudgetUsd,
        },
        used: emptyUsage(),
        goal: null,
      };
      if (act.kind === 'goal') {
        const g = await this.#openGoal(row.id);
        if (g) meter.goal = { id: g.id, limits: goalLimits(g), used: goalUsage(g) };
      }
      this.#chains.set(input.threadId, meter);
    }
    const m = meter;
    const agentId = row.id;
    const goal = await this.#openGoal(row.id);
    return {
      goalId: act.kind === 'goal' ? (goal?.id ?? null) : null,
      context: await this.#context(row, link, act, goal),
      bounds: {
        check: () => meterHit(m),
        record: (step) => {
          const d: Usage = {
            timeMs: step.activeMs,
            tokens: step.inputTokens + step.outputTokens,
            costUsd: step.costUsd,
          };
          add(m.used, d);
          if (m.goal) add(m.goal.used, d);
          this.#recordUsage(agentId, m.goal?.id ?? null, d);
        },
      },
      onEnd: (outcome) => this.#ended(input.threadId, outcome),
    };
  }

  async #context(
    row: AgentRow,
    link: AgentThreadLink,
    act: ActiveTurn,
    goal: GoalRow | null,
  ): Promise<ContextBlock[]> {
    const typed = act.kind === 'typed';
    const blocks: ContextBlock[] = [
      {
        label: 'Agent',
        text: agentGuide({
          name: row.name,
          autonomy: row.autonomy,
          kind: link.kind === 'background' ? 'main' : link.kind,
          memoryEnabled: row.memoryEnabled,
          typed,
        }),
        trusted: true,
      },
    ];
    // The user's own words: trusted (FR-189).
    if (row.instructions.trim())
      blocks.push({ label: 'Instructions from the user', text: row.instructions, trusted: true });
    if (act.kind === 'proactive')
      blocks.push({ label: 'Proactive research', text: PROACTIVE_GUIDE, trusted: true });
    const resps = await this.#resps(row.id);
    if (resps.length)
      blocks.push({
        label: 'Responsibilities',
        text: resps
          .map(
            (r) =>
              `- [${r.status}] ${r.title} (id ${r.id})${r.instructions ? `: ${clipText(r.instructions, 1000)}` : ''}`,
          )
          .join('\n'),
        trusted: true,
      });
    const rules = rulesSummary((await this.#rules(row.id)).map(ruleLike));
    if (rules) blocks.push({ label: 'Rules (enforced by Nova)', text: rules, trusted: true });
    if (goal) {
      const remaining = remainingText(
        { timeMs: row.timeBudgetS * 1000, tokens: row.tokenBudget, costUsd: row.costBudgetUsd },
        goalLimits(goal),
        { run: emptyUsage(), goal: goalUsage(goal) },
      );
      blocks.push({
        label: 'Goal',
        text: `${goal.objective}\n\nStatus: ${goal.status}. Remaining goal budget: ${remaining}.`,
        trusted: goal.createdBy === 'user',
      });
    }
    // In a shared thread only what came from shared threads (FR-088, docs/13 §4).
    const audienceOk = (a: 'private' | 'shared') => link.audience === 'private' || a === 'shared';
    const notes = await this.#db.orm
      .select()
      .from(memT)
      .where(eq(memT.agentId, row.id))
      .orderBy(desc(memT.pinned), desc(memT.updatedAt))
      .limit(100);
    const userNotes = notes.filter((n) => n.author === 'user' && audienceOk(n.originAudience));
    if (userNotes.length)
      blocks.push({
        label: 'Notes from the user',
        text: clipText(userNotes.map((n) => `- ${n.content}`).join('\n'), MAX_NOTES_CONTEXT),
        trusted: true,
      });
    if (row.memoryEnabled) {
      const items = await this.#db.orm
        .select()
        .from(itemT)
        .where(
          and(
            eq(itemT.accountId, row.accountId),
            eq(itemT.scopeKind, 'agent'),
            eq(itemT.scopeRef, row.id),
            eq(itemT.status, 'active'),
          ),
        )
        .orderBy(desc(itemT.pinned), desc(itemT.updatedAt))
        .limit(50);
      const usable = items.filter((i) => audienceOk(i.originAudience));
      if (usable.length)
        blocks.push({
          label: 'What you remember about the user',
          text: clipText(usable.map((i) => `- ${i.content}`).join('\n'), MAX_NOTES_CONTEXT),
          trusted: true,
        });
      // The agent's own notes are data; in a turn the user typed they stay out of the context
      // (agent.notes reads them), so they never taint the user's instruction.
      if (!typed) {
        const own = notes.filter((n) => n.author === 'agent' && audienceOk(n.originAudience));
        const progress = resps.filter((r) => r.progressNote);
        const lines = [
          ...own.map((n) => `- (${n.kind}) ${n.content}`),
          ...progress.map((r) => `- progress on "${r.title}": ${r.progressNote}`),
        ];
        if (lines.length)
          blocks.push({
            label: 'Your notes',
            text: clipText(lines.join('\n'), MAX_NOTES_CONTEXT),
            trusted: false,
            origin: 'memory',
          });
      }
    }
    return blocks;
  }

  #recordUsage(agentId: string, goalId: string | null, d: Usage): void {
    const prev = this.#writes.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(() =>
        this.#db.transaction(() => {
          this.#db.raw
            .prepare(
              `UPDATE agent SET time_used_ms = time_used_ms + ?, tokens_used = tokens_used + ?,
                 cost_used_usd = cost_used_usd + ? WHERE id = ?`,
            )
            .run(d.timeMs, d.tokens, d.costUsd, agentId);
          if (goalId)
            this.#db.raw
              .prepare(
                `UPDATE goal SET time_used_ms = time_used_ms + ?, tokens_used = tokens_used + ?,
                   cost_used_usd = cost_used_usd + ?, updated_at = ? WHERE id = ?`,
              )
              .run(d.timeMs, d.tokens, d.costUsd, this.#iso(), goalId);
        }),
      )
      .catch((err: unknown) => {
        this.#log.warn('could not save agent usage', { err, agentId });
      });
    this.#writes.set(agentId, next);
    void next.then(() => {
      if (this.#writes.get(agentId) === next) this.#writes.delete(agentId);
    });
  }

  async #ended(threadId: string, o: TurnOutcome): Promise<void> {
    const act = this.#active.get(threadId);
    if (!act) return;
    this.#active.delete(threadId);
    this.#chains.delete(threadId);
    try {
      await this.#writes.get(act.agentId);
      const row = await this.#rowById(act.agentId);
      if (!row || this.#deleting.has(row.id)) return;
      const now = this.#iso();
      await this.#db.transaction(() =>
        this.#db.orm.update(agentT).set({ lastActiveAt: now }).where(eq(agentT.id, row.id)),
      );
      const l = this.#link(threadId);
      const link = l ? linkOf(l) : null;
      if (act.kind === 'proactive') await this.#proactiveEnded(row, act, threadId, o);
      if (act.kind === 'typed' && o.status === 'completed' && link)
        await this.#rememberTurn(row, link, o.turnId);
      if (o.stop === 'budget') await this.#budgetReached(row, act, threadId, o);
      if (act.kind === 'goal') await this.#goalTurnEnded(row, act, o);
      else if (o.stop === 'end') await this.#kickGoal(row);
    } catch (err) {
      this.#log.error('could not settle an agent turn', { err, threadId });
    }
  }

  async #budgetReached(row: AgentRow, act: ActiveTurn, threadId: string, o: TurnOutcome) {
    const bound = o.bound?.bound ?? 'time';
    await this.#emit(
      'agent.budget.reached',
      row,
      { agentId: row.id, threadId, turnId: o.turnId, bound },
      'system',
      threadId,
    );
    if (act.kind === 'goal') {
      const g = await this.#openGoal(row.id);
      if (g?.status === 'active' && goalHit(goalLimits(g), goalUsage(g))) {
        await this.#goalStatus(
          row,
          g,
          'budget_limited',
          'system',
          `the ${bound} budget was reached`,
        );
        return;
      }
    }
    await this.#notify(
      row,
      'attention',
      `${row.name} reached its budget`,
      `The ${bound} budget of this task was reached; the work stopped.`,
    );
  }

  /** The blocked rule's bookkeeping (a goal turn without a blocker resets the count). */
  async #goalTurnEnded(row: AgentRow, act: ActiveTurn, o: TurnOutcome): Promise<void> {
    const g = await this.#openGoal(row.id);
    if (!g) return;
    if (act.blocker === null && g.blockerCount > 0)
      await this.#db.transaction(() =>
        this.#db.orm
          .update(goalT)
          .set({
            blockerKey: null,
            blockerDescription: null,
            blockerCount: 0,
            blockerTurnId: null,
            updatedAt: this.#iso(),
          })
          .where(eq(goalT.id, g.id)),
      );
    if (o.stop === 'error') {
      const code = o.error?.code ?? '';
      if (code === 'rate_limited' || code === 'over_budget') {
        await this.#goalStatus(row, g, 'usage_limited', 'system', o.error?.message ?? code);
        return;
      }
    }
    if (o.stop === 'end') await this.#kickGoal(row);
  }

  // ---- policy and status sources ----------------------------------------------------------------

  async #threadPolicy(accountId: string, threadId: string): Promise<ThreadPolicy | null> {
    const l = this.#link(threadId);
    if (!l || l.accountId !== accountId || l.kind === 'background') return null;
    const row = await this.#rowById(l.agentId);
    if (!row) return null;
    return {
      approvalPolicy: AUTONOMY_POLICY[row.autonomy],
      // Proactive research reads only (FR-082): the read-only profile, and the gate's deny rule.
      profileId: l.kind === 'proactive' ? 'read-only' : null,
      roots: null,
      permissionMode: null,
      autoAcceptEdits: false,
    };
  }

  async #agentThreadPolicy(accountId: string, threadId: string): Promise<AgentThreadPolicy | null> {
    const l = this.#link(threadId);
    if (!l || l.accountId !== accountId) return null;
    const scope = { kind: 'thread' as const, ref: threadId };
    const rules: PolicyRule[] = [];
    const commandRules = [];
    for (const r of await this.#rules(l.agentId)) {
      const like = ruleLike(r);
      for (const e of engineRules(like)) rules.push({ ...e, scope });
      const c = engineCommandRule(like);
      if (c) commandRules.push({ ...c, scope });
    }
    if (l.kind === 'proactive')
      rules.push({
        id: `agent-proactive-read-only:${l.agentId}`,
        label: 'Proactive research only reads',
        priority: 0,
        enabled: true,
        source: 'user',
        scope,
        match: { readOnly: false },
        effect: 'deny',
      });
    return { agentId: l.agentId, threadKind: l.kind, rules, commandRules };
  }

  async #blockedThreads(accountId: string, threadIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!threadIds.length) return out;
    const rows = await this.#db.orm
      .select()
      .from(linkT)
      .where(and(eq(linkT.accountId, accountId), inArray(linkT.threadId, threadIds)));
    for (const l of rows) {
      if (l.kind === 'background') continue;
      const row = await this.#rowById(l.agentId);
      if (!row) continue;
      if (row.status === 'paused' && row.pauseReason === 'safety') {
        out.set(l.threadId, 'Paused for safety');
        continue;
      }
      if (l.kind !== 'main') continue;
      const g = await this.#openGoal(row.id);
      if (g?.status === 'blocked') out.set(l.threadId, 'Goal blocked');
      else if (g?.status === 'budget_limited') out.set(l.threadId, 'Budget reached');
      else if (g?.status === 'usage_limited') out.set(l.threadId, 'Usage limit reached');
    }
    return out;
  }

  async #childThreads(accountId: string, threadId: string): Promise<string[]> {
    const l = this.#link(threadId);
    if (l?.kind !== 'main' || l.accountId !== accountId) return [];
    return (await this.#links(l.agentId))
      .filter((x) => x.kind === 'proactive' || x.kind === 'background')
      .map((x) => x.threadId);
  }

  async #derived(row: AgentRow, goal: GoalRow | null): Promise<StatusView> {
    if (row.status === 'paused' && row.pauseReason === 'safety')
      return { status: 'blocked', reason: 'Paused for safety' };
    const threads = (await this.#links(row.id)).map((l) => l.threadId);
    let best: StatusView = { status: 'ready', reason: null };
    if (this.#statusOf && threads.length) {
      try {
        for (const v of (await this.#statusOf(row.accountId, threads)).values())
          if (PRECEDENCE[v.status] < PRECEDENCE[best.status]) best = v;
      } catch (err) {
        this.#log.warn('agent status lookup failed', { err, agentId: row.id });
      }
    } else if (threads.some((t) => this.#active.has(t))) {
      best = { status: 'running', reason: null };
    }
    if (PRECEDENCE[best.status] > PRECEDENCE.blocked) {
      if (goal?.status === 'blocked') return { status: 'blocked', reason: 'Goal blocked' };
      if (goal?.status === 'budget_limited') return { status: 'blocked', reason: 'Budget reached' };
    }
    return best;
  }

  // ---- internals ------------------------------------------------------------------------------

  async #view(row: AgentRow): Promise<AgentView> {
    const resps = await this.#resps(row.id);
    const goal = await this.#openGoal(row.id);
    const open = this.#db.raw
      .prepare("SELECT COUNT(*) AS n FROM agent_suggestion WHERE agent_id = ? AND status = 'open'")
      .get(row.id) as { n: number };
    return {
      id: row.id,
      name: row.name,
      hasAvatar: row.avatarPath !== null,
      instructions: row.instructions,
      status: row.status,
      pauseReason: row.status === 'paused' ? row.pauseReason : null,
      statusDetail: row.statusDetail,
      autonomy: row.autonomy,
      model: row.model,
      computerId: row.computerId,
      primaryThreadId: row.primaryThreadId,
      proactive: { enabled: row.proactive, lastRunAt: row.lastProactiveAt },
      memoryEnabled: row.memoryEnabled,
      budgets: {
        timeSeconds: row.timeBudgetS,
        tokens: row.tokenBudget,
        costUsd: row.costBudgetUsd,
      },
      usage: {
        timeSeconds: Math.floor(row.timeUsedMs / 1000),
        tokens: row.tokensUsed,
        costUsd: Math.round(row.costUsedUsd * 1e6) / 1e6,
      },
      goalId: goal?.id ?? null,
      responsibilities: resps.map(respView),
      derived: await this.#derived(row, goal),
      openSuggestions: open.n,
      lastActiveAt: row.lastActiveAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async #assertAutonomy(autonomy: RunAutonomy): Promise<void> {
    // Auto-review fails closed without a reviewer model (FR-085): say so before the agent acts.
    if (autonomy === 'autonomous' && !(await this.#settings.reviewModel()))
      throw new NovaError(
        'validation',
        'an autonomous agent needs a reviewer model: choose one in Settings',
        { details: { field: 'autonomy', reason: 'review_model_required' } },
      );
  }

  #storeAvatar(avatar: { mime: AvatarMime; data: string }): string {
    return writeAttachmentBlob(this.#dataDir, prepareAvatar(avatar.mime, avatar.data)).blobPath;
  }

  /** Remove an avatar blob nothing else uses (another agent or the account may share it). */
  #dropAvatar(path: string): void {
    removeUnreferencedBlobs(this.#db, this.#dataDir, [path]);
  }

  async #ensureComputer(row: AgentRow): Promise<void> {
    const computers = this.#computers;
    if (!computers || row.computerId) return;
    try {
      const c = await computers.forAgent(row.accountId, row.id);
      await this.#db.transaction(() =>
        this.#db.orm
          .update(agentT)
          .set({ computerId: c.id })
          .where(and(eq(agentT.id, row.id), sql`${agentT.computerId} IS NULL`)),
      );
    } catch (err) {
      this.#log.warn('the agent computer is not available yet', { err, agentId: row.id });
    }
  }

  async #mainThread(row: AgentRow): Promise<string> {
    if (row.primaryThreadId) {
      const t = this.#db.raw
        .prepare('SELECT 1 AS x FROM thread WHERE id = ? AND deleted_at IS NULL')
        .get(row.primaryThreadId);
      if (t) return row.primaryThreadId;
    }
    const thread = await this.#threads.create(row.accountId, {
      mode: 'agent',
      title: row.name,
      memoryOptOut: true,
      ...(row.model ? { model: row.model } : {}),
    });
    const now = this.#iso();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(agentT)
        .set({ primaryThreadId: thread.id, updatedAt: now })
        .where(eq(agentT.id, row.id));
      await this.#db.orm.insert(linkT).values({
        threadId: thread.id,
        agentId: row.id,
        accountId: row.accountId,
        kind: 'main',
        bindingRef: null,
        audience: 'private',
        runId: null,
        createdAt: now,
      });
    });
    row.primaryThreadId = thread.id;
    return thread.id;
  }

  async #proactiveThread(row: AgentRow): Promise<string> {
    const found = (await this.#links(row.id)).find((l) => l.kind === 'proactive');
    if (found) return found.threadId;
    const main = await this.#mainThread(row);
    const thread = await this.#threads.create(row.accountId, {
      mode: 'agent',
      title: clipText(`${row.name}: research`, 200),
      memoryOptOut: true,
      ...(row.model ? { model: row.model } : {}),
    });
    await this.#db.transaction(async () => {
      this.#db.raw
        .prepare('UPDATE thread SET parent_thread_id = ? WHERE id = ?')
        .run(main, thread.id);
      await this.#db.orm.insert(linkT).values({
        threadId: thread.id,
        agentId: row.id,
        accountId: row.accountId,
        kind: 'proactive',
        bindingRef: null,
        audience: 'private',
        runId: null,
        createdAt: this.#iso(),
      });
    });
    return thread.id;
  }

  /** Cancel every turn the agent has running or queued (pause, stop, delete). */
  async #cancelTurns(row: AgentRow): Promise<void> {
    const turns = this.#turns;
    if (!turns) return;
    for (const l of await this.#links(row.id)) {
      if (l.kind === 'background') continue;
      for (const [turnId, q] of this.#queued)
        if (q.threadId === l.threadId) this.#queued.delete(turnId);
      if (!this.#threadBusy(l.threadId) && !this.#active.has(l.threadId)) continue;
      await turns.cancel(row.accountId, l.threadId).catch((err: unknown) => {
        this.#log.warn('could not cancel an agent turn', { err, threadId: l.threadId });
      });
    }
  }

  /** Pause or cancel the agent's live background runs; returns the ones it changed. */
  async #controlRuns(row: AgentRow, action: 'pause' | 'cancel'): Promise<string[]> {
    const runs = this.#runs;
    if (!runs || (action === 'pause' ? !runs.pause : !runs.cancel)) return [];
    const fn = (accountId: string, runId: string) =>
      action === 'pause' ? runs.pause?.(accountId, runId) : runs.cancel?.(accountId, runId);
    const statuses = action === 'pause' ? LIVE_RUN : [...LIVE_RUN, 'paused'];
    const ids = (
      this.#db.raw
        .prepare(
          `SELECT id FROM run WHERE account_id = ? AND agent_id = ?
           AND status IN (${statuses.map(() => '?').join(', ')})`,
        )
        .all(row.accountId, row.id, ...statuses) as { id: string }[]
    ).map((r) => r.id);
    const done: string[] = [];
    for (const runId of ids) {
      try {
        await fn(row.accountId, runId);
        done.push(runId);
      } catch (err) {
        this.#log.warn(`could not ${action} a background run`, { err, runId });
      }
    }
    return done;
  }

  /** The turn answers a message the signed-in user typed (FR-189), not text Nova started. */
  #typedByUser(turnId: string): boolean {
    const m = this.#db.raw
      .prepare(
        `SELECT 1 AS x FROM message WHERE turn_id = ? AND role = 'user' AND author_kind = 'user'
         AND provenance = 'typed' LIMIT 1`,
      )
      .get(turnId);
    return m !== undefined;
  }

  /** A turn is running, queued or starting on the thread, or input or a request waits there. */
  #threadBusy(threadId: string): boolean {
    if (this.#active.has(threadId) || this.#pending.has(threadId)) return true;
    for (const q of this.#queued.values()) if (q.threadId === threadId) return true;
    const t = this.#db.raw.prepare('SELECT state FROM thread WHERE id = ?').get(threadId) as
      { state: string } | undefined;
    if (t && t.state !== 'idle') return true;
    const busy = this.#db.raw
      .prepare(
        `SELECT 1 AS x FROM turn WHERE thread_id = ? AND status = 'in_progress'
         UNION ALL SELECT 1 FROM queued_input WHERE thread_id = ? AND status = 'pending'
         UNION ALL SELECT 1 FROM server_request WHERE thread_id = ? AND status = 'pending'
         LIMIT 1`,
      )
      .get(threadId, threadId, threadId);
    return busy !== undefined;
  }

  async #quietWindow(accountId: string, at: Date) {
    if (!this.#quiet) return null;
    try {
      return await this.#quiet(accountId, at);
    } catch (err) {
      this.#log.warn('quiet hours unavailable', { err });
      return null;
    }
  }

  async #statusChanged(
    row: AgentRow,
    from: AgentRow['status'],
    to: AgentRow['status'],
    reason: string | null,
    actor: string,
  ): Promise<void> {
    await this.#emit('agent.status.changed', row, { agentId: row.id, from, to, reason }, actor);
  }

  #requireScheduler(): AgentScheduler {
    if (!this.#scheduler) throw new NovaError('capability_missing', 'schedules are not available');
    return this.#scheduler;
  }

  #requireLink(accountId: string, threadId: string): AgentThreadLink {
    const l = this.#link(threadId);
    if (!l || l.accountId !== accountId || l.kind === 'background')
      throw new NovaError('validation', 'this works only in an agent thread');
    return linkOf(l);
  }

  #link(threadId: string): LinkRow | null {
    const r = this.#db.raw
      .prepare(
        `SELECT thread_id AS threadId, agent_id AS agentId, account_id AS accountId, kind,
           binding_ref AS bindingRef, audience, run_id AS runId, created_at AS createdAt
         FROM agent_thread WHERE thread_id = ?`,
      )
      .get(threadId) as LinkRow | undefined;
    return r ?? null;
  }

  async #links(agentId: string): Promise<AgentThreadLink[]> {
    const rows = await this.#db.orm
      .select()
      .from(linkT)
      .where(eq(linkT.agentId, agentId))
      .orderBy(asc(linkT.createdAt));
    return rows.map(linkOf);
  }

  async #row(accountId: string, id: string): Promise<AgentRow> {
    const rows = await this.#db.orm
      .select()
      .from(agentT)
      .where(and(eq(agentT.id, id), eq(agentT.accountId, accountId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'agent not found');
    return row;
  }

  async #rowById(id: string): Promise<AgentRow | null> {
    const rows = await this.#db.orm.select().from(agentT).where(eq(agentT.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async #resps(agentId: string): Promise<RespRow[]> {
    return this.#db.orm
      .select()
      .from(respT)
      .where(eq(respT.agentId, agentId))
      .orderBy(asc(respT.position), asc(respT.createdAt));
  }

  async #resp(agentId: string, rid: string): Promise<RespRow> {
    const rows = await this.#db.orm
      .select()
      .from(respT)
      .where(and(eq(respT.id, rid), eq(respT.agentId, agentId)))
      .limit(1);
    const r = rows[0];
    if (!r) throw new NovaError('not_found', 'responsibility not found');
    return r;
  }

  async #rules(agentId: string): Promise<RuleRow[]> {
    return this.#db.orm
      .select()
      .from(ruleT)
      .where(eq(ruleT.agentId, agentId))
      .orderBy(asc(ruleT.priority), asc(ruleT.createdAt));
  }

  async #rule(agentId: string, ruleId: string): Promise<RuleRow> {
    const rows = await this.#db.orm
      .select()
      .from(ruleT)
      .where(and(eq(ruleT.id, ruleId), eq(ruleT.agentId, agentId)))
      .limit(1);
    const r = rows[0];
    if (!r) throw new NovaError('not_found', 'rule not found');
    return r;
  }

  async #note(agentId: string, id: string): Promise<MemRow | null> {
    const rows = await this.#db.orm
      .select()
      .from(memT)
      .where(and(eq(memT.id, id), eq(memT.agentId, agentId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async #item(accountId: string, agentId: string, id: string): Promise<ItemRow> {
    const rows = await this.#db.orm
      .select()
      .from(itemT)
      .where(
        and(
          eq(itemT.id, id),
          eq(itemT.accountId, accountId),
          eq(itemT.scopeKind, 'agent'),
          eq(itemT.scopeRef, agentId),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (!r) throw new NovaError('not_found', 'memory item not found');
    return r;
  }

  async #openGoal(agentId: string): Promise<GoalRow | null> {
    const rows = await this.#db.orm
      .select()
      .from(goalT)
      .where(and(eq(goalT.agentId, agentId), ne(goalT.status, 'complete')))
      .limit(1);
    return rows[0] ?? null;
  }

  async #latestGoal(agentId: string): Promise<GoalRow | null> {
    const rows = await this.#db.orm
      .select()
      .from(goalT)
      .where(eq(goalT.agentId, agentId))
      .orderBy(desc(goalT.updatedAt), desc(goalT.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async #goalById(id: string): Promise<GoalRow | null> {
    const rows = await this.#db.orm.select().from(goalT).where(eq(goalT.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async #lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
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

  #track(p: Promise<unknown>): void {
    const t = p.catch((err: unknown) => {
      this.#log.warn('agent background work failed', { err });
    });
    this.#background.add(t);
    void t.finally(() => this.#background.delete(t));
  }

  async #emit(
    name: string,
    row: Pick<AgentRow, 'id' | 'accountId'>,
    payload: Record<string, unknown>,
    actor: string,
    threadId?: string | null,
  ): Promise<void> {
    await this.#events.emit({
      name,
      actor,
      accountId: row.accountId,
      correlation: { agentId: row.id, ...(threadId ? { threadId } : {}) },
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
        ...(g.agentId ? { agentId: g.agentId } : {}),
      },
      payload,
    });
  }

  async #auditAgent(
    row: Pick<AgentRow, 'id' | 'accountId' | 'primaryThreadId'>,
    actor: string,
    action: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#appendAudit({
      accountId: row.accountId,
      actor,
      kind: 'agent',
      action,
      resource: `agent:${row.id}`,
      threadId: row.primaryThreadId,
      detail: { agentId: row.id, ...detail },
    });
  }

  async #appendAudit(rec: AuditRecord): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append(rec);
    } catch (err) {
      this.#log.warn('could not audit an agent change', { err, action: rec.action });
    }
  }

  async #notify(
    row: Pick<AgentRow, 'id' | 'accountId'>,
    kind: 'attention' | 'completion' | 'error',
    title: string,
    body: string,
  ): Promise<void> {
    if (!this.#notifier) return;
    try {
      await this.#notifier.notify({
        accountId: row.accountId,
        kind,
        title: clipText(title, 200),
        body: clipText(body, 500),
        href: `/agents/${row.id}`,
        dedupeKey: `agent:${row.id}:${title}`,
      });
    } catch (err) {
      this.#log.warn('could not notify about an agent', { err, agentId: row.id });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

function wakeError(message: string): NovaError {
  return new NovaError('validation', message, { details: { field: 'wake' } });
}
