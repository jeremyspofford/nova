// Schedules (FR-055, FR-187, ADR-079; docs/09 §6): CRUD, the loop that fires them as Work runs,
// catch-up of missed fires, delivery and verified outcomes.
//
// - The loop sleeps until the earliest `next_run_at` and re-checks at least every minute, so a
//   wake from sleep or a clock change is noticed. Each due schedule is handled once: the fire is
//   claimed in the transaction that moves `next_run_at`, and a unique index on the rule time stops
//   a second claim, across restarts too.
// - A fire handled later than `lateMs` after its time was missed. Missed fires inside the lookback
//   collapse into one catch-up run told the window (first, last, count); with policy `skip` the
//   misses are only recorded, and misses older than the lookback are recorded as skipped.
// - A run of the same schedule that is still going makes the next fire a recorded skip (no
//   overlapping runs of one schedule). "Run now" is the user's explicit request and always starts.
// - Firing starts a Work run through the RunStarter (origin `schedule`). The schedule's
//   instructions carry the user's authority only when the user wrote the schedule (FR-189).
// - When the run ends, its result is delivered (unless it reported no news with schedule.report)
//   and the outcome is decided: `done` only when every declared output is verified (a message
//   needs a delivery receipt), `no_news`, `output_missing` with the run linked, or the run's own
//   `failed` / `cancelled`.
import {
  NovaError,
  uuidv7,
  type ExpectedOutput,
  type RunAutonomy,
  type ScheduleFireView,
  type ScheduleOutcome,
  type ScheduleView,
  type ScheduleWhen,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { RunFinish, RunStarter } from '../runtime/types.ts';
import { fail, ok } from '../tools/builtin.ts';
import type { AuditRecord, Notifier, ToolResult, ToolSourceProvider } from '../tools/types.ts';
import {
  deliverAll,
  ensureWebhookSecret,
  httpsTransport,
  notificationChannel,
  webhookChannel,
  webhookSecretRef,
  webhookUrlProblem,
  type DeliveryChannel,
  type DeliveryKind,
  type DeliveryResult,
  type DeliveryTarget,
  type ReceiptNotifier,
  type WebhookTransport,
} from './delivery.ts';
import {
  assertFires,
  compileRecurrence,
  fieldError,
  windowOf,
  type FireWindow,
  type Recurrence,
} from './recurrence.ts';
import { MAX_REPORT_MESSAGE, reportTool, type ReportArgs } from './report.ts';

/** What a user (or, from M6, an agent) gives to create a schedule; the API's scheduleSchema. */
export interface ScheduleInput {
  when: ScheduleWhen;
  timezone: string;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  title?: string | undefined;
  instructions: string;
  notifyCondition?: string | undefined;
  deliveryTargets: DeliveryTarget[];
  output?: ExpectedOutput | undefined;
  catchUp?: { policy?: 'once' | 'skip' | undefined; lookbackSeconds?: number | undefined };
  projectId?: string | undefined;
  autonomy?: RunAutonomy | undefined;
  enabled?: boolean | undefined;
}

export type SchedulePatch = Partial<ScheduleInput>;

/** Who made an agent-targeted schedule (M6, FR-059, FR-206; docs/09 §6). */
export interface AgentScheduleOptions {
  agentId: string;
  /** `user`: the user scheduled the agent; `agent`: schedule.create; `agent_self`: schedule.wake. */
  origin: 'user' | 'agent' | 'agent_self';
  /** Required for `agent_self` (≤ 500 characters). */
  wakeReason?: string | null;
  /** The event and audit actor: `user` or `agent:<id>`. */
  actor: string;
}

/** A fire of an agent-targeted schedule: a turn on the agent's main thread (trigger `schedule`). */
export interface AgentFireInput {
  accountId: string;
  agentId: string;
  scheduleId: string;
  fireId: string;
  kind: 'fire' | 'catch_up';
  title: string;
  /** The instructions (plus the notify condition and a catch-up window), as for a run. */
  text: string;
  origin: 'user' | 'agent' | 'agent_self';
  wakeReason: string | null;
  manual: boolean;
}

/** The agents area starts agent turns for fires (late-bound with `useAgents`). */
export interface AgentFireTarget {
  /** Throws when the agent cannot take the turn (deleted, paused); the fire then fails. */
  fire(input: AgentFireInput): Promise<{
    threadId: string;
    done: Promise<Pick<RunFinish, 'status' | 'summary'>>;
  }>;
}

/** A schedule as the API shows it, with the agent it targets (M6). */

/** The audit sink with a kind of its own (`schedule`); AuditLog satisfies it. */
export interface ScheduleAuditSink {
  append(rec: Omit<AuditRecord, 'kind'> & { kind: string }): Promise<void>;
}

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ScheduleServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  secrets: SecretStore;
  audit?: ScheduleAuditSink;
  /** In-app and OS delivery; a notifier with `create` gives receipts (NotificationService). */
  notifier?: Notifier | ReceiptNotifier;
  log?: Logger;
  now?: () => Date;
  timers?: SchedulerTimers;
  /** Webhook POSTs; the default is https with the private-address guard. */
  webhookTransport?: WebhookTransport;
  /** Replace or add delivery channels (channels add slack, teams and email in M6). */
  channels?: Partial<Record<DeliveryKind, DeliveryChannel>>;
  /** The loop re-checks at least this often (default 60 s). */
  recheckMs?: number;
  /** A fire handled later than this after its time counts as missed (default 2 min). */
  lateMs?: number;
  /** How long `stop()` waits for a run start in flight (default 5 s). */
  stopWaitMs?: number;
}

const DEFAULT_LOOKBACK_S = 604_800;
const WINDOW_CAP = 1_000_000;
const UNAVAILABLE: Record<string, string> = {
  slack: 'Slack delivery is not available yet; use in-app, OS or webhook delivery',
  teams: 'Teams delivery is not available yet; use in-app, OS or webhook delivery',
  email: 'Email delivery is not available yet; use in-app, OS or webhook delivery',
};

interface ScheduleRow {
  id: string;
  account_id: string;
  project_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  title: string;
  cron: string | null;
  rrule: string | null;
  interval_seconds: number | null;
  once_at: string | null;
  timezone: string;
  starts_at: string | null;
  ends_at: string | null;
  instructions: string;
  notify_condition: string | null;
  delivery_targets_json: string;
  expected_output_json: string | null;
  catch_up_policy: 'once' | 'skip';
  catch_up_lookback_s: number;
  autonomy: RunAutonomy;
  origin: 'user' | 'agent' | 'agent_self';
  wake_reason: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_outcome: ScheduleOutcome | null;
  created_at: string;
  updated_at: string;
}

interface FireRow {
  id: string;
  schedule_id: string;
  account_id: string;
  kind: 'fire' | 'catch_up' | 'skipped';
  due_at: string | null;
  window_first: string | null;
  window_last: string | null;
  window_count: number | null;
  run_id: string | null;
  thread_id: string | null;
  notify: number | null;
  report_message: string | null;
  receipts_json: string | null;
  outcome: ScheduleOutcome | null;
  detail: string | null;
  fired_at: string;
  ended_at: string | null;
}

