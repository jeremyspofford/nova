// Spend caps per provider (FR-116, docs/14 §6) and the limits providers report (FR-115). A cap is
// per account and provider kind, over a UTC day or month: the warning fires once a period when
// spend reaches its threshold (80% by default), and at the cap model calls to that provider stop
// before they are made (`over_budget`), unless the owner turned the hard stop off. Spend is the
// sum of `usage_event.cost_usd` in the period, plus what "clear usage data" carried over, so
// clearing the insights never resets a cap. A call in flight reserves its likely cost (the
// provider's recent average, at least 1% of the cap) until it ends, and a hard stop counts the
// reservations as spent: concurrent calls and sub-agents cannot all pass a cap that one of them
// would reach (the overshoot is at most one call, as for calls made one after another). The router wrapper checks every target before each
// model call and records the limits a provider reports (out of credit, rate limited) on its
// provider account (`provider_account.entitlements`).
import {
  NovaError,
  uuidv7,
  type ProviderLimitView,
  type ProviderReportedLimit,
  type SpendCapRequest,
  type SpendCapView,
  type SpendPeriod,
} from '@nova/shared';
import type { AgentErrorShape } from '@nova/providers';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { isLocalProvider } from '../registry.ts';
import type { ModelRouter, RouteTarget, RoutedEvent } from '../routing/types.ts';
import type { AuditSink, Notifier } from '../tools/types.ts';

interface CapRow {
  account_id: string;
  provider: string;
  limit_usd: number;
  period: SpendPeriod;
  warn_at: number;
  hard_stop: number;
  carried_usd: number;
  carried_period_start: string | null;
  updated_at: string;
}

export interface SpendCapsOptions {
  db: NovaDatabase;
  events?: EventSink;
  notifier?: Notifier;
  audit?: AuditSink;
  now?: () => Date;
  log?: Logger;
}

/** A call's place under a cap, held while it runs; `release` when it ends (idempotent). */
export interface SpendReservation {
  allowed: boolean;
  cap: SpendCapView | null;
  release: () => void;
}

