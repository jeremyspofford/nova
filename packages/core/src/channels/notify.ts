// Notification routing (FR-060): per category, whether a notification shows in-app, is raised
// on the OS, and which channel bindings receive it; quiet hours are a daily window in a time zone
// that defers non-urgent deliveries (OS and channels) until it ends. Approvals pass quiet hours
// by default; any rule can opt in. The in-app record is the notification service's (ops area);
// this router decides the rest and delivers channel copies, keeping deferred ones in
// `notification_delivery` so a restart does not lose them. `quietHours(accountId)` is what the
// agents area and the scheduler read (proactive research, goal continuations, self-set wakes).
import {
  NOTIFICATION_KINDS,
  NovaError,
  uuidv7,
  type NotificationKind,
  type NotificationRuleRequest,
  type NotificationRuleView,
  type QuietHoursRequest,
  type QuietHoursView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import { DAY, MINUTE, isTimeZone, naiveOf, resolveLocal, weekdayOf } from '../scheduler/zone.ts';
import type { AuditSink } from '../tools/types.ts';
import type { ChannelReceipt } from './types.ts';

export interface QuietHoursState {
  enabled: boolean;
  active: boolean;
  /** When the current window ends; null when not active. */
  until: string | null;
}

export interface RouteDecision {
  inapp: boolean;
  os: boolean;
  channels: string[];
  /** Deliveries other than in-app wait until then (quiet hours); null: now. */
  deferUntil: string | null;
}

export interface NotificationSender {
  sendTo(accountId: string, bindingId: string, text: string): Promise<ChannelReceipt>;
}

export interface NotificationRouterOptions {
  db: NovaDatabase;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

interface RuleRow {
  account_id: string;
  category: NotificationKind;
  inapp: number;
  os: number;
  channels_json: string;
  bypass_quiet: number;
  updated_at: string;
}

interface QuietRow {
  account_id: string;
  enabled: number;
  start_time: string;
  end_time: string;
  timezone: string;
  days_json: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  account_id: string;
  binding_id: string;
  title: string;
  body: string | null;
  due_at: string;
  status: string;
}

const DEFAULT_QUIET = {
  start: '22:00',
  end: '07:00',
  timezone: 'UTC',
  days: [0, 1, 2, 3, 4, 5, 6],
};
/** Delivered during quiet hours unless the user's rule says otherwise. */
const URGENT: ReadonlySet<NotificationKind> = new Set(['approval']);
const CHANNEL_KINDS = ['slack', 'teams', 'webhook'];

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function parseIds(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Whether a daily window [start, end) in `tz` covers `at`, and when it ends. A window whose end is
 * not after its start crosses midnight; `days` are the weekdays (0 = Sunday) a window starts on.
 */
export function quietWindow(
  q: { start: string; end: string; timezone: string; days: number[] },
  at: number,
): { active: boolean; from: number | null; until: number | null } {
  const naive = naiveOf(q.timezone, at);
  const day = Math.floor(naive / DAY);
  const minute = Math.floor((naive - day * DAY) / MINUTE);
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  const crosses = end <= start;
  const days = new Set(q.days);
  if (days.has(weekdayOf(day))) {
    if (crosses ? minute >= start : minute >= start && minute < end)
      return {
        active: true,
        from: resolveLocal(q.timezone, day * DAY + start * MINUTE),
        until: resolveLocal(q.timezone, (crosses ? day + 1 : day) * DAY + end * MINUTE),
      };
  }
  if (crosses && days.has(weekdayOf(day - 1)) && minute < end)
    return {
      active: true,
      from: resolveLocal(q.timezone, (day - 1) * DAY + start * MINUTE),
      until: resolveLocal(q.timezone, day * DAY + end * MINUTE),
    };
  return { active: false, from: null, until: null };
}

export class NotificationRouter {
  readonly #o: NotificationRouterOptions;
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  #sender: NotificationSender | null = null;
  #timer: unknown = null;
  #running = false;
  #flushing: Promise<void> | null = null;

  constructor(opts: NotificationRouterOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
  }

  useSender(sender: NotificationSender): void {
    this.#sender = sender;
  }

  // ---- rules --------------------------------------------------------------------------------

  #ruleRow(accountId: string, category: NotificationKind): RuleRow | null {
    return (
      (this.#db.raw
        .prepare('SELECT * FROM notification_rule WHERE account_id = ? AND category = ?')
        .get(accountId, category) as RuleRow | undefined) ?? null
    );
  }

  rule(accountId: string, category: NotificationKind): NotificationRuleView {
    const r = this.#ruleRow(accountId, category);
    if (!r)
      return {
        category,
        inapp: true,
        os: true,
        channels: [],
        bypassQuietHours: URGENT.has(category),
        isDefault: true,
        updatedAt: null,
      };
    return {
      category,
      inapp: r.inapp === 1,
      os: r.os === 1,
      channels: parseIds(r.channels_json),
      bypassQuietHours: r.bypass_quiet === 1,
      isDefault: false,
      updatedAt: r.updated_at,
    };
  }

  rules(accountId: string): NotificationRuleView[] {
    return NOTIFICATION_KINDS.map((k) => this.rule(accountId, k));
  }

  async setRule(
    accountId: string,
    category: NotificationKind,
    req: NotificationRuleRequest,
  ): Promise<NotificationRuleView> {
    const channels = [...new Set(req.channels)];
    for (const [i, id] of channels.entries()) {
      const b = this.#db.raw
        .prepare('SELECT kind FROM channel_binding WHERE id = ? AND account_id = ?')
        .get(id, accountId) as { kind: string } | undefined;
      if (!b || !CHANNEL_KINDS.includes(b.kind))
        throw new NovaError('validation', 'notifications go to Slack, Teams or webhook channels', {
          details: { field: `channels.${i}` },
        });
    }
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO notification_rule (account_id, category, inapp, os, channels_json, bypass_quiet,
             updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, category) DO UPDATE SET inapp = excluded.inapp, os = excluded.os,
             channels_json = excluded.channels_json, bypass_quiet = excluded.bypass_quiet,
             updated_at = excluded.updated_at`,
        )
        .run(
          accountId,
          category,
          req.inapp ? 1 : 0,
          req.os ? 1 : 0,
          JSON.stringify(channels),
          req.bypassQuietHours ? 1 : 0,
          now,
        );
    });
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'notification.rule.set',
      resource: `notification_rule:${category}`,
      detail: {
        inapp: req.inapp,
        os: req.os,
        channels: channels.length,
        bypass: req.bypassQuietHours,
      },
    });
    return this.rule(accountId, category);
  }

  async resetRule(accountId: string, category: NotificationKind): Promise<NotificationRuleView> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('DELETE FROM notification_rule WHERE account_id = ? AND category = ?')
        .run(accountId, category);
    });
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'notification.rule.reset',
      resource: `notification_rule:${category}`,
    });
    return this.rule(accountId, category);
  }

  // ---- quiet hours --------------------------------------------------------------------------

  #quiet(accountId: string): {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
    days: number[];
    updatedAt: string | null;
  } {
    const r = this.#db.raw
      .prepare('SELECT * FROM quiet_hours WHERE account_id = ?')
      .get(accountId) as QuietRow | undefined;
    if (!r) return { enabled: false, ...DEFAULT_QUIET, updatedAt: null };
    let days = DEFAULT_QUIET.days;
    try {
      const v = JSON.parse(r.days_json) as unknown;
      if (Array.isArray(v))
        days = v.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6);
    } catch {
      // the default days
    }
    return {
      enabled: r.enabled === 1,
      start: r.start_time,
      end: r.end_time,
      timezone: r.timezone,
      days,
      updatedAt: r.updated_at,
    };
  }

  quietHoursView(accountId: string, at: Date = this.#now()): QuietHoursView {
    const q = this.#quiet(accountId);
    const state = this.quietHours(accountId, at);
    return {
      enabled: q.enabled,
      start: q.start,
      end: q.end,
      timezone: q.timezone,
      days: q.days,
      active: state.active,
      until: state.until,
    };
  }

  /** Whether quiet hours are in force (for the agents area and the scheduler, FR-060). */
  quietHours(accountId: string, at: Date = this.#now()): QuietHoursState {
    const q = this.#quiet(accountId);
    if (!q.enabled || !isTimeZone(q.timezone))
      return { enabled: q.enabled, active: false, until: null };
    const w = quietWindow(q, at.getTime());
    return {
      enabled: true,
      active: w.active,
      until: w.until === null ? null : new Date(w.until).toISOString(),
    };
  }

  /**
   * The quiet window containing `at`, or null outside quiet hours: the agents area's
   * `QuietHours` (proactive research, goal continuations and self-set wakes respect it).
   */
  quietWindowAt(accountId: string, at: Date): Promise<{ start: string; end: string } | null> {
    const q = this.#quiet(accountId);
    if (!q.enabled || !isTimeZone(q.timezone)) return Promise.resolve(null);
    const w = quietWindow(q, at.getTime());
    if (!w.active || w.from === null || w.until === null) return Promise.resolve(null);
    return Promise.resolve({
      start: new Date(w.from).toISOString(),
      end: new Date(w.until).toISOString(),
    });
  }

  async setQuietHours(accountId: string, req: QuietHoursRequest): Promise<QuietHoursView> {
    if (!isTimeZone(req.timezone))
      throw new NovaError('validation', `unknown time zone ${req.timezone}`, {
        details: { field: 'timezone' },
      });
    const days = [...new Set(req.days ?? DEFAULT_QUIET.days)].sort((a, b) => a - b);
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO quiet_hours (account_id, enabled, start_time, end_time, timezone, days_json,
             updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET enabled = excluded.enabled,
             start_time = excluded.start_time, end_time = excluded.end_time,
             timezone = excluded.timezone, days_json = excluded.days_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          accountId,
          req.enabled ? 1 : 0,
          req.start,
          req.end,
          req.timezone,
          JSON.stringify(days),
          now,
        );
    });
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'quiet_hours.set',
      resource: 'quiet_hours',
      detail: { enabled: req.enabled, start: req.start, end: req.end, timezone: req.timezone },
    });
    // Deferred deliveries follow the new window.
    this.#schedule();
    return this.quietHoursView(accountId);
  }

  // ---- routing ------------------------------------------------------------------------------

  route(accountId: string, kind: NotificationKind, at: Date = this.#now()): RouteDecision {
    const rule = this.rule(accountId, kind);
    const quiet = rule.bypassQuietHours ? null : this.quietHours(accountId, at);
    return {
      inapp: rule.inapp,
      os: rule.os && !quiet?.active,
      channels: rule.channels,
      deferUntil: quiet?.active ? quiet.until : null,
    };
  }

  /** For the ops area: record the in-app notification at all (the category's rule). */
  inappEnabled(accountId: string, kind: NotificationKind): boolean {
    return this.rule(accountId, kind).inapp;
  }

  /** For the ops area: raise it on the OS now (rule and quiet hours). */
  osEnabled(accountId: string, kind: NotificationKind): boolean {
    return this.route(accountId, kind).os;
  }

  /**
   * A notification was recorded (`notification.created`): queue its channel copies, now or at the
   * end of quiet hours.
   */
  async onNotification(n: {
    accountId: string;
    notificationId: string;
    kind: NotificationKind;
    title: string;
    body?: string | null;
  }): Promise<number> {
    const decision = this.route(n.accountId, n.kind);
    if (!decision.channels.length) return 0;
    const body =
      n.body ??
      (
        this.#db.raw.prepare('SELECT body FROM notification WHERE id = ?').get(n.notificationId) as
          { body: string | null } | undefined
      )?.body ??
      null;
    const now = this.#now().toISOString();
    const due = decision.deferUntil ?? now;
    await this.#db.transaction(() => {
      for (const bindingId of decision.channels)
        this.#db.raw
          .prepare(
            `INSERT INTO notification_delivery (id, account_id, notification_id, binding_id, category,
               title, body, due_at, status, receipt, error, created_at, sent_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL
             WHERE EXISTS (SELECT 1 FROM channel_binding WHERE id = ? AND account_id = ?)`,
          )
          .run(
            uuidv7(),
            n.accountId,
            n.notificationId,
            bindingId,
            n.kind,
            n.title,
            body,
            due,
            now,
            bindingId,
            n.accountId,
          );
    });
    if (!decision.deferUntil) await this.flush();
    else this.#schedule();
    return decision.channels.length;
  }

  /** Deliver every channel copy that is due. */
  async flush(): Promise<void> {
    // A flush already running may have read the due rows before now: wait, then read again.
    while (this.#flushing) await this.#flushing;
    this.#flushing = (async () => {
      const rows = this.#db.raw
        .prepare(
          `SELECT * FROM notification_delivery WHERE status = 'pending' AND due_at <= ?
           ORDER BY due_at, created_at LIMIT 200`,
        )
        .all(this.#now().toISOString()) as unknown as DeliveryRow[];
      for (const r of rows) {
        let status = 'sent';
        let receipt: string | null = null;
        let error: string | null = null;
        if (!this.#sender) {
          status = 'failed';
          error = 'channels are not available';
        } else {
          try {
            const res = await this.#sender.sendTo(
              r.account_id,
              r.binding_id,
              r.body ? `${r.title}\n${r.body}` : r.title,
            );
            receipt = res.id;
          } catch (err) {
            status = 'failed';
            error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          }
        }
        await this.#db.transaction(() => {
          this.#db.raw
            .prepare(
              'UPDATE notification_delivery SET status = ?, receipt = ?, error = ?, sent_at = ? WHERE id = ?',
            )
            .run(status, receipt, error, this.#now().toISOString(), r.id);
        });
      }
    })().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  /** Deliveries of a notification (tests, diagnostics). */
  deliveries(
    accountId: string,
  ): { bindingId: string; status: string; dueAt: string; receipt: string | null }[] {
    const rows = this.#db.raw
      .prepare(
        'SELECT binding_id, status, due_at, receipt FROM notification_delivery WHERE account_id = ? ORDER BY created_at',
      )
      .all(accountId) as {
      binding_id: string;
      status: string;
      due_at: string;
      receipt: string | null;
    }[];
    return rows.map((r) => ({
      bindingId: r.binding_id,
      status: r.status,
      dueAt: r.due_at,
      receipt: r.receipt,
    }));
  }

  start(): void {
    this.#running = true;
    this.#schedule();
  }

  /** Sleep until the next deferred delivery is due. */
  #schedule(): void {
    if (!this.#running || !this.#o.timers) return;
    const timers = this.#o.timers;
    if (this.#timer !== null) timers.clearTimeout(this.#timer);
    this.#timer = null;
    const next = this.#db.raw
      .prepare("SELECT min(due_at) AS due FROM notification_delivery WHERE status = 'pending'")
      .get() as { due: string | null };
    if (!next.due) return;
    const ms = Math.max(0, Math.min(Date.parse(next.due) - this.#now().getTime(), 6 * 3_600_000));
    this.#timer = timers.setTimeout(() => {
      this.#timer = null;
      void this.flush()
        .catch((err: unknown) => this.#o.log?.warn('notification flush failed', { err }))
        .finally(() => this.#schedule());
    }, ms);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) this.#o.timers?.clearTimeout(this.#timer);
    this.#timer = null;
    await this.#flushing;
  }
}