type FireKind = FireRow['kind'];

interface PlannedEntry {
  kind: FireKind;
  due: number;
  window: FireWindow | null;
  detail: string | null;
  reason?: 'policy' | 'lookback' | 'running';
}

interface Delivered {
  noNews: boolean;
  results: DeliveryResult[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const normalize = (v: string | undefined | null) => (v ? new Date(v).toISOString() : null);

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function whenOf(r: ScheduleRow): ScheduleWhen {
  if (r.cron !== null) return { cron: r.cron };
  if (r.rrule !== null) return { rrule: r.rrule };
  if (r.interval_seconds !== null) return { intervalSeconds: r.interval_seconds };
  return { at: r.once_at ?? r.created_at };
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function defaultTitle(instructions: string): string {
  const line = instructions.trim().split('\n')[0]?.trim() ?? '';
  return (line.length > 80 ? `${line.slice(0, 79)}…` : line) || 'Scheduled task';
}

function toView(r: ScheduleRow): ScheduleView {
  return {
    id: r.id,
    agentId: r.agent_id,
    wakeReason: r.wake_reason,
    title: r.title,
    when: whenOf(r),
    timezone: r.timezone,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    instructions: r.instructions,
    notifyCondition: r.notify_condition,
    deliveryTargets: parseJson<DeliveryTarget[]>(r.delivery_targets_json) ?? [],
    output: parseJson<ExpectedOutput>(r.expected_output_json),
    catchUp: { policy: r.catch_up_policy, lookbackSeconds: r.catch_up_lookback_s },
    origin: r.origin,
    projectId: r.project_id,
    autonomy: r.autonomy,
    enabled: r.enabled === 1,
    nextRunAt: r.enabled === 1 ? r.next_run_at : null,
    lastRunAt: r.last_run_at,
    lastOutcome: r.last_outcome,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function fireView(f: FireRow): ScheduleFireView {
  return {
    id: f.id,
    scheduleId: f.schedule_id,
    kind: f.kind,
    window:
      f.window_first !== null && f.window_last !== null
        ? { first: f.window_first, last: f.window_last, count: f.window_count ?? 0 }
        : null,
    runId: f.run_id,
    outcome: f.outcome,
    firedAt: f.fired_at,
  };
}

function windowPayload(w: FireWindow | null) {
  return w ? { first: iso(w.first), last: iso(w.last), count: w.count } : undefined;
}

export class ScheduleService {
  /** `schedule.report`, offered while a scheduled run of the account is open. */
  readonly reportTools: ToolSourceProvider;

  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #secrets: SecretStore;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #timers: SchedulerTimers;
  readonly #recheckMs: number;
  readonly #lateMs: number;
  readonly #stopWaitMs: number;
  readonly #channels = new Map<DeliveryKind, DeliveryChannel>();
  #audit: ScheduleAuditSink | null;
  #notifier: Notifier | ReceiptNotifier | null;
  #runs: RunStarter | null = null;
  #agents: AgentFireTarget | null = null;

  #started = false;
  #closed = false;
  #recovered = false;
  #timer: unknown = null;
  #ticking = false;
  #again = false;
  /** Ticks, run starts and settlements in progress (what `idle()` waits for). */
  readonly #work = new Set<Promise<unknown>>();
  /** createRun calls in flight, by fire id. */
  readonly #starting = new Map<string, Promise<unknown>>();
  /** One delivery per fire, shared by the outcome and the runs area's output check. */
  readonly #deliveries = new Map<string, Promise<Delivered>>();

  constructor(opts: ScheduleServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#secrets = opts.secrets;
    this.#audit = opts.audit ?? null;
    this.#notifier = opts.notifier ?? null;
    this.#log = opts.log ?? new Logger({ module: 'core.scheduler', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#timers = opts.timers ?? {
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref();
        return h;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.#recheckMs = opts.recheckMs ?? 60_000;
    this.#lateMs = opts.lateMs ?? 120_000;
    this.#stopWaitMs = opts.stopWaitMs ?? 5000;
    const inbox = notificationChannel(() => this.#notifier);
    this.#channels.set('inapp', inbox);
    this.#channels.set('os', inbox);
    this.#channels.set(
      'webhook',
      webhookChannel({
        secrets: this.#secrets,
        transport: opts.webhookTransport ?? httpsTransport(),
        now: this.#now,
      }),
    );
    for (const [kind, channel] of Object.entries(opts.channels ?? {}) as [
      DeliveryKind,
      DeliveryChannel | undefined,
    ][]) {
      if (channel) this.#channels.set(kind, channel);
    }
    const tool = reportTool((accountId, threadId, args) => this.report(accountId, threadId, args));
    this.reportTools = {
      source: 'builtin',
      // With a turn's scope, only the thread of a run this schedule fired gets the tool.
      list: (accountId, scope) =>
        Promise.resolve(
          (
            scope
              ? scope.threadId !== null && this.#openFireByThread(accountId, scope.threadId)
              : this.#hasOpenFire(accountId)
          )
            ? [tool]
            : [],
        ),
    };
  }

  // ---- wiring ---------------------------------------------------------------------------------

  /** The runs area starts the Work runs (late-bound; nothing fires until it is set). */
  useRuns(runs: RunStarter): void {
    this.#runs = runs;
    this.#arm(0);
  }

  /** M6: the agents area takes the fires of agent-targeted schedules (late-bound). */
  useAgents(target: AgentFireTarget): void {
    this.#agents = target;
    this.#arm(0);
  }

  useNotifier(notifier: Notifier | ReceiptNotifier): void {
    this.#notifier = notifier;
  }

  useAudit(audit: ScheduleAuditSink): void {
    this.#audit = audit;
  }

  /** Add a delivery channel (M6: slack, teams, email); targets of that kind are then accepted. */
  useChannel(kind: DeliveryKind, channel: DeliveryChannel): void {
    this.#channels.set(kind, channel);
  }

  // ---- CRUD -------------------------------------------------------------------------------------

  list(accountId: string): Promise<ScheduleView[]> {
    const rows = this.#db.raw
      .prepare('SELECT * FROM schedule WHERE account_id = ? ORDER BY created_at DESC, id DESC')
      .all(accountId) as unknown as ScheduleRow[];
    return Promise.resolve(rows.map(toView));
  }

  get(accountId: string, id: string): Promise<ScheduleView> {
    return Promise.resolve().then(() => toView(this.#row(accountId, id)));
  }

  /** M6: the schedules that target one agent, newest first (FR-059, FR-206). */
  listForAgent(accountId: string, agentId: string): Promise<ScheduleView[]> {
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM schedule WHERE account_id = ? AND agent_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(accountId, agentId) as unknown as ScheduleRow[];
    return Promise.resolve(rows.map(toView));
  }

  /** Create a schedule the signed-in user wrote (origin `user`). */
  create(accountId: string, input: ScheduleInput): Promise<ScheduleView> {
    return this.#create(accountId, input, null);
  }

  /**
   * M6: a schedule whose fires start turns on an agent (docs/09 §6): the user's own (`user`),
   * one the agent made with schedule.create (`agent`, FR-059) or a self-set wake from
   * schedule.wake (`agent_self`, FR-206: one-shot, with a reason). Only `user` instructions carry
   * the user's authority when they fire (FR-189).
   */
  createForAgent(
    accountId: string,
    input: ScheduleInput,
    opts: AgentScheduleOptions,
  ): Promise<ScheduleView> {
    return Promise.resolve().then(() => {
      if (opts.origin === 'agent_self') {
        if (!('at' in input.when)) throw fieldError('when', 'a self-set wake fires once: use at');
        if (!opts.wakeReason?.trim())
          throw fieldError('wakeReason', 'a self-set wake needs a reason');
      }
      return this.#create(accountId, input, opts);
    });
  }

  async #create(
    accountId: string,
    input: ScheduleInput,
    agent: AgentScheduleOptions | null,
  ): Promise<ScheduleView> {
    const actor = agent?.actor ?? 'user';
    const now = this.#now();
    const createdAt = now.toISOString();
    const id = uuidv7();
    const { next } = this.#validate(accountId, input, createdAt, now.getTime(), true);
    const targets = input.deliveryTargets;
    if (targets.some((t) => t.kind === 'webhook')) await ensureWebhookSecret(this.#secrets, id);
    const row: ScheduleRow = {
      id,
      account_id: accountId,
      project_id: input.projectId ?? null,
      run_id: null,
      agent_id: agent?.agentId ?? null,
      title: input.title?.trim() || defaultTitle(input.instructions),
      cron: 'cron' in input.when ? input.when.cron.trim() : null,
      rrule: 'rrule' in input.when ? input.when.rrule.trim() : null,
      interval_seconds: 'intervalSeconds' in input.when ? input.when.intervalSeconds : null,
      once_at: 'at' in input.when ? normalize(input.when.at) : null,
      timezone: input.timezone,
      starts_at: normalize(input.startsAt),
      ends_at: normalize(input.endsAt),
      instructions: input.instructions,
      notify_condition: input.notifyCondition?.trim() || null,
      delivery_targets_json: JSON.stringify(targets),
      expected_output_json: input.output ? JSON.stringify(input.output) : null,
      catch_up_policy: input.catchUp?.policy ?? 'once',
      catch_up_lookback_s: input.catchUp?.lookbackSeconds ?? DEFAULT_LOOKBACK_S,
      autonomy: input.autonomy ?? 'standard',
      origin: agent?.origin ?? 'user',
      wake_reason:
        agent?.origin === 'agent_self' ? (agent.wakeReason ?? '').trim().slice(0, 500) : null,
      enabled: input.enabled === false ? 0 : 1,
      last_run_at: null,
      next_run_at: next === null ? null : iso(next),
      last_outcome: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO schedule (id, account_id, project_id, run_id, agent_id, title, cron, rrule,
             interval_seconds, once_at, timezone, starts_at, ends_at, instructions, notify_condition,
             delivery_targets_json, expected_output_json, catch_up_policy, catch_up_lookback_s,
             autonomy, origin, wake_reason, enabled, last_run_at, next_run_at, last_outcome,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.account_id,
          row.project_id,
          row.run_id,
          row.agent_id,
          row.title,
          row.cron,
          row.rrule,
          row.interval_seconds,
          row.once_at,
          row.timezone,
          row.starts_at,
          row.ends_at,
          row.instructions,
          row.notify_condition,
          row.delivery_targets_json,
          row.expected_output_json,
          row.catch_up_policy,
          row.catch_up_lookback_s,
          row.autonomy,
          row.origin,
          row.wake_reason,
          row.enabled,
          row.last_run_at,
          row.next_run_at,
          row.last_outcome,
          row.created_at,
          row.updated_at,
        );
    });
    await this.#events.emit({
      name: 'schedule.created',
      actor,
      accountId,
      // An agent's schedule names it, so agent views refetch only their own (FR-206).
      ...(row.agent_id ? { correlation: { agentId: row.agent_id } } : {}),
      payload: { scheduleId: id, origin: row.origin, agentId: row.agent_id },
    });
    if (row.origin === 'agent_self' && row.agent_id)
      await this.#events.emit({
        name: 'schedule.wake.set',
        actor,
        accountId,
        correlation: { agentId: row.agent_id },
        payload: {
          scheduleId: id,
          agentId: row.agent_id,
          at: row.once_at,
          reason: row.wake_reason,
        },
      });
    await this.#auditAppend({
      accountId,
      actor,
      kind: 'schedule',
      action: row.origin === 'agent_self' ? 'schedule.wake' : 'schedule.create',
      resource: `schedule:${id}`,
      detail: {
        when: whenOf(row),
        timezone: row.timezone,
        targets: targets.map((t) => t.kind),
        ...(row.agent_id ? { agentId: row.agent_id, origin: row.origin } : {}),
      },
    });
    this.#arm();
    return toView(row);
  }

