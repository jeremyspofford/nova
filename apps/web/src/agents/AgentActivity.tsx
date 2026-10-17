// The agent's Activity (FR-090; docs/09 §8, §9; docs/04 §2.5): everything it did across its
// threads, its background runs and its own events (created, paused, rules changed, research
// findings, wakes set, budgets reached), newest first, from GET /agents/:id/activity. Each entry
// opens to its recorded details; details are what the runtime recorded and are shown as text.
import { useEffect, useId, useState } from 'react';
import type { ActivityItemView } from '@nova/shared';
import { Button, Icon, Spinner, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAgentsApi } from './api.ts';

const KIND: Record<ActivityItemView['kind'], { icon: IconName; text: string }> = {
  turn: { icon: 'chat', text: 'Turn' },
  tool_call: { icon: 'tool', text: 'Tool call' },
  approval: { icon: 'shield', text: 'Approval' },
  policy: { icon: 'shield', text: 'Policy' },
  notice: { icon: 'activity', text: 'Event' },
  computer: { icon: 'server', text: 'Computer' },
};

function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the activity.')),
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
        <h2 id={headingId}>Activity</h2>
        <Button variant="ghost" onClick={() => setManual((n) => n + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : items === null ? (
        <p className="muted">
          <Spinner label="Loading the activity" /> Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="muted">
          Nothing yet. Turns, tool calls, approvals, research and background work show here as they
          happen.
        </p>
      ) : (
        <ol className="activity-list agent-activity" aria-label="Agent activity">
          {items.map((it) => {
            const expanded = open.has(it.id);
            return (
              <li key={it.id} className="activity-item" data-kind={it.kind}>
                <button
                  type="button"
                  className="work-trace-step"
                  aria-expanded={expanded}
                  onClick={() => toggle(it.id)}
                >
                  <Icon name={KIND[it.kind].icon} />
                  <span className="nv-vh">{KIND[it.kind].text}:</span>{' '}
                  <span className="activity-title">{it.title}</span>
                  {it.status ? <span className="activity-status">{it.status}</span> : null}
                  <time className="muted activity-time" dateTime={it.ts}>
                    {timeOf(it.ts)}
                  </time>
                </button>
                {expanded ? (
                  <dl className="ws-dl work-trace-detail">
                    <dt>Kind</dt>
                    <dd>{KIND[it.kind].text}</dd>
                    {it.status ? (
                      <>
                        <dt>Status</dt>
                        <dd>{it.status}</dd>
                      </>
                    ) : null}
                    <dt>Time</dt>
                    <dd>{new Date(it.ts).toLocaleString()}</dd>
                    {it.callId ? (
                      <>
                        <dt>Call</dt>
                        <dd>
                          <code>{it.callId}</code>
                        </dd>
                      </>
                    ) : null}
                    {it.detail ? (
                      <>
                        <dt>Details</dt>
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
