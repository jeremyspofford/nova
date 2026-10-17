// Usage insights (FR-114, docs/14 §6): tokens and estimated cost by day as SVG bars with a table
// for every chart, totals, active days, streak, the longest task, and breakdowns by model and by
// project, for a chosen range. The Hub computes them from its own usage records; nothing leaves
// the device.
import { useEffect, useId, useState } from 'react';
import type { UsageSummary } from '@nova/shared';
import { Button, SelectField, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { plural } from './common.ts';
import { formatSeconds } from './plugin-text.ts';

const DAY_MS = 86_400_000;

export const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
];

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

const num = (n: number) => n.toLocaleString('en-US');

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
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** One series of bars, one per day, with a hover title per bar and a table view. */
export function DayBars({
  title,
  days,
  value,
  format,
}: {
  title: string;
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
      ? `Total ${format(total)}. Highest on ${shortDay(days[peak].day)}: ${format(max)}.`
      : 'No usage in this range.';
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
        aria-label={`${title}. ${summary}`}
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
              <title>{`${shortDay(d.day)}: ${format(v)}`}</title>
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
        <summary>Show as a table</summary>
        <table className="ws-table">
          <caption className="nv-vh">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{title.split(' by ')[0]}</th>
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
        (err: unknown) => alive && setError(errorMessage(err, 'Could not load usage.')),
      );
    return () => {
      alive = false;
    };
  }, [api, range, retry]);

  const days = usage ? fillDays(usage) : [];
  const t = usage?.totals;

  return (
    <section className="settings-section" aria-labelledby="profile-usage">
      <h3 id="profile-usage">Usage</h3>
      <p className="muted">
        Counted on your Hub from your own chats; nothing about it leaves this device. Costs are
        estimates from each provider&apos;s list prices.
      </p>
      <SelectField label="Range" value={range} onChange={setRange} options={RANGES} />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setRetry((r) => r + 1)}>Retry</Button>
        </div>
      ) : null}
      {!usage && !error ? <Spinner label="Loading usage" /> : null}
      {usage && t ? (
        <>
          <dl className="ws-stats" aria-label="Totals">
            <div>
              <dt>Tokens in</dt>
              <dd>{num(t.inputTokens)}</dd>
            </div>
            <div>
              <dt>Tokens out</dt>
              <dd>{num(t.outputTokens)}</dd>
            </div>
            <div>
              <dt>From cache</dt>
              <dd>{num(t.cachedTokens)}</dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd>{formatCost(t.costUsd)}</dd>
            </div>
            <div>
              <dt>Replies</dt>
              <dd>{num(t.turns)}</dd>
            </div>
            <div>
              <dt>Active days</dt>
              <dd>{num(usage.activeDays)}</dd>
            </div>
            <div>
              <dt>Streak</dt>
              <dd>{plural(usage.streak, 'day')}</dd>
            </div>
            <div>
              <dt>Longest task</dt>
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
                  'none yet'
                )}
              </dd>
            </div>
          </dl>
          {t.turns === 0 && usage.byDay.length === 0 ? (
            <p className="muted">No usage in this range yet.</p>
          ) : null}
          <DayBars
            title="Tokens by day"
            days={days}
            value={(i) => days[i]?.tokens ?? 0}
            format={(v) => `${num(v)} tokens`}
          />
          <DayBars
            title="Cost by day"
            days={days}
            value={(i) => days[i]?.costUsd ?? 0}
            format={formatCost}
          />
          <table className="ws-table">
            <caption>By model</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Tokens in</th>
                <th scope="col">Tokens out</th>
                <th scope="col">Cost</th>
                <th scope="col">Replies</th>
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
                    None in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <table className="ws-table">
            <caption>By project</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Tokens in</th>
                <th scope="col">Tokens out</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.byProject.length ? (
                usage.byProject.map((p) => (
                  <tr key={p.projectId ?? 'none'}>
                    <th scope="row">
                      {p.projectId ? (p.name ?? 'Deleted project') : 'No project'}
                    </th>
                    <td>{num(p.inputTokens)}</td>
                    <td>{num(p.outputTokens)}</td>
                    <td>{formatCost(p.costUsd)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="muted">
                    None in this range.
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