  /**
   * Change a schedule; `enabled: false` pauses it, and resuming skips what fell in the pause.
   * M6: `opts.agentId` limits the edit to that agent's schedules (schedule.create with an id,
   * FR-059); `opts.actor` names who changed it (default the user).
   */
  async update(
    accountId: string,
    id: string,
    patch: SchedulePatch,
    opts: { actor?: string; agentId?: string } = {},
  ): Promise<ScheduleView> {
    const row = this.#row(accountId, id);
    if (opts.agentId !== undefined && row.agent_id !== opts.agentId)
      throw new NovaError('not_found', 'schedule not found');
    const actor = opts.actor ?? 'user';
    const keys = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    if (!keys.length) throw new NovaError('validation', 'nothing to update');
    const view = toView(row);
    const merged: ScheduleInput = {
      when: patch.when ?? view.when,
      timezone: patch.timezone ?? view.timezone,
      startsAt: patch.startsAt ?? view.startsAt ?? undefined,
      endsAt: patch.endsAt ?? view.endsAt ?? undefined,
      title: patch.title ?? view.title,
      instructions: patch.instructions ?? view.instructions,
      notifyCondition: patch.notifyCondition ?? view.notifyCondition ?? undefined,
      deliveryTargets: patch.deliveryTargets ?? view.deliveryTargets,
      output: patch.output ?? view.output ?? undefined,
      catchUp: {
        policy: patch.catchUp?.policy ?? view.catchUp.policy,
        lookbackSeconds: patch.catchUp?.lookbackSeconds ?? view.catchUp.lookbackSeconds,
      },
      projectId: patch.projectId ?? view.projectId ?? undefined,
      autonomy: patch.autonomy ?? view.autonomy,
      enabled: patch.enabled ?? view.enabled,
    };
    const now = this.#now();
    const ruleChanged = ['when', 'timezone', 'startsAt', 'endsAt'].some((k) => keys.includes(k));
    const { rec } = this.#validate(accountId, merged, row.created_at, now.getTime(), ruleChanged);
    const resumed = merged.enabled === true && row.enabled === 0;
    const next = ruleChanged || resumed ? rec.next(now.getTime()) : parseNext(row.next_run_at);
    if (merged.deliveryTargets.some((t) => t.kind === 'webhook'))
      await ensureWebhookSecret(this.#secrets, id);
    const when = merged.when;
    const updatedAt = now.toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE schedule SET project_id = ?, title = ?, cron = ?, rrule = ?, interval_seconds = ?,
             once_at = ?, timezone = ?, starts_at = ?, ends_at = ?, instructions = ?,
             notify_condition = ?, delivery_targets_json = ?, expected_output_json = ?,
             catch_up_policy = ?, catch_up_lookback_s = ?, autonomy = ?, enabled = ?,
             next_run_at = ?, updated_at = ?
           WHERE id = ? AND account_id = ?`,
        )
        .run(
          merged.projectId ?? null,
          merged.title?.trim() || defaultTitle(merged.instructions),
          'cron' in when ? when.cron.trim() : null,
          'rrule' in when ? when.rrule.trim() : null,
          'intervalSeconds' in when ? when.intervalSeconds : null,
          'at' in when ? normalize(when.at) : null,
          merged.timezone,
          normalize(merged.startsAt),
          normalize(merged.endsAt),
          merged.instructions,
          merged.notifyCondition?.trim() || null,
          JSON.stringify(merged.deliveryTargets),
          merged.output ? JSON.stringify(merged.output) : null,
          merged.catchUp?.policy ?? 'once',
          merged.catchUp?.lookbackSeconds ?? DEFAULT_LOOKBACK_S,
          merged.autonomy ?? 'standard',
          merged.enabled === false ? 0 : 1,
          next === null ? null : iso(next),
          updatedAt,
          id,
          accountId,
        );
    });
    await this.#events.emit({
      name: 'schedule.changed',
      actor,
      accountId,
      // An agent's schedule names it, so agent views refetch only their own (FR-206).
      ...(row.agent_id ? { correlation: { agentId: row.agent_id } } : {}),
      payload: { scheduleId: id, origin: row.origin, changed: keys, agentId: row.agent_id },
    });
    await this.#auditAppend({
      accountId,
      actor,
      kind: 'schedule',
      action: 'schedule.update',
      resource: `schedule:${id}`,
      detail: { changed: keys },
    });
    this.#arm();
    return toView(this.#row(accountId, id));
  }

  /** Cancel a schedule: its history and webhook secret go with it; a running run continues. */
  async remove(accountId: string, id: string, opts: { actor?: string } = {}): Promise<void> {
    const actor = opts.actor ?? 'user';
    const row = this.#row(accountId, id);
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('DELETE FROM schedule WHERE id = ? AND account_id = ?')
        .run(id, accountId);
    });
    await this.#secrets.delete(webhookSecretRef(id)).catch(() => false);
    await this.#events.emit({
      name: 'schedule.cancelled',
      actor,
      accountId,
      // An agent's schedule names it, so agent views refetch only their own (FR-206).
      ...(row.agent_id ? { correlation: { agentId: row.agent_id } } : {}),
      payload: { scheduleId: id, origin: row.origin, agentId: row.agent_id },
    });
    await this.#auditAppend({
      accountId,
      actor,
      kind: 'schedule',
      action: 'schedule.delete',
      resource: `schedule:${id}`,
      ...(row.agent_id ? { detail: { agentId: row.agent_id, origin: row.origin } } : {}),
    });
    this.#arm();
  }

  /** The schedule's history, newest first (fires, catch-ups and recorded skips). */
  history(accountId: string, id: string, limit = 100): Promise<ScheduleFireView[]> {
    return Promise.resolve().then(() => {
      this.#row(accountId, id);
      const rows = this.#db.raw
        .prepare(
          `SELECT * FROM schedule_fire WHERE schedule_id = ? AND account_id = ?
           ORDER BY fired_at DESC, id DESC LIMIT ?`,
        )
        .all(id, accountId, Math.max(1, Math.min(limit, 500))) as unknown as FireRow[];
      return rows.map(fireView);
    });
  }

  /** Fire now, outside the rule (a test run); the rule's next fire is unchanged. */
  async runNow(
    accountId: string,
    id: string,
  ): Promise<{ runId: string } | { runId: null; threadId: string }> {
    if (!this.#runs && !this.#agents)
      throw new NovaError('capability_missing', 'Work runs are not available');
    const row = this.#row(accountId, id);
    if (row.agent_id ? !this.#agents : !this.#runs)
      throw new NovaError(
        'capability_missing',
        row.agent_id ? 'agents are not available' : 'Work runs are not available',
      );
    const now = this.#now().toISOString();
    const fireId = uuidv7();
    // Mark it as starting before the row exists, so recovery never fails it in between.
    this.#starting.set(fireId, Promise.resolve());
    try {
      await this.#db.transaction(() => {
        this.#insertFire(
          row,
          fireId,
          { kind: 'fire', due: 0, window: null, detail: null },
          now,
          true,
        );
        this.#db.raw.prepare('UPDATE schedule SET last_run_at = ? WHERE id = ?').run(now, row.id);
      });
    } catch (err) {
      this.#starting.delete(fireId);
      throw err;
    }
    const started = await this.#startRun(row, fireId, 'fire', null, true);
    if (!started) {
      const fire = this.#fire(fireId);
      throw new NovaError('server_error', fire?.detail ?? 'the run could not be started');
    }
    // An agent's fire is a turn on its thread, not a run (M6).
    return row.agent_id ? { runId: null, threadId: started } : { runId: started };
  }

  // ---- the loop -----------------------------------------------------------------------------------

  /** Start the loop: settle what a previous process left, then fire what is due. */
  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    this.#started = true;
    this.#closed = false;
    this.#recovered = false;
    this.#arm(0);
    return Promise.resolve();
  }

  /**
   * Stop the loop and wait (bounded) for work in progress. Runs keep going; their fires settle
   * after the next start.
   */
  async stop(): Promise<void> {
    this.#closed = true;
    this.#started = false;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.idle(),
      new Promise<void>((resolve) => {
        wait = setTimeout(resolve, this.#stopWaitMs);
        wait.unref();
      }),
    ]);
    clearTimeout(wait);
  }

  /** Wait until no tick, run start or settlement is in progress. */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setImmediate(r));
      if (!this.#work.size) return;
      await Promise.allSettled([...this.#work]);
    }
  }

  /** Handle every due schedule once (the loop calls it; tests may too). */
  async tick(): Promise<void> {
    if ((!this.#runs && !this.#agents) || this.#closed) return;
    if (!this.#recovered) await this.#recover();
    const now = this.#now().getTime();
    const due = this.#db.raw
      .prepare(
        `SELECT * FROM schedule WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at`,
      )
      .all(iso(now)) as unknown as ScheduleRow[];
    for (const row of due) {
      if (this.#closed) return;
      try {
        await this.#handleDue(row, now);
      } catch (err) {
        this.#log.warn('schedule fire failed', { err, scheduleId: row.id });
      }
    }
  }

  #arm(delayMs?: number): void {
    if (!this.#started || this.#closed) return;
    if (this.#ticking) {
      this.#again = true;
      return;
    }
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.#runLoop();
    }, delayMs ?? this.#delay());
  }

  #runLoop(): void {
    if (this.#closed) return;
    this.#ticking = true;
    const p = this.tick()
      .catch((err: unknown) => this.#log.warn('scheduler tick failed', { err }))
      .finally(() => {
        this.#ticking = false;
        const again = this.#again;
        this.#again = false;
        this.#arm(again ? 0 : undefined);
      });
    void this.#track(p);
  }

  /** Sleep until the earliest next fire, at most `recheckMs`. */
  #delay(): number {
    if (!this.#runs && !this.#agents) return this.#recheckMs;
    const row = this.#db.raw
      .prepare(
        'SELECT MIN(next_run_at) AS next FROM schedule WHERE enabled = 1 AND next_run_at IS NOT NULL',
      )
      .get() as { next: string | null } | undefined;
    if (!row?.next) return this.#recheckMs;
    const wait = Date.parse(row.next) - this.#now().getTime();
    // Still due after a tick means it could not be handled: retry soon, never spin.
    if (wait <= 0) return Math.min(1000, this.#recheckMs);
    return Math.min(wait, this.#recheckMs);
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#work.add(p);
    void p.finally(() => this.#work.delete(p)).catch(() => undefined);
    return p;
  }

  /** After a restart: claimed fires whose run never started fail; open runs are watched again. */
  async #recover(): Promise<void> {
    this.#recovered = true;
    const open = this.#db.raw
      .prepare(`SELECT * FROM schedule_fire WHERE outcome IS NULL AND kind <> 'skipped'`)
      .all() as unknown as FireRow[];
    for (const f of open) {
      if (this.#starting.has(f.id)) continue;
      if (f.run_id === null)
        await this.#finish(f, 'failed', 'the Hub stopped before the run started', null);
      else this.#watch(f.id);
    }
  }

  async #handleDue(row: ScheduleRow, now: number): Promise<void> {
    let rec: Recurrence;
    try {
      rec = this.#compile(row);
    } catch (err) {
      // A rule that no longer compiles (time zone data changed) stops instead of spinning.
      this.#log.warn('schedule rule no longer valid', { err, scheduleId: row.id });
      await this.#db.transaction(() => {
        this.#db.raw.prepare('UPDATE schedule SET next_run_at = NULL WHERE id = ?').run(row.id);
      });
      return;
    }
    const cursor = Date.parse(row.next_run_at!);
    const next = rec.next(now);
    const busy = this.#hasOpenRun(row.id);
    const plan: PlannedEntry[] = [];
    const due = windowOf(rec, cursor, now, WINDOW_CAP);
    if (due && due.count === 1 && now - due.last <= this.#lateMs) {
      // On time: the normal case, whatever the lookback.
      plan.push(
        busy
          ? {
              kind: 'skipped',
              due: due.last,
              window: due,
              detail: 'the previous run of this schedule was still running',
              reason: 'running',
            }
          : { kind: 'fire', due: due.last, window: null, detail: null },
      );
    } else if (due) {
      const cutoff = now - row.catch_up_lookback_s * 1000;
      const old = windowOf(rec, cursor, Math.min(now, cutoff - 1), WINDOW_CAP);
      const recent = windowOf(rec, Math.max(cursor, cutoff), now, WINDOW_CAP);
      if (old)
        plan.push({
          kind: 'skipped',
          due: old.last,
          window: old,
          detail: 'missed, older than the catch-up lookback',
          reason: 'lookback',
        });
      if (recent) {
        if (row.catch_up_policy === 'skip')
          plan.push({
            kind: 'skipped',
            due: recent.last,
            window: recent,
            detail: 'missed; catch-up is set to skip',
            reason: 'policy',
          });
        else if (busy)
          plan.push({
            kind: 'skipped',
            due: recent.last,
            window: recent,
            detail: 'the previous run of this schedule was still running',
            reason: 'running',
          });
        else plan.push({ kind: 'catch_up', due: recent.last, window: recent, detail: null });
      }
    }
    const nowIso = iso(now);
    const claimed = await this.#db.transaction(() => {
      const fresh = this.#db.raw
        .prepare('SELECT enabled, next_run_at FROM schedule WHERE id = ?')
        .get(row.id) as { enabled: number; next_run_at: string | null } | undefined;
      // Changed since it was read (edited, paused, deleted, or claimed): leave it.
      if (fresh?.enabled !== 1 || fresh.next_run_at !== row.next_run_at) return null;
      const out: (PlannedEntry & { id: string })[] = [];
      for (const e of plan) {
        const id = uuidv7();
        if (this.#insertFire(row, id, e, nowIso, false)) out.push({ ...e, id });
      }
      const fired = out.some((e) => e.kind !== 'skipped');
      this.#db.raw
        .prepare(
          `UPDATE schedule SET next_run_at = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END
           WHERE id = ?`,
        )
        .run(next === null ? null : iso(next), fired ? 1 : 0, nowIso, row.id);
      return out;
    });
    if (!claimed) return;
    for (const e of claimed) {
      if (e.kind === 'skipped') {
        await this.#events.emit({
          name: 'schedule.catchup',
          accountId: row.account_id,
          payload: {
            scheduleId: row.id,
            policy: 'skip',
            reason: e.reason ?? 'policy',
            windowFrom: iso(e.window!.first),
            windowTo: iso(e.window!.last),
            missed: e.window!.count,
          },
        });
        await this.#auditAppend({
          accountId: row.account_id,
          actor: 'system',
          kind: 'schedule',
          action: 'schedule.skip',
          resource: `schedule:${row.id}`,
          result: e.detail,
          detail: { window: windowPayload(e.window), reason: e.reason },
        });
      } else {
        await this.#startRun(row, e.id, e.kind, e.window, false);
      }
    }
  }

  /** Insert a history row; false when this rule time was already claimed. */
  #insertFire(
    row: ScheduleRow,
    id: string,
    e: PlannedEntry,
    firedAt: string,
    manual: boolean,
  ): boolean {
    const res = this.#db.raw
      .prepare(
        `INSERT OR IGNORE INTO schedule_fire (id, schedule_id, account_id, kind, due_at,
           window_first, window_last, window_count, detail, ended_at, fired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.id,
        row.account_id,
        e.kind,
        manual ? null : iso(e.due),
        e.window ? iso(e.window.first) : null,
        e.window ? iso(e.window.last) : null,
        e.window ? e.window.count : null,
        e.detail,
        // A recorded skip is complete at once; a fire ends when its run settles.
        e.kind === 'skipped' ? firedAt : null,
        firedAt,
      );
    return Number(res.changes) > 0;
  }

  /** Start the Work run of a claimed fire; returns its id, or null when it could not start. */
  async #startRun(
    row: ScheduleRow,
    fireId: string,
    kind: 'fire' | 'catch_up',
    window: FireWindow | null,
    manual: boolean,
  ): Promise<string | null> {
    if (row.agent_id !== null) return this.#startAgentTurn(row, fireId, kind, window, manual);
    const runs = this.#runs;
    if (!runs) return null;
    const output = parseJson<ExpectedOutput>(row.expected_output_json);
    const started = runs.createRun({
      accountId: row.account_id,
      objective: objectiveFor(row, kind, window),
      title: kind === 'catch_up' ? `${row.title} (catch-up)` : row.title,
      projectId: row.project_id,
      origin: 'schedule',
      originRef: row.id,
      autonomy: row.autonomy,
      expectedOutput: output,
      // The instructions are the user's own words only when the user wrote the schedule (FR-189).
      authority:
        row.origin === 'user'
          ? { kind: 'user', source: `schedule:${row.id}` }
          : { kind: 'none', origin: 'system' },
      start: true,
    });
    this.#starting.set(fireId, started);
    const work = this.#track(
      (async () => {
        try {
          const { runId, threadId } = await started;
          await this.#db.transaction(() => {
            this.#db.raw
              .prepare('UPDATE schedule_fire SET run_id = ?, thread_id = ? WHERE id = ?')
              .run(runId, threadId, fireId);
          });
          await this.#events.emit({
            name: 'schedule.fired',
            actor: manual ? 'user' : 'system',
            accountId: row.account_id,
            correlation: { runId, threadId },
            payload: {
              scheduleId: row.id,
              runId,
              kind,
              ...(manual ? { manual: true } : {}),
              ...(window ? { window: windowPayload(window) } : {}),
            },
          });
          if (kind === 'catch_up' && window) {
            await this.#events.emit({
              name: 'schedule.catchup',
              accountId: row.account_id,
              correlation: { runId },
              payload: {
                scheduleId: row.id,
                runId,
                policy: 'once',
                windowFrom: iso(window.first),
                windowTo: iso(window.last),
                missed: window.count,
              },
            });
          }
          await this.#auditAppend({
            accountId: row.account_id,
            actor: manual ? 'user' : 'system',
            kind: 'schedule',
            action: manual ? 'schedule.run_now' : 'schedule.fire',
            resource: `schedule:${row.id}`,
            threadId,
            result: runId,
            detail: { kind, ...(window ? { window: windowPayload(window) } : {}) },
          });
          this.#watch(fireId);
          return runId;
        } catch (err) {
          this.#log.warn('scheduled run did not start', { err, scheduleId: row.id });
          const fire = this.#fire(fireId);
          if (fire)
            await this.#finish(fire, 'failed', `the run did not start: ${messageOf(err)}`, null);
          return null;
        } finally {
          this.#starting.delete(fireId);
        }
      })(),
    );
    return work;
  }

  /**
   * M6: start the turn of an agent-targeted fire on the agent's main thread (trigger `schedule`);
   * returns the thread id, or null when it could not start (the fire then fails). The fire
   * settles when the turn ends, like a run's (FR-187).
   */
  async #startAgentTurn(
    row: ScheduleRow,
    fireId: string,
    kind: 'fire' | 'catch_up',
    window: FireWindow | null,
    manual: boolean,
  ): Promise<string | null> {
    const agents = this.#agents;
    const agentId = row.agent_id;
    if (!agents || !agentId) {
      const fire = this.#fire(fireId);
      if (fire) await this.#finish(fire, 'failed', 'agents are not available', null);
      return null;
    }
    const started = agents.fire({
      accountId: row.account_id,
      agentId,
      scheduleId: row.id,
      fireId,
      kind,
      title: kind === 'catch_up' ? `${row.title} (catch-up)` : row.title,
      text: objectiveFor(row, kind, window),
      origin: row.origin,
      wakeReason: row.wake_reason,
      manual,
    });
    this.#starting.set(fireId, started);
    const work = this.#track(
      (async () => {
        try {
          const { threadId, done } = await started;
          await this.#db.transaction(() => {
            this.#db.raw
              .prepare('UPDATE schedule_fire SET thread_id = ? WHERE id = ?')
              .run(threadId, fireId);
          });
          await this.#events.emit({
            name: 'schedule.fired',
            actor: manual ? 'user' : 'system',
            accountId: row.account_id,
            correlation: { threadId, agentId },
            payload: {
              scheduleId: row.id,
              runId: null,
              agentId,
              threadId,
              kind,
              ...(manual ? { manual: true } : {}),
              ...(window ? { window: windowPayload(window) } : {}),
            },
          });
          if (kind === 'catch_up' && window)
            await this.#events.emit({
              name: 'schedule.catchup',
              accountId: row.account_id,
              correlation: { threadId, agentId },
              payload: {
                scheduleId: row.id,
                policy: 'once',
                windowFrom: iso(window.first),
                windowTo: iso(window.last),
                missed: window.count,
              },
            });
          await this.#auditAppend({
            accountId: row.account_id,
            actor: manual ? 'user' : 'system',
            kind: 'schedule',
            action: manual ? 'schedule.run_now' : 'schedule.fire',
            resource: `schedule:${row.id}`,
            threadId,
            result: threadId,
            detail: { kind, agentId, ...(window ? { window: windowPayload(window) } : {}) },
          });
          done.then(
            (finish) => {
              if (!this.#closed) void this.#track(this.#settle(fireId, finish));
            },
            (err: unknown) => {
              if (this.#closed) return;
              const f = this.#fire(fireId);
              if (f) void this.#track(this.#finish(f, 'failed', messageOf(err), null));
            },
          );
          return threadId;
        } catch (err) {
          this.#log.warn('scheduled agent turn did not start', { err, scheduleId: row.id });
          const fire = this.#fire(fireId);
          if (fire)
            await this.#finish(fire, 'failed', `the agent did not start: ${messageOf(err)}`, null);
          return null;
        } finally {
          this.#starting.delete(fireId);
        }
      })(),
    );
    return work;
  }

  /** Wait for a fire's run to end, then settle it (not part of `idle()`: runs can take hours). */
  #watch(fireId: string): void {
    const fire = this.#fire(fireId);
    const runs = this.#runs;
    if (!fire?.run_id || !runs) return;
    runs.whenFinished(fire.account_id, fire.run_id).then(
      (finish) => {
        if (!this.#closed) void this.#track(this.#settle(fireId, finish));
      },
      (err: unknown) => {
        if (this.#closed) return;
        const f = this.#fire(fireId);
        if (f) void this.#track(this.#finish(f, 'failed', messageOf(err), null));
      },
    );
  }

  /** Deliver (unless no news) and decide the outcome of a finished run (FR-187). */
  async #settle(fireId: string, finish: Pick<RunFinish, 'status' | 'summary'>): Promise<void> {
    const fire = this.#fire(fireId);
    if (!fire || fire.outcome !== null) return;
    const row = this.#scheduleRow(fire.schedule_id);
    if (!row) return;
    if (finish.status === 'failed' || finish.status === 'cancelled') {
      await this.#finish(fire, finish.status, finish.summary, null);
      return;
    }
    const output = parseJson<ExpectedOutput>(row.expected_output_json);
    const delivered = await this.#deliverOnce(fire, row, finish.summary);
    // Artifact and file outputs are the runs area's to verify; a message output is verified here.
    const otherMissing = finish.status === 'output_missing' && output?.kind !== 'message';
    let outcome: ScheduleOutcome;
    let detail: string | null;
    if (otherMissing) {
      outcome = 'output_missing';
      detail = `the declared ${output?.kind ?? 'output'} was not verified`;
    } else if (delivered.noNews) {
      outcome = 'no_news';
      detail = 'no news';
    } else {
      const check = deliveryCheck(row, delivered.results);
      outcome = check.ok ? 'done' : 'output_missing';
      detail = check.ok ? null : check.problem;
    }
    await this.#finish(fire, outcome, detail, delivered.results);
  }

  /** Deliver a fire's result once; later callers share the first delivery. */
  #deliverOnce(fire: FireRow, row: ScheduleRow, finalReply: string | null): Promise<Delivered> {
    const known = this.#deliveries.get(fire.id);
    if (known) return known;
    const p = (async (): Promise<Delivered> => {
      const current = this.#fire(fire.id) ?? fire;
      if (current.receipts_json !== null)
        return {
          noNews: current.notify === 0,
          results: parseJson<DeliveryResult[]>(current.receipts_json) ?? [],
        };
      if (current.notify === 0) {
        await this.#saveReceipts(fire.id, []);
        return { noNews: true, results: [] };
      }
      const targets = parseJson<DeliveryTarget[]>(row.delivery_targets_json) ?? [];
      const message =
        current.report_message?.trim() || finalReply?.trim() || `${row.title} finished.`;
      const results = await deliverAll(
        this.#channels,
        {
          accountId: row.account_id,
          scheduleId: row.id,
          title: row.title,
          runId: current.run_id ?? '',
          threadId: current.thread_id,
          fireId: fire.id,
          message,
          firedAt: current.fired_at,
        },
        targets,
      );
      await this.#saveReceipts(fire.id, results);
      for (const r of results.filter((x) => x.kind === 'webhook')) {
        await this.#auditAppend({
          accountId: row.account_id,
          actor: 'system',
          kind: 'network',
          action: 'schedule.webhook',
          resource: hostOf(r.ref),
          threadId: current.thread_id,
          decision: r.receipt ? 'delivered' : 'failed',
          result: r.receipt ?? r.error ?? null,
          detail: { scheduleId: row.id, runId: current.run_id },
        });
      }
      return { noNews: false, results };
    })();
    this.#deliveries.set(fire.id, p);
    void p.finally(() => this.#deliveries.delete(fire.id)).catch(() => undefined);
    return p;
  }

  async #saveReceipts(fireId: string, results: DeliveryResult[]): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE schedule_fire SET receipts_json = ? WHERE id = ?')
        .run(JSON.stringify(results), fireId);
    });
  }

  async #finish(
    fire: FireRow,
    outcome: ScheduleOutcome,
    detail: string | null,
    results: DeliveryResult[] | null,
  ): Promise<void> {
    const endedAt = this.#now().toISOString();
    const changed = await this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare(
          `UPDATE schedule_fire SET outcome = ?, detail = ?, ended_at = ?,
             receipts_json = COALESCE(?, receipts_json)
           WHERE id = ? AND outcome IS NULL`,
        )
        .run(outcome, detail, endedAt, results ? JSON.stringify(results) : null, fire.id);
      if (Number(res.changes) === 0) return false;
      this.#db.raw
        .prepare('UPDATE schedule SET last_outcome = ? WHERE id = ?')
        .run(outcome, fire.schedule_id);
      return true;
    });
    if (!changed) return;
    await this.#events.emit({
      name: 'schedule.completed',
      accountId: fire.account_id,
      ...(fire.run_id ? { correlation: { runId: fire.run_id } } : {}),
      payload: {
        scheduleId: fire.schedule_id,
        runId: fire.run_id,
        outcome,
        ...(detail ? { detail } : {}),
      },
    });
    if (outcome === 'output_missing' && fire.run_id) {
      // The user hears about a job that did not deliver (the run is linked for its trace).
      const row = this.#scheduleRow(fire.schedule_id);
      await this.#notify({
        accountId: fire.account_id,
        kind: 'error',
        title: `${row?.title ?? 'A scheduled job'}: result not delivered`,
        body: detail ?? 'The declared output could not be verified.',
        href: `/work/${encodeURIComponent(fire.run_id)}`,
        dedupeKey: `schedule-missing:${fire.id}`,
      });
    }
  }

  async #notify(n: Parameters<Notifier['notify']>[0]): Promise<void> {
    const notifier = this.#notifier;
    if (!notifier) return;
    try {
      if ('create' in notifier) await notifier.create(n);
      else await notifier.notify(n);
    } catch (err) {
      this.#log.warn('schedule notification failed', { err });
    }
  }

  // ---- what runs use ------------------------------------------------------------------------------

  /** `schedule.report`: record whether the run's result should be delivered. */
  async report(accountId: string, threadId: string, args: ReportArgs): Promise<ToolResult> {
    let fire = this.#openFireByThread(accountId, threadId);
    if (!fire && this.#starting.size) {
      // The run's first turn can call the tool before createRun has returned its thread.
      await Promise.allSettled([...this.#starting.values()]);
      fire = this.#openFireByThread(accountId, threadId);
    }
    if (!fire)
      return fail('not_scheduled', 'schedule.report works only in a run started by a schedule');
    if (fire.receipts_json !== null)
      return fail('already_delivered', 'this run has already been delivered');
    const fireId = fire.id;
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE schedule_fire SET notify = ?, report_message = ? WHERE id = ?')
        .run(args.notify ? 1 : 0, args.message?.slice(0, MAX_REPORT_MESSAGE) ?? null, fireId);
    });
    return ok(
      args.notify
        ? 'Recorded: the result will be delivered when the run ends.'
        : 'Recorded: nothing will be delivered (no news).',
      { notify: args.notify },
    );
  }

  /**
   * For the runs area: verify a `message` output of a scheduled run by delivering it now (once;
   * the schedule's own settlement reuses the same delivery). No news counts as verified.
   */
  async verifyMessageOutput(
    accountId: string,
    runId: string,
    finalReply: string | null,
  ): Promise<{ verified: boolean; evidence: string }> {
    const fire = this.#db.raw
      .prepare('SELECT * FROM schedule_fire WHERE account_id = ? AND run_id = ?')
      .get(accountId, runId) as FireRow | undefined;
    const row = fire ? this.#scheduleRow(fire.schedule_id) : null;
    if (!fire || !row) return { verified: false, evidence: 'not a scheduled run' };
    const delivered = await this.#deliverOnce(fire, row, finalReply);
    if (delivered.noNews) return { verified: true, evidence: 'no news' };
    const check = deliveryCheck(row, delivered.results);
    return check.ok
      ? {
          verified: true,
          evidence: delivered.results.map((r) => `${r.kind}: ${r.receipt ?? ''}`).join(', '),
        }
      : { verified: false, evidence: check.problem };
  }

  // ---- helpers ----------------------------------------------------------------------------------

  #validate(
    accountId: string,
    input: ScheduleInput,
    createdAt: string,
    now: number,
    ruleChanged: boolean,
  ): { rec: Recurrence; next: number | null } {
    const rec = compileRecurrence({
      when: input.when,
      timezone: input.timezone,
      startsAt: normalizeChecked('startsAt', input.startsAt),
      endsAt: normalizeChecked('endsAt', input.endsAt),
      createdAt,
    });
    const next = ruleChanged ? assertFires(rec, input.when, now) : rec.next(now);
    input.deliveryTargets.forEach((t, i) => {
      if (!this.#channels.has(t.kind))
        throw fieldError(
          `deliveryTargets.${i}.kind`,
          UNAVAILABLE[t.kind] ?? `${t.kind} delivery is not available`,
        );
      if (t.kind === 'webhook') {
        const problem = webhookUrlProblem(t.ref);
        if (problem) throw fieldError(`deliveryTargets.${i}.ref`, problem);
      }
    });
    const output = input.output;
    if (output?.kind === 'message') {
      if (!input.deliveryTargets.length)
        throw fieldError('output', 'a message output needs a delivery target');
      if (
        output.ref &&
        !input.deliveryTargets.some((t) => t.kind === output.ref || t.ref === output.ref)
      )
        throw fieldError('output.ref', `no delivery target matches "${output.ref}"`);
    }
    if (input.projectId) {
      const p = this.#db.raw
        .prepare(
          'SELECT 1 AS ok FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
        )
        .get(input.projectId, accountId);
      if (!p) throw fieldError('projectId', 'no such project');
    }
    return { rec, next };
  }

  #compile(row: ScheduleRow): Recurrence {
    return compileRecurrence({
      when: whenOf(row),
      timezone: row.timezone,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdAt: row.created_at,
    });
  }

  #row(accountId: string, id: string): ScheduleRow {
    const row = this.#db.raw
      .prepare('SELECT * FROM schedule WHERE id = ? AND account_id = ?')
      .get(id, accountId) as ScheduleRow | undefined;
    if (!row) throw new NovaError('not_found', 'schedule not found');
    return row;
  }

  #scheduleRow(id: string): ScheduleRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM schedule WHERE id = ?').get(id) as
        ScheduleRow | undefined) ?? null
    );
  }

  #fire(id: string): FireRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM schedule_fire WHERE id = ?').get(id) as
        FireRow | undefined) ?? null
    );
  }

  #openFireByThread(accountId: string, threadId: string): FireRow | null {
    return (
      (this.#db.raw
        .prepare(
          `SELECT * FROM schedule_fire WHERE account_id = ? AND thread_id = ? AND outcome IS NULL
           AND kind <> 'skipped' ORDER BY fired_at DESC LIMIT 1`,
        )
        .get(accountId, threadId) as FireRow | undefined) ?? null
    );
  }

  #hasOpenFire(accountId: string): boolean {
    return (
      this.#db.raw
        .prepare(
          `SELECT 1 AS ok FROM schedule_fire WHERE account_id = ? AND outcome IS NULL
           AND kind <> 'skipped' LIMIT 1`,
        )
        .get(accountId) !== undefined
    );
  }

  #hasOpenRun(scheduleId: string): boolean {
    return (
      this.#db.raw
        .prepare(
          `SELECT 1 AS ok FROM schedule_fire WHERE schedule_id = ? AND outcome IS NULL
           AND kind <> 'skipped' LIMIT 1`,
        )
        .get(scheduleId) !== undefined
    );
  }

  async #auditAppend(rec: Omit<AuditRecord, 'kind'> & { kind: string }): Promise<void> {
    try {
      await this.#audit?.append(rec);
    } catch (err) {
      this.#log.warn('schedule audit failed', { err, action: rec.action });
    }
  }
}

