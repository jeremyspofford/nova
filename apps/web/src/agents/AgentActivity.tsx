// The agent's Activity (FR-090; docs/09 §8, §9; docs/04 §2.5): everything it did across its
// threads, its background runs and its own events (created, paused, rules changed, research
// findings, wakes set, budgets reached), newest first, from GET /agents/:id/activity. Each entry
// opens to its recorded details; details are what the runtime recorded and are shown as text.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { ActivityItemView } from '@nova/shared';
import { Button, Icon, Spinner, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAgentsApi } from './api.ts';
import { AGENTS_TEXT } from './format.ts';

export const ACTIVITY_TEXT = defineMessages('agents.activity', {
  kind: {
    turn: 'Turn',
    tool_call: 'Tool call',
    approval: 'Approval',
    policy: 'Policy',
    notice: 'Event',
    computer: 'Computer',
  },
  /** Read before an entry's title: "Tool call:". */
  kindPrefix: '{kind}:',
  loadFailed: 'Could not load the activity.',
  heading: 'Activity',
  refresh: 'Refresh',
  loading: 'Loading the activity',
  empty:
    'Nothing yet. Turns, tool calls, approvals, research and background work show here as they ' +
    'happen.',
  list: 'Agent activity',
  kindLabel: 'Kind',
  status: 'Status',
  time: 'Time',
  call: 'Call',
  details: 'Details',
});

const KIND_ICON: Record<ActivityItemView['kind'], IconName> = {
  turn: 'chat',
  tool_call: 'tool',
  approval: 'shield',
  policy: 'shield',
  notice: 'activity',
  computer: 'server',
};

function timeOf(ts: string, opts?: Intl.DateTimeFormatOptions): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : fmt.dateTime(d, opts);
}

const SHORT_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};
const FULL_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'medium' };

export function AgentActivity({ agentId, version }: { agentId: string; version: number }) {
  const api = useAgentsApi();
  const headingId = useId();
  const [items, setItems] = useState<ActivityItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState(0);

  useEffect(() => {
    let alive = true;
    api.agentActivity(agentId).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems([...list].reverse());
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, ACTIVITY_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, version, manual]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{ACTIVITY_TEXT.heading}</h2>
        <Button variant="ghost" onClick={() => setManual((n) => n + 1)}>
          <Icon name="refresh" /> {ACTIVITY_TEXT.refresh}
        </Button>
      </div>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <p className="muted">
          <Spinner label={ACTIVITY_TEXT.loading} /> {AGENTS_TEXT.loading}
        </p>
      ) : items.length === 0 ? (
        <p className="muted">{ACTIVITY_TEXT.empty}</p>
      ) : (
        <ol className="activity-list agent-activity" aria-label={ACTIVITY_TEXT.list}>
          {items.map((it) => {
            const expanded = open.has(it.id);
            const kind = ACTIVITY_TEXT.kind[it.kind];
            return (
              <li key={it.id} className="activity-item" data-kind={it.kind}>
                <button
                  type="button"
                  className="work-trace-step"
                  aria-expanded={expanded}
                  onClick={() => toggle(it.id)}
                >
                  <Icon name={KIND_ICON[it.kind]} />
                  <span className="nv-vh">{ACTIVITY_TEXT.kindPrefix({ kind })}</span>{' '}
                  <span className="activity-title" dir="auto">
                    {it.title}
                  </span>
                  {it.status ? <span className="activity-status">{it.status}</span> : null}
                  <time className="muted activity-time" dateTime={it.ts}>
                    {timeOf(it.ts, SHORT_TIME)}
                  </time>
                </button>
                {expanded ? (
                  <dl className="ws-dl work-trace-detail">
                    <dt>{ACTIVITY_TEXT.kindLabel}</dt>
                    <dd>{kind}</dd>
                    {it.status ? (
                      <>
                        <dt>{ACTIVITY_TEXT.status}</dt>
                        <dd>{it.status}</dd>
                      </>
                    ) : null}
                    <dt>{ACTIVITY_TEXT.time}</dt>
                    <dd>{timeOf(it.ts, FULL_TIME)}</dd>
                    {it.callId ? (
                      <>
                        <dt>{ACTIVITY_TEXT.call}</dt>
                        <dd>
                          <code dir="ltr">{it.callId}</code>
                        </dd>
                      </>
                    ) : null}
                    {it.detail ? (
                      <>
                        <dt>{ACTIVITY_TEXT.details}</dt>
                        <dd>
                          <pre className="tool-card-pre" data-untrusted="true">
                            {it.detail}
                          </pre>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
