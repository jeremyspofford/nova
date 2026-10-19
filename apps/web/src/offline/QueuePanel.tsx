// Changes waiting to send (FR-112): every change made on this device while the Hub was away, in the
// order it goes out, with its status (waiting, sending, not sent with the Hub's reason, sent), when
// it will be tried again, Retry for one that failed, Copy for its words, and Discard, which asks
// first because a discarded change never reaches the Hub. Settings → Sync shows it.
import { useState } from 'react';
import { Button } from '@nova/ui';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useOffline } from './context.tsx';
import { inText, QUEUE_STATUS } from './format.ts';
import { Chip, Confirm, CopyText } from './parts.tsx';
import type { QueueItem } from './queue.ts';
import './offline.css';

/** The words a change carries: a message or answer, or a page's or project's new text. */
export function itemText(item: QueueItem): string | null {
  if (item.text) return item.text;
  for (const field of ['content', 'instructions', 'title', 'name']) {
    const op = item.ops.find((o) => o.field === field && typeof o.value === 'string');
    if (op) return op.value as string;
  }
  return null;
}

function clip(s: string, n = 280): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function QueuePanel({ headingId }: { headingId?: string }) {
  const { runtime, state } = useOffline();
  const announce = useAnnounce();
  const [discarding, setDiscarding] = useState<QueueItem | null>(null);
  const items = state.queue;
  const done = items.filter((i) => i.status === 'done');
  const [now, setNow] = useState(() => Date.now());
  useInterval(
    () => setNow(Date.now()),
    1000,
    items.some((i) => i.status === 'queued' && i.nextAttemptAt),
  );

  if (!runtime || !items.length)
    return (
      <p className="muted">
        Nothing waits to send. Changes you make while the Hub is unreachable wait here until it is
        back.
      </p>
    );

  return (
    <div className="stack">
      {done.length ? (
        <div className="row">
          <Button variant="ghost" onClick={() => runtime.queue.clearDone()}>
            Clear sent
          </Button>
        </div>
      ) : null}
      <ul
        className="ws-list"
        aria-labelledby={headingId}
        aria-label={headingId ? undefined : 'Changes waiting to send'}
      >
        {items.map((item) => {
          const text = itemText(item);
          const waitMs = item.nextAttemptAt ? Date.parse(item.nextAttemptAt) - now : 0;
          return (
            <li key={item.id} className="ws-list-row of-item" aria-label={item.label}>
              <div className="ws-source-main of-row-main">
                <strong className="of-item-label">{item.label}</strong>
                <Chip spec={QUEUE_STATUS[item.status]} />
                {item.error && item.status !== 'done' ? (
                  <span className="of-reason">
                    {item.error}
                    {item.status === 'queued' && waitMs > 0
                      ? ` Trying again ${inText(waitMs)}.`
                      : ''}
                  </span>
                ) : null}
                {item.note ? <span className="of-reason">{item.note}</span> : null}
                {text ? <p className="of-text">{clip(text)}</p> : null}
                <span className="muted ws-row-meta">
                  Made {formatWhen(item.createdAt)}
                  {item.model ? ` · ${item.model}` : ''}
                </span>
              </div>
              <div className="row ws-row-actions">
                {item.status === 'failed' ? (
                  <Button
                    onClick={() => {
                      announce(`Trying to send ${item.label} again.`);
                      void runtime.queue.retry(item.id);
                    }}
                  >
                    Retry
                  </Button>
                ) : null}
                {text ? <CopyText text={text} what="text" /> : null}
                {item.status === 'queued' || item.status === 'failed' ? (
                  <Button variant="ghost" onClick={() => setDiscarding(item)}>
                    Discard
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {discarding ? (
        <Confirm
          title="Discard this change?"
          description={`“${discarding.label}” has not reached the Hub. Discarding it removes it from this device for good.`}
          confirmLabel="Discard"
          danger
          onClose={() => setDiscarding(null)}
          onConfirm={async () => {
            const ok = await runtime.queue.discard(discarding.id);
            if (!ok) throw new Error('It is being sent right now. Try again in a moment.');
            announce('Change discarded.');
            setDiscarding(null);
          }}
        >
          {itemText(discarding) ? (
            <p className="of-text">{clip(itemText(discarding)!, 600)}</p>
          ) : null}
        </Confirm>
      ) : null}
    </div>
  );
}