function parseNext(v: string | null): number | null {
  return v === null ? null : Date.parse(v);
}

function normalizeChecked(field: string, v: string | undefined | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw fieldError(field, `"${v}" is not a date-time`);
  return new Date(t).toISOString();
}

function hostOf(ref: string | undefined): string | null {
  try {
    return ref ? new URL(ref).host : null;
  } catch {
    return null;
  }
}

/**
 * Whether delivery verified the message: every target (or the one the output names) returned a
 * receipt. A schedule with targets always declares a message, even without `output`.
 */
function deliveryCheck(
  row: ScheduleRow,
  results: DeliveryResult[],
): { ok: true } | { ok: false; problem: string } {
  const output = parseJson<ExpectedOutput>(row.expected_output_json);
  const needed = results.length > 0 || output?.kind === 'message';
  if (!needed) return { ok: true };
  const ref = output?.kind === 'message' ? output.ref : undefined;
  const required = ref ? results.filter((r) => r.kind === ref || r.ref === ref) : results;
  if (!required.length) return { ok: false, problem: 'no delivery target to verify the message' };
  const missing = required.find((r) => r.receipt === null);
  if (!missing) return { ok: true };
  return {
    ok: false,
    problem: `${missing.kind} delivery returned no receipt${missing.error ? `: ${missing.error}` : ''}`,
  };
}

/** The run's objective: the user's instructions, the notify condition and a catch-up window. */
function objectiveFor(row: ScheduleRow, kind: 'fire' | 'catch_up', window: FireWindow | null) {
  const parts = [row.instructions.trim()];
  if (row.notify_condition)
    parts.push(
      `Notify only if: ${row.notify_condition}\n` +
        'When you have checked, call schedule.report: notify false when this condition is not ' +
        'met (nothing is delivered), or notify true with the message to deliver.',
    );
  if (kind === 'catch_up' && window) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: row.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const n = window.count;
    parts.push(
      `Catch-up: Nova was not running for ${n} scheduled ${n === 1 ? 'run' : 'runs'}, from ` +
        `${fmt.format(window.first)} to ${fmt.format(window.last)} (${row.timezone}). ` +
        'Cover that whole window in this one run.',
    );
  }
  return parts.join('\n\n');
}
