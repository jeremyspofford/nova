// Activity (Inspector tab, FR-104 partial): the open chat's trace from GET /activity, oldest
// first: turns, tool calls, approvals and policy decisions. It refreshes when the chat's stream
// reports tool, approval, policy or turn events, so it follows a running turn.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityItemView, EventEnvelope } from '@nova/shared';
import { Button, Icon, Spinner, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';

const KIND: Record<ActivityItemView['kind'], { icon: IconName; text: string }> = {
  turn: { icon: 'chat', text: 'Turn' },
  tool_call: { icon: 'tool', text: 'Tool call' },
  approval: { icon: 'shield', text: 'Approval' },
  policy: { icon: 'shield', text: 'Policy' },
  notice: { icon: 'alert', text: 'Notice' },
  computer: { icon: 'eye', text: 'Computer' },
};

/** Events after which the trace has new lines. */
const REFRESH_ON =
  /^(tool\.call\.(started|completed)|approval\.|policy\.|turn\.|browser\.(action|navigated)|screen\.action)/;

function aboutThread(env: EventEnvelope): string | null {
  const p = env.payload;
  return env.correlation?.threadId ?? (typeof p.threadId === 'string' ? p.threadId : null);
}

export function ActivityPanel({ threadId }: { threadId: string | null }) {
  const { api, bus } = useServices();
  const [items, setItems] = useState<ActivityItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!threadId) return;
    api.activity(threadId).then(
      ({ items: list }) => {
        setItems(list);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err, 'Could not load the activity.')),
    );
  }, [api, threadId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(
    () =>
      bus.subscribe((env) => {
        if (!threadId || !REFRESH_ON.test(env.name)) return;
        const about = aboutThread(env);
        if (about && about !== threadId) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(load, 150);
      }),
    [bus, load, threadId],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!threadId) return <p className="muted">Open a chat to see what happened in it.</p>;
  return (
    <section className="activity" aria-label="Activity">
      <div className="activity-head">
        <Button variant="ghost" onClick={load}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {error ? (
        <div className="artifacts-error" role="alert">
          <p>{error}</p>
          <Button onClick={load}>Retry</Button>
        </div>
      ) : items === null ? (
        <p className="muted">
          <Spinner label="Loading the activity" /> Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="muted">Nothing has happened in this chat yet.</p>
      ) : (
        <ol className="activity-list" aria-label="Activity in this chat">
          {items.map((it) => (
            <li key={it.id} className="activity-item" data-kind={it.kind}>
              <span className="activity-line">
                <Icon name={KIND[it.kind].icon} />
                <span className="nv-vh">{KIND[it.kind].text}: </span>
                <span className="activity-title">{it.title}</span>
                {it.status ? <span className="activity-status">{it.status}</span> : null}
                <time className="muted activity-time" dateTime={it.ts}>
                  {timeOf(it.ts)}
                </time>
              </span>
              {it.detail ? <span className="activity-detail">{it.detail}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
