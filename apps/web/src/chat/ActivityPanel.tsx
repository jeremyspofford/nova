// Activity (Inspector tab, FR-104 partial): the open chat's trace from GET /activity, oldest
// first: turns, tool calls, approvals and policy decisions. It refreshes when the chat's stream
// reports tool, approval, policy or turn events, so it follows a running turn.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityItemView, EventEnvelope } from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, Icon, Spinner, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';

export const ACTIVITY_TEXT = defineMessages('chat.activity', {
  title: 'Activity',
  list: 'Activity in this chat',
  openChat: 'Open a chat to see what happened in it.',
  refresh: 'Refresh',
  retry: 'Retry',
  loadFailed: 'Could not load the activity.',
  loading: 'Loading the activity',
  loadingDots: 'Loading…',
  empty: 'Nothing has happened in this chat yet.',
  /** Read before an item's title by screen readers: "Tool call: ". */
  kindPrefix: '{kind}: ',
  kind: {
    turn: 'Turn',
    tool_call: 'Tool call',
    approval: 'Approval',
    policy: 'Policy',
    notice: 'Notice',
    computer: 'Computer',
  },
});

const KIND_ICON: Record<ActivityItemView['kind'], IconName> = {
  turn: 'chat',
  tool_call: 'tool',
  approval: 'shield',
  policy: 'shield',
  notice: 'alert',
  computer: 'eye',
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
      (err: unknown) => setError(errorMessage(err, ACTIVITY_TEXT.loadFailed)),
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

  if (!threadId) return <p className="muted">{ACTIVITY_TEXT.openChat}</p>;
  return (
    <section className="activity" aria-label={ACTIVITY_TEXT.title}>
      <div className="activity-head">
        <Button variant="ghost" onClick={load}>
          <Icon name="refresh" /> {ACTIVITY_TEXT.refresh}
        </Button>
      </div>
      {error ? (
        <div className="artifacts-error" role="alert">
          <p>{error}</p>
          <Button onClick={load}>{ACTIVITY_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <p className="muted">
          <Spinner label={ACTIVITY_TEXT.loading} /> {ACTIVITY_TEXT.loadingDots}
        </p>
      ) : items.length === 0 ? (
        <p className="muted">{ACTIVITY_TEXT.empty}</p>
      ) : (
        <ol className="activity-list" aria-label={ACTIVITY_TEXT.list}>
          {items.map((it) => (
            <li key={it.id} className="activity-item" data-kind={it.kind}>
              <span className="activity-line">
                <Icon name={KIND_ICON[it.kind]} />
                <span className="nv-vh">
                  {ACTIVITY_TEXT.kindPrefix({ kind: ACTIVITY_TEXT.kind[it.kind] })}
                </span>
                <span className="activity-title" dir="auto">
                  {it.title}
                </span>
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
    : fmt.time(d, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