export interface SpendVerdict {
  allowed: boolean;
  cap: SpendCapView | null;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const money = (v: number) => `$${v.toFixed(2)}`;

/** The period that contains `now`: its start and when it resets (UTC). */
export function spendPeriod(period: SpendPeriod, now: Date): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === 'day') {
    const start = new Date(Date.UTC(y, m, now.getUTCDate()));
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

export class SpendCaps {
  readonly #db: NovaDatabase;
  #events: EventSink | null;
  #notifier: Notifier | null;
  #audit: AuditSink | null;
  readonly #now: () => Date;
  readonly #log: Logger | null;
  /** provider_account id -> account id (rows never change owner). */
  readonly #owners = new Map<string, string | null>();
  /** In-flight reservations per `account\nprovider`, in US dollars. */
  readonly #reserved = new Map<string, number>();

  constructor(opts: SpendCapsOptions) {
    this.#db = opts.db;
    this.#events = opts.events ?? null;
    this.#notifier = opts.notifier ?? null;
    this.#audit = opts.audit ?? null;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? null;
  }

  /** Late-bound: the ops area's notifier, audit and the event store. */
  useNotifier(n: Notifier): void {
    this.#notifier = n;
  }

  useAudit(a: AuditSink): void {
    this.#audit = a;
  }

  useEvents(e: EventSink): void {
    this.#events = e;
  }

  #row(accountId: string, provider: string): CapRow | undefined {
    return this.#db.raw
      .prepare('SELECT * FROM spend_cap WHERE account_id = ? AND provider = ?')
      .get(accountId, provider) as CapRow | undefined;
  }

  /** Spend of a provider in the period starting at `start` (with what a clear carried over). */
  spent(accountId: string, provider: string, start: string, row?: CapRow): number {
    const r = this.#db.raw
      .prepare(
        `SELECT coalesce(sum(cost_usd), 0) AS c FROM usage_event
         WHERE account_id = ? AND created_at >= ? AND provider = ?`,
      )
      .get(accountId, start, provider) as { c: number };
    const carried = row && row.carried_period_start === start ? row.carried_usd : 0;
    return round(Number(r.c) + carried);
  }

  #view(row: CapRow): SpendCapView {
    const { start, end } = spendPeriod(row.period, this.#now());
    const periodStart = start.toISOString();
    const spentUsd = this.spent(row.account_id, row.provider, periodStart, row);
    const fraction = row.limit_usd > 0 ? spentUsd / row.limit_usd : 0;
    return {
      provider: row.provider,
      limitUsd: row.limit_usd,
      period: row.period,
      warnAt: row.warn_at,
      hardStop: !!row.hard_stop,
      periodStart,
      resetsAt: end.toISOString(),
      spentUsd,
      fraction: round(fraction),
      state: fraction >= 1 ? 'reached' : fraction >= row.warn_at ? 'warning' : 'ok',
      updatedAt: row.updated_at,
    };
  }

  list(accountId: string): SpendCapView[] {
    return (
      this.#db.raw
        .prepare('SELECT * FROM spend_cap WHERE account_id = ? ORDER BY provider')
        .all(accountId) as unknown as CapRow[]
    ).map((r) => this.#view(r));
  }

  get(accountId: string, provider: string): SpendCapView | null {
    const row = this.#row(accountId, provider);
    return row ? this.#view(row) : null;
  }

  async set(accountId: string, provider: string, req: SpendCapRequest): Promise<SpendCapView> {
    const now = this.#now().toISOString();
    const before = this.get(accountId, provider);
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare(
          `INSERT INTO spend_cap (account_id, provider, limit_usd, period, warn_at, hard_stop,
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, provider) DO UPDATE SET limit_usd = excluded.limit_usd,
             period = excluded.period, warn_at = excluded.warn_at, hard_stop = excluded.hard_stop,
             updated_at = excluded.updated_at`,
        )
        .run(
          accountId,
          provider,
          req.limitUsd,
          req.period,
          req.warnAt,
          req.hardStop ? 1 : 0,
          now,
          now,
        ),
    );
    await this.#audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'spend.cap.set',
      resource: provider,
      result: 'ok',
      detail: {
        before: before
          ? {
              limitUsd: before.limitUsd,
              period: before.period,
              warnAt: before.warnAt,
              hardStop: before.hardStop,
            }
          : null,
        after: {
          limitUsd: req.limitUsd,
          period: req.period,
          warnAt: req.warnAt,
          hardStop: req.hardStop,
        },
      },
    });
    const view = this.get(accountId, provider)!;
    // A cap set below what was already spent warns at once.
    await this.#alerts(accountId, view);
    return view;
  }

  async remove(accountId: string, provider: string): Promise<boolean> {
    const changes = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare('DELETE FROM spend_cap WHERE account_id = ? AND provider = ?')
          .run(accountId, provider).changes,
    );
    if (!Number(changes)) return false;
    await this.#audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'spend.cap.remove',
      resource: provider,
      result: 'ok',
    });
    return true;
  }

  /** The account a provider account belongs to. */
  #ownerOf(providerAccountId: string): string | null {
    if (!this.#owners.has(providerAccountId)) {
      const r = this.#db.raw
        .prepare('SELECT account_id FROM provider_account WHERE id = ?')
        .get(providerAccountId) as { account_id: string } | undefined;
      this.#owners.set(providerAccountId, r?.account_id ?? null);
    }
    return this.#owners.get(providerAccountId) ?? null;
  }

  /** Whether a call to this provider may go now; fires the period's warning when due. */
  async check(accountId: string, provider: string): Promise<SpendVerdict> {
    const cap = this.get(accountId, provider);
    if (!cap) return { allowed: true, cap: null };
    await this.#alerts(accountId, cap);
    const reserved = this.#reserved.get(`${accountId}\n${provider}`) ?? 0;
    return { allowed: !(cap.hardStop && cap.spentUsd + reserved >= cap.limitUsd), cap };
  }

  /** The verdict for a route target (compute nodes have no provider account: no cap). */
  async checkTarget(t: RouteTarget): Promise<SpendVerdict> {
    const accountId = t.providerAccountId ? this.#ownerOf(t.providerAccountId) : null;
    if (!accountId) return { allowed: true, cap: null };
    return this.check(accountId, t.providerKind);
  }

  /** What a call to this provider is likely to cost: its recent average, at least 1% of the cap. */
  #estimate(accountId: string, provider: string, cap: SpendCapView): number {
    const r = this.#db.raw
      .prepare(
        `SELECT avg(c) AS a FROM (SELECT cost_usd AS c FROM usage_event
           WHERE account_id = ? AND provider = ? AND cost_usd > 0
           ORDER BY created_at DESC LIMIT 20)`,
      )
      .get(accountId, provider) as { a: number | null };
    return Math.max(Number(r.a ?? 0), cap.limitUsd * 0.01);
  }

  /**
   * Check a call and hold its likely cost until it ends: while held, it counts against a hard stop
   * for every other call to the provider.
   */
  async reserve(accountId: string, provider: string): Promise<SpendReservation> {
    const v = await this.check(accountId, provider);
    if (!v.cap || !v.allowed) return { ...v, release: () => undefined };
    const key = `${accountId}\n${provider}`;
    const amount = this.#estimate(accountId, provider, v.cap);
    this.#reserved.set(key, (this.#reserved.get(key) ?? 0) + amount);
    let held = true;
    return {
      ...v,
      release: () => {
        if (!held) return;
        held = false;
        const left = (this.#reserved.get(key) ?? 0) - amount;
        if (left > 1e-9) this.#reserved.set(key, left);
        else this.#reserved.delete(key);
      },
    };
  }

  /** `reserve` for a route target. */
  async reserveTarget(t: RouteTarget): Promise<SpendReservation> {
    const accountId = t.providerAccountId ? this.#ownerOf(t.providerAccountId) : null;
    if (!accountId) return { allowed: true, cap: null, release: () => undefined };
    return this.reserve(accountId, t.providerKind);
  }

  /** For image generation and other direct provider calls: a reservation with a plain message. */
  async gate(
    accountId: string,
    provider: string,
  ): Promise<{ allowed: boolean; message: string | null; release: () => void }> {
    const r = await this.reserve(accountId, provider);
    return {
      allowed: r.allowed,
      message: r.allowed || !r.cap ? null : capReachedError(r.cap).message,
      release: r.release,
    };
  }

  /** Record a direct provider call (an image) as usage, like a chat reply's. */
  async recordUsage(u: {
    accountId: string;
    provider: string;
    model: string;
    costUsd: number | null;
    latencyMs: number;
  }): Promise<void> {
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare(
          `INSERT INTO usage_event (id, account_id, provider, model, cost_usd, latency_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uuidv7(),
          u.accountId,
          u.provider,
          u.model,
          u.costUsd,
          u.latencyMs,
          this.#now().toISOString(),
        ),
    );
    await this.evaluate(u.accountId);
  }

  /** Fire every due warning of an account (after a reply's usage was recorded). */
  async evaluate(accountId: string): Promise<void> {
    for (const cap of this.list(accountId)) await this.#alerts(accountId, cap);
  }

  /** The warning at the threshold and the notice at the cap, once a period each. */
  async #alerts(accountId: string, cap: SpendCapView): Promise<void> {
    if (cap.state === 'ok') return;
    const level = cap.state === 'reached' ? 'reached' : 'warning';
    const now = this.#now().toISOString();
    const fresh = await this.#db.transaction(() => {
      const insert = this.#db.raw.prepare(
        `INSERT OR IGNORE INTO spend_alert (account_id, provider, period_start, level, spent_usd,
           limit_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const r = insert.run(
        accountId,
        cap.provider,
        cap.periodStart,
        level,
        cap.spentUsd,
        cap.limitUsd,
        now,
      );
      // Reaching the cap also stands for the warning, which then never fires late.
      if (level === 'reached')
        insert.run(
          accountId,
          cap.provider,
          cap.periodStart,
          'warning',
          cap.spentUsd,
          cap.limitUsd,
          now,
        );
      return Number(r.changes) > 0;
    });
    if (!fresh) return;
    const payload = {
      provider: cap.provider,
      spentUsd: cap.spentUsd,
      limitUsd: cap.limitUsd,
      warnAt: cap.warnAt,
      period: cap.period,
      periodStart: cap.periodStart,
      resetsAt: cap.resetsAt,
      hardStop: cap.hardStop,
    };
    try {
      await this.#events?.emit({
        name: level === 'reached' ? 'spend.cap.reached' : 'spend.cap.warning',
        accountId,
        payload,
      });
      const per = cap.period === 'day' ? 'today' : 'this month';
      await this.#notifier?.notify({
        accountId,
        kind: 'attention',
        title:
          level === 'reached'
            ? `${cap.provider} spend cap reached`
            : `${cap.provider} spend at ${Math.round(cap.fraction * 100)}% of its cap`,
        body:
          level === 'reached'
            ? `${money(cap.spentUsd)} of ${money(cap.limitUsd)} ${per}. ${cap.hardStop ? 'Calls to this provider stop until the cap resets or you raise it.' : 'The cap only warns: calls continue.'}`
            : `${money(cap.spentUsd)} of ${money(cap.limitUsd)} ${per}.`,
        href: spendCapHref(cap.provider),
        dedupeKey: `spend:${cap.provider}:${cap.periodStart}:${level}`,
      });
    } catch (err) {
      this.#log?.warn('spend cap alert failed', { err });
    }
  }

  /**
   * "Clear usage data" (docs/14 §6): the account's usage records go, except those a run or goal
   * still counts against its budget; each cap keeps its current period's spend.
   */
  async clearUsage(accountId: string): Promise<{ removed: number }> {
    const removed = await this.#db.transaction(() => {
      for (const row of this.#db.raw
        .prepare('SELECT * FROM spend_cap WHERE account_id = ?')
        .all(accountId) as unknown as CapRow[]) {
        const start = spendPeriod(row.period, this.#now()).start.toISOString();
        const total = this.spent(accountId, row.provider, start, row);
        this.#db.raw
          .prepare(
            'UPDATE spend_cap SET carried_usd = ?, carried_period_start = ? WHERE account_id = ? AND provider = ?',
          )
          .run(total, start, accountId, row.provider);
      }
      return Number(
        this.#db.raw
          .prepare(
            `DELETE FROM usage_event WHERE account_id = ?
               AND (run_id IS NULL OR run_id NOT IN (
                 SELECT id FROM run WHERE status IN ('planning', 'running', 'waiting_approval', 'paused')))
               AND (goal_id IS NULL OR goal_id NOT IN (SELECT id FROM goal WHERE status <> 'complete'))`,
          )
          .run(accountId).changes,
      );
    });
    await this.#audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'usage.clear',
      resource: 'usage_event',
      result: 'ok',
      detail: { removed },
    });
    return { removed };
  }

  /** Record a limit a provider reported on a call (its account's `entitlements`). */
  async recordReported(t: RouteTarget, error: AgentErrorShape): Promise<void> {
    if (!t.providerAccountId) return;
    if (error.code !== 'over_budget' && error.code !== 'rate_limited') return;
    const reported: ProviderReportedLimit = {
      code: error.code,
      message: error.message.slice(0, 300),
      at: this.#now().toISOString(),
      retryAfterMs: typeof error.retryAfterMs === 'number' ? error.retryAfterMs : null,
    };
    try {
      await this.#db.transaction(() => {
        const row = this.#db.raw
          .prepare('SELECT entitlements FROM provider_account WHERE id = ?')
          .get(t.providerAccountId) as { entitlements: string | null } | undefined;
        if (!row) return;
        const current = parseEntitlements(row.entitlements);
        this.#db.raw
          .prepare('UPDATE provider_account SET entitlements = ? WHERE id = ?')
          .run(JSON.stringify({ ...current, lastReported: reported }), t.providerAccountId);
      });
    } catch (err) {
      this.#log?.warn('provider limit not recorded', { err });
    }
  }

  /** Every provider account of the account with its limits, month's spend and cap (FR-115). */
  limits(accountId: string): ProviderLimitView[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT id, provider, label, base_url, entitlements FROM provider_account
         WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
      )
      .all(accountId) as {
      id: string;
      provider: string;
      label: string;
      base_url: string | null;
      entitlements: string | null;
    }[];
    const chosen = new Map(
      (
        this.#db.raw
          .prepare('SELECT provider, provider_account_id FROM provider_active WHERE account_id = ?')
          .all(accountId) as { provider: string; provider_account_id: string }[]
      ).map((r) => [r.provider, r.provider_account_id]),
    );
    const firstOfKind = new Map<string, string>();
    for (const r of rows) if (!firstOfKind.has(r.provider)) firstOfKind.set(r.provider, r.id);
    const monthStart = spendPeriod('month', this.#now()).start.toISOString();
    return rows.map((r) => {
      const e = parseEntitlements(r.entitlements);
      const activeId = rows.some((x) => x.id === chosen.get(r.provider))
        ? chosen.get(r.provider)
        : firstOfKind.get(r.provider);
      const capRow = this.#row(accountId, r.provider);
      return {
        providerAccountId: r.id,
        provider: r.provider,
        label: r.label,
        active: activeId === r.id,
        local: isLocalProvider(r.provider, r.base_url),
        entitlements:
          e.plan !== null || e.limit !== null || e.used !== null || e.resetAt !== null
            ? { plan: e.plan, limit: e.limit, used: e.used, resetAt: e.resetAt }
            : null,
        lastReported: e.lastReported,
        spentThisMonthUsd: this.spent(accountId, r.provider, monthStart, capRow),
        spendCap: capRow ? this.#view(capRow) : null,
      };
    });
  }
}

