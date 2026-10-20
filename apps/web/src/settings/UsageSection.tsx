// Usage insights (FR-114, docs/14 §6): tokens and estimated cost by day as SVG bars with a table
// for every chart, totals, active days, streak, the longest task, and breakdowns by model and by
// project, for a chosen range. The Hub computes them from its own usage records; nothing leaves
// the device.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { UsageSummary } from '@nova/shared';
import { Button, SelectField, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatSeconds } from './plugin-text.ts';

export const USAGE_TEXT = defineMessages('settings.usage', {
  lastDays: '{n, plural, one {Last day} other {Last # days}}',
  lastYear: 'Last year',
  under: 'under {amount}',
  summary: 'Total {total}. Highest on {day}: {max}.',
  noUsage: 'No usage in this range.',
  /** A chart's accessible name: its title, then its summary. */
  chart: '{title}. {summary}',
  bar: '{day}: {value}',
  showTable: 'Show as a table',
  day: 'Day',
  loadFailed: 'Could not load usage.',
  title: 'Usage',
  intro:
    'Counted on your Hub from your own chats; nothing about it leaves this device. Costs are ' +
    'estimates from each provider’s list prices.',
  range: 'Range',
  retry: 'Retry',
  loading: 'Loading usage',
  totals: 'Totals',
  tokensIn: 'Tokens in',
  tokensOut: 'Tokens out',
  fromCache: 'From cache',
  estimatedCost: 'Estimated cost',
  replies: 'Replies',
  activeDays: 'Active days',
  streak: 'Streak',
  streakDays: '{n, plural, one {# day} other {# days}}',
  longestTask: 'Longest task',
  noneYet: 'none yet',
  noUsageYet: 'No usage in this range yet.',
  tokensByDay: 'Tokens by day',
  tokens: 'Tokens',
  tokenCount: '{n, plural, one {# token} other {# tokens}}',
  costByDay: 'Cost by day',
  cost: 'Cost',
  byModel: 'By model',
  model: 'Model',
  noneInRange: 'None in this range.',
  byProject: 'By project',
  project: 'Project',
  deletedProject: 'Deleted project',
  noProject: 'No project',
});
const S = USAGE_TEXT;

const DAY_MS = 86_400_000;

/** The ranges to pick from, in days; read at render (their labels follow the locale). */
export function rangeOptions(): { value: string; label: string }[] {
  return [7, 30, 90, 365].map((n) => ({
    value: String(n),
    label: n === 365 ? S.lastYear : S.lastDays({ n }),
  }));
}

const USD = { style: 'currency', currency: 'USD' } as const;

/** An estimated cost in US dollars, in the active locale: "$12.35", "under $0.01". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return S.under({ amount: fmt.number(0.01, USD) });
  return fmt.number(usd, USD);
}

const num = (n: number) => fmt.number(n);

/** `YYYY-MM-DD` for a time, in UTC (the Hub's day buckets). */
export function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, with the summary's values and zero for idle days. */
export function fillDays(
  s: Pick<UsageSummary, 'from' | 'to' | 'byDay'>,
): { day: string; tokens: number; costUsd: number }[] {
  const by = new Map(s.byDay.map((d) => [d.day.slice(0, 10), d]));
  const start = Date.parse(`${s.from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${s.to.slice(0, 10)}T00:00:00Z`);
  const out: { day: string; tokens: number; costUsd: number }[] = [];
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let t = start; t <= end && out.length < 400; t += DAY_MS) {
    const k = dayKey(t);
    const d = by.get(k);
    out.push({
      day: k,
      tokens: d ? d.inputTokens + d.outputTokens : 0,
      costUsd: d ? d.costUsd : 0,
    });
  }
  return out;
}

