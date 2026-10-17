// Usage insights (FR-114, docs/14 §6): tokens and estimated cost by provider and model, by
// project and by day, active days, the current streak and the longest turn, all computed locally
// from `usage_event` (one row per model response, docs/07 §11) and `turn`. Days are UTC days.
// Every aggregate is one indexed range scan, so a year of data stays fast.
import { NovaError, type UsageSummary } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
/** How far back a streak is followed. */
const MAX_STREAK_DAYS = 3_660;

export interface UsageRange {
  /** ISO date (`YYYY-MM-DD`, from the start of that UTC day) or timestamp. */
  from?: string;
  /** ISO date (through the end of that UTC day) or timestamp; exclusive for a timestamp. */
  to?: string;
}

export interface UsageServiceOptions {
  db: NovaDatabase;
  now?: () => Date;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseBound(value: string, edge: 'from' | 'to'): Date {
  const dateOnly = DATE_ONLY.test(value);
  const d = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(d.getTime()))
    throw new NovaError('validation', `${edge} is not a date`, { details: { field: edge } });
  return dateOnly && edge === 'to' ? new Date(d.getTime() + DAY_MS) : d;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export class UsageService {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;

  constructor(opts: UsageServiceOptions) {
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
  }

  summary(accountId: string, range: UsageRange = {}): UsageSummary {
    const now = this.#now();
    const to = range.to ? parseBound(range.to, 'to') : now;
    const from = range.from
      ? parseBound(range.from, 'from')
      : new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
    if (from.getTime() >= to.getTime())
      throw new NovaError('validation', 'from must be before to', { details: { field: 'from' } });
    const span = [accountId, from.toISOString(), to.toISOString()] as const;
    const raw = this.#db.raw;
    const inRange = 'account_id = ? AND created_at >= ? AND created_at < ?';

    const t = raw
      .prepare(
        `SELECT coalesce(sum(input_tokens), 0) AS i, coalesce(sum(output_tokens), 0) AS o,
                coalesce(sum(cached_tokens), 0) AS c, coalesce(sum(cost_usd), 0) AS cost,
                count(DISTINCT turn_id) AS turns
         FROM usage_event WHERE ${inRange}`,
      )
      .get(...span) as Record<string, unknown>;

    const byModel = (
      raw
        .prepare(
          `SELECT coalesce(provider, '') AS provider, coalesce(model, '') AS model,
                  coalesce(sum(input_tokens), 0) AS i, coalesce(sum(output_tokens), 0) AS o,
                  coalesce(sum(cost_usd), 0) AS cost, count(DISTINCT turn_id) AS turns
           FROM usage_event WHERE ${inRange}
           GROUP BY 1, 2 ORDER BY (i + o) DESC, provider, model`,
        )
        .all(...span) as Record<string, unknown>[]
    ).map((r) => ({
      provider: String(r.provider),
      model: String(r.model),
      inputTokens: num(r.i),
      outputTokens: num(r.o),
      costUsd: round(num(r.cost), 6),
      turns: num(r.turns),
    }));

    // Usage outside a thread (memory extraction, consolidation) counts as "no project".
    const byProject = (
      raw
        .prepare(
          `SELECT th.project_id AS projectId, p.name AS name,
                  coalesce(sum(u.input_tokens), 0) AS i, coalesce(sum(u.output_tokens), 0) AS o,
                  coalesce(sum(u.cost_usd), 0) AS cost
           FROM usage_event u
           LEFT JOIN thread th ON th.id = u.thread_id
           LEFT JOIN project p ON p.id = th.project_id
           WHERE u.account_id = ? AND u.created_at >= ? AND u.created_at < ?
           GROUP BY th.project_id ORDER BY (i + o) DESC, name`,
        )
        .all(...span) as Record<string, unknown>[]
    ).map((r) => ({
      projectId: typeof r.projectId === 'string' ? r.projectId : null,
      name: typeof r.name === 'string' ? r.name : null,
      inputTokens: num(r.i),
      outputTokens: num(r.o),
      costUsd: round(num(r.cost), 6),
    }));

    const byDay = (
      raw
        .prepare(
          `SELECT substr(created_at, 1, 10) AS d,
                  coalesce(sum(input_tokens), 0) AS i, coalesce(sum(output_tokens), 0) AS o,
                  coalesce(sum(cost_usd), 0) AS cost
           FROM usage_event WHERE ${inRange}
           GROUP BY d ORDER BY d`,
        )
        .all(...span) as Record<string, unknown>[]
    ).map((r) => ({
      day: String(r.d),
      inputTokens: num(r.i),
      outputTokens: num(r.o),
      costUsd: round(num(r.cost), 6),
    }));

    // The longest completed turn that started in the range, in a live thread.
    const longest = raw
      .prepare(
        `SELECT t.id AS turnId, t.thread_id AS threadId,
                (julianday(t.ended_at) - julianday(t.started_at)) * 86400.0 AS secs
         FROM turn t JOIN thread th ON th.id = t.thread_id
         WHERE th.account_id = ? AND th.deleted_at IS NULL AND t.status = 'completed'
           AND t.ended_at IS NOT NULL AND t.started_at >= ? AND t.started_at < ?
         ORDER BY secs DESC, t.id LIMIT 1`,
      )
      .get(...span) as { turnId: string; threadId: string; secs: number } | undefined;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        inputTokens: num(t.i),
        outputTokens: num(t.o),
        cachedTokens: num(t.c),
        costUsd: round(num(t.cost), 6),
        turns: num(t.turns),
      },
      byModel,
      byProject,
      byDay,
      activeDays: byDay.length,
      streak: this.#streak(accountId, to, now),
      longestTurn: longest
        ? {
            threadId: longest.threadId,
            turnId: longest.turnId,
            seconds: round(Math.max(0, longest.secs), 1),
          }
        : null,
    };
  }

  /**
   * Consecutive active days ending on the range's last day (today for the default range). A
   * streak is not broken until a whole day passes without use: when that last day is today and
   * has no usage yet, the streak ending yesterday still counts.
   */
  #streak(accountId: string, to: Date, now: Date): number {
    const lastMs = Math.min(to.getTime() - 1, now.getTime());
    const end = day(new Date(lastMs));
    const days = this.#db.raw
      .prepare(
        `SELECT DISTINCT substr(created_at, 1, 10) AS d FROM usage_event
         WHERE account_id = ? AND created_at >= ? AND created_at < ?
         ORDER BY d DESC`,
      )
      .all(
        accountId,
        new Date(lastMs - MAX_STREAK_DAYS * DAY_MS).toISOString(),
        new Date(Date.parse(`${end}T00:00:00.000Z`) + DAY_MS).toISOString(),
      ) as { d: string }[];
    const active = new Set(days.map((r) => r.d));
    let cursor = Date.parse(`${end}T00:00:00.000Z`);
    if (!active.has(end) && end === day(now)) cursor -= DAY_MS;
    let streak = 0;
    while (active.has(day(new Date(cursor)))) {
      streak++;
      cursor -= DAY_MS;
    }
    return streak;
  }
}