interface Entitlements {
  plan: string | null;
  limit: number | null;
  used: number | null;
  resetAt: string | null;
  lastReported: ProviderReportedLimit | null;
}

function parseEntitlements(text: string | null): Entitlements {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      v = parsed as Record<string, unknown>;
  } catch {
    v = {};
  }
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const lr = v.lastReported as Partial<ProviderReportedLimit> | undefined;
  return {
    plan: str(v.plan),
    limit: num(v.limit),
    used: num(v.used),
    resetAt: str(v.resetAt),
    lastReported:
      lr && (lr.code === 'over_budget' || lr.code === 'rate_limited') && typeof lr.at === 'string'
        ? {
            code: lr.code,
            message: typeof lr.message === 'string' ? lr.message : '',
            at: lr.at,
            retryAfterMs: num(lr.retryAfterMs),
          }
        : null,
  };
}

/** Where the owner changes a provider's cap: Settings → Profile & usage, at the caps. */
export function spendCapHref(provider: string): string {
  return `/settings/profile?cap=${encodeURIComponent(provider)}#spend-caps`;
}

/** The error a capped call stops with (contracts/hub-api.md: `over_budget`, 402). */
export function capReachedError(cap: SpendCapView): AgentErrorShape {
  const per = cap.period === 'day' ? 'day' : 'month';
  return {
    code: 'over_budget',
    message: `The ${cap.provider} spend cap of ${money(cap.limitUsd)} a ${per} is reached (${money(cap.spentUsd)} spent): calls to ${cap.provider} stop until ${cap.resetsAt.slice(0, 10)} or until you raise the cap.`,
    retryable: false,
    action: 'Raise the cap in Settings → Profile & usage',
    details: { reason: 'spend_cap', provider: cap.provider },
  };
}