const shortDay = (day: string) =>
  fmt.date(`${day}T12:00:00Z`, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** One series of bars, one per day, with a hover title per bar and a table view. */
export function DayBars({
  title,
  column,
  days,
  value,
  format,
}: {
  title: string;
  /** The table's value column. */
  column: string;
  days: { day: string }[];
  value: (i: number) => number;
  format: (v: number) => string;
}) {
  const id = useId();
  const values = days.map((_, i) => value(i));
  const max = Math.max(0, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const peak = values.indexOf(max);
  const W = 600;
  const H = 120;
  const slot = days.length ? W / days.length : W;
  const bar = Math.max(1, slot - Math.min(4, slot * 0.3));
  const summary =
    max > 0 && days[peak]
      ? S.summary({ total: format(total), day: shortDay(days[peak].day), max: format(max) })
      : S.noUsage;
  return (
    <figure className="ws-chart" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="ws-chart-title">
        {title}
      </figcaption>
      <p className="muted ws-chart-summary">{summary}</p>
      <svg
        className="ws-bars"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={S.chart({ title, summary })}
      >
        {values.map((v, i) => {
          const h = max > 0 ? (v / max) * (H - 4) : 0;
          const d = days[i];
          if (!d) return null;
          return (
            <rect
              key={d.day}
              x={i * slot + (slot - bar) / 2}
              y={H - h}
              width={bar}
              height={h}
              rx={Math.min(2, bar / 2)}
            >
              <title>{S.bar({ day: shortDay(d.day), value: format(v) })}</title>
            </rect>
          );
        })}
        <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} className="ws-bars-axis" />
      </svg>
      {days.length ? (
        <div className="ws-chart-axis muted" aria-hidden="true">
          <span>{shortDay(days[0]!.day)}</span>
          <span>{shortDay(days[days.length - 1]!.day)}</span>
        </div>
      ) : null}
      <details className="ws-advanced">
        <summary>{S.showTable}</summary>
        <table className="ws-table">
          <caption className="nv-vh">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{S.day}</th>
              <th scope="col">{column}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d.day}>
                <th scope="row">{shortDay(d.day)}</th>
                <td>{format(values[i] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export function UsageSection() {
  const { api } = useServices();
  const [range, setRange] = useState('30');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    const now = Date.now();
    api
      .usage({
        from: new Date(now - Number(range) * DAY_MS).toISOString(),
        to: new Date(now).toISOString(),
      })
      .then(
        (u) => {
          if (!alive) return;
          setUsage(u);
          setError(null);
        },
        (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
      );
    return () => {
      alive = false;
    };
  }, [api, range, retry]);

  const days = usage ? fillDays(usage) : [];
  const t = usage?.totals;

  return (
    <section className="settings-section" aria-labelledby="profile-usage">
      <h3 id="profile-usage">{S.title}</h3>
      <p className="muted">{S.intro}</p>
      <SelectField label={S.range} value={range} onChange={setRange} options={rangeOptions()} />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setRetry((r) => r + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {!usage && !error ? <Spinner label={S.loading} /> : null}
      {usage && t ? (
        <>
          <dl className="ws-stats" aria-label={S.totals}>
            <div>
              <dt>{S.tokensIn}</dt>
              <dd>{num(t.inputTokens)}</dd>
            </div>
            <div>
              <dt>{S.tokensOut}</dt>
              <dd>{num(t.outputTokens)}</dd>
            </div>
            <div>
              <dt>{S.fromCache}</dt>
              <dd>{num(t.cachedTokens)}</dd>
            </div>
            <div>
              <dt>{S.estimatedCost}</dt>
              <dd>{formatCost(t.costUsd)}</dd>
            </div>
            <div>
              <dt>{S.replies}</dt>
              <dd>{num(t.turns)}</dd>
            </div>
            <div>
              <dt>{S.activeDays}</dt>
              <dd>{num(usage.activeDays)}</dd>
            </div>
            <div>
              <dt>{S.streak}</dt>
              <dd>{S.streakDays({ n: usage.streak })}</dd>
            </div>
            <div>
              <dt>{S.longestTask}</dt>
              <dd>
                {usage.longestTurn ? (
                  <a
                    href={chatPath(usage.longestTurn.threadId)}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(chatPath(usage.longestTurn!.threadId));
                    }}
                  >
                    {formatSeconds(usage.longestTurn.seconds)}
                  </a>
                ) : (
                  S.noneYet
                )}
              </dd>
            </div>
          </dl>
          {t.turns === 0 && usage.byDay.length === 0 ? (
            <p className="muted">{S.noUsageYet}</p>
          ) : null}
          <DayBars
            title={S.tokensByDay}
            column={S.tokens}
            days={days}
            value={(i) => days[i]?.tokens ?? 0}
            format={(v) => S.tokenCount({ n: v })}
          />
          <DayBars
            title={S.costByDay}
            column={S.cost}
            days={days}
            value={(i) => days[i]?.costUsd ?? 0}
            format={formatCost}
          />
          <table className="ws-table">
            <caption>{S.byModel}</caption>
            <thead>
              <tr>
                <th scope="col">{S.model}</th>
                <th scope="col">{S.tokensIn}</th>
                <th scope="col">{S.tokensOut}</th>
                <th scope="col">{S.cost}</th>
                <th scope="col">{S.replies}</th>
              </tr>
            </thead>
            <tbody>
              {usage.byModel.length ? (
                usage.byModel.map((m) => (
                  <tr key={`${m.provider}/${m.model}`}>
                    <th scope="row">
                      {m.model} <span className="muted">({m.provider})</span>
                    </th>
                    <td>{num(m.inputTokens)}</td>
                    <td>{num(m.outputTokens)}</td>
                    <td>{formatCost(m.costUsd)}</td>
                    <td>{num(m.turns)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="muted">
                    {S.noneInRange}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <table className="ws-table">
            <caption>{S.byProject}</caption>
            <thead>
              <tr>
                <th scope="col">{S.project}</th>
                <th scope="col">{S.tokensIn}</th>
                <th scope="col">{S.tokensOut}</th>
                <th scope="col">{S.cost}</th>
              </tr>
            </thead>
            <tbody>
              {usage.byProject.length ? (
                usage.byProject.map((p) => (
                  <tr key={p.projectId ?? 'none'}>
                    <th scope="row">{p.projectId ? (p.name ?? S.deletedProject) : S.noProject}</th>
                    <td>{num(p.inputTokens)}</td>
                    <td>{num(p.outputTokens)}</td>
                    <td>{formatCost(p.costUsd)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="muted">
                    {S.noneInRange}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