/**
 * The router with spend caps enforced before each model call: a capped provider's targets are
 * dropped from the route (a fallback on another provider still runs), and a route left with none
 * stops with `over_budget` before anything is sent. Limits the provider reports are recorded.
 */
export function withSpendCaps(inner: ModelRouter, caps: SpendCaps): ModelRouter {
  return {
    listModels: (accountId) => inner.listModels(accountId),
    firstModel: (accountId) => inner.firstModel(accountId),
    usable: (accountId, ref) => inner.usable(accountId, ref),
    route: (accountId, ref, opts) => inner.route(accountId, ref, opts),
    pricing: (accountId, kind, modelId) => inner.pricing(accountId, kind, modelId),
    stream: (route, req, ctx) => cappedStream(inner, caps, route, req, ctx),
  };
}

async function* cappedStream(
  inner: ModelRouter,
  caps: SpendCaps,
  route: Parameters<ModelRouter['stream']>[0],
  req: Parameters<ModelRouter['stream']>[1],
  ctx: Parameters<ModelRouter['stream']>[2],
): AsyncGenerator<RoutedEvent> {
  const allowed: RouteTarget[] = [];
  const held: (() => void)[] = [];
  let blocked: SpendCapView | null = null;
  try {
    for (const t of route.targets) {
      const v = await caps.reserveTarget(t);
      held.push(v.release);
      if (v.allowed) allowed.push(t);
      else blocked ??= v.cap;
    }
    if (!allowed.length) {
      if (!blocked) throw new NovaError('validation', 'no model to run this turn');
      yield { type: 'stop', reason: 'error', error: capReachedError(blocked) };
      return;
    }
    let current: RouteTarget | null = null;
    for await (const e of inner.stream({ ...route, targets: allowed }, req, ctx)) {
      if (e.type === 'route') current = e.target;
      else if (e.type === 'stop' && e.reason === 'error' && e.error && current)
        await caps.recordReported(current, e.error);
      yield e;
    }
  } finally {
    for (const release of held) release();
  }
}
