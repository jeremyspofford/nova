// Changes waiting to send (FR-112): every change made on this device while the Hub was away, in the
// order it goes out, with its status (waiting, sending, not sent with the Hub's reason, sent), when
// it will be tried again, Retry for one that failed, Copy for its words, and Discard, which asks
// first because a discarded change never reaches the Hub. Settings → Sync shows it.
import { useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button } from '@nova/ui';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useOffline } from './context.tsx';
import { inText, itemLabel, noteText, problemText, queueStatus } from './format.ts';
import { Chip, Confirm, CopyText } from './parts.tsx';
import type { QueueItem } from './queue.ts';
import './offline.css';

export const QUEUE_TEXT = defineMessages('offline.queue', {
  empty:
    'Nothing waits to send. Changes you make while the Hub is unreachable wait here until it is back.',
  clearSent: 'Clear sent',
  list: 'Changes waiting to send',
  /** After the reason a change waits: "Trying again in 8 s." */
  tryingAgain: 'Trying again {when}.',
  made: '{byModel, select, yes {Made {when} · {model}} other {Made {when}}}',
  retrying: 'Trying to send {what} again.',
  retry: 'Retry',
  discard: 'Discard',
  discardTitle: 'Discard this change?',
  discardBody:
    '“{what}” has not reached the Hub. Discarding it removes it from this device for good.',
  beingSent: 'It is being sent right now. Try again in a moment.',
  discarded: 'Change discarded.',
});

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

  if (!runtime || !items.length) return <p className="muted">{QUEUE_TEXT.empty}</p>;

  return (
    <div className="stack">
      {done.length ? (
        <div className="row">
          <Button variant="ghost" onClick={() => runtime.queue.clearDone()}>
            {QUEUE_TEXT.clearSent}
          </Button>
        </div>
      ) : null}
      <ul
        className="ws-list"
        aria-labelledby={headingId}
        aria-label={headingId ? undefined : QUEUE_TEXT.list}
      >
        {items.map((item) => {
          const text = itemText(item);
          const label = itemLabel(item);
          const problem = item.status !== 'done' ? problemText(item) : null;
          const note = noteText(item.note);
          const waitMs = item.nextAttemptAt ? Date.parse(item.nextAttemptAt) - now : 0;
          return (
            <li key={item.id} className="ws-list-row of-item" aria-label={label}>
              <div className="ws-source-main of-row-main">
                <strong className="of-item-label">{label}</strong>
                <Chip spec={queueStatus(item.status)} />
                {problem ? (
                  <span className="of-reason">
                    {problem}
                    {item.status === 'queued' && waitMs > 0
                      ? ` ${QUEUE_TEXT.tryingAgain({ when: inText(waitMs) })}`
                      : ''}
                  </span>
                ) : null}
                {note ? <span className="of-reason">{note}</span> : null}
                {text ? (
                  <p className="of-text" dir="auto">
                    {clip(text)}
                  </p>
                ) : null}
                <span className="muted ws-row-meta">
                  {QUEUE_TEXT.made({
                    when: formatWhen(item.createdAt),
                    byModel: item.model ? 'yes' : 'no',
                    model: item.model ?? '',
                  })}
                </span>
              </div>
              <div className="row ws-row-actions">
                {item.status === 'failed' ? (
                  <Button
                    onClick={() => {
                      announce(QUEUE_TEXT.retrying({ what: label }));
                      void runtime.queue.retry(item.id);
                    }}
                  >
                    {QUEUE_TEXT.retry}
                  </Button>
                ) : null}
                {text ? <CopyText text={text} kind="text" /> : null}
                {item.status === 'queued' || item.status === 'failed' ? (
                  <Button variant="ghost" onClick={() => setDiscarding(item)}>
                    {QUEUE_TEXT.discard}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {discarding ? (
        <Confirm
          title={QUEUE_TEXT.discardTitle}
          description={QUEUE_TEXT.discardBody({ what: itemLabel(discarding) })}
          confirmLabel={QUEUE_TEXT.discard}
          danger
          onClose={() => setDiscarding(null)}
          onConfirm={async () => {
            const ok = await runtime.queue.discard(discarding.id);
            if (!ok) throw new Error(QUEUE_TEXT.beingSent);
            announce(QUEUE_TEXT.discarded);
            setDiscarding(null);
          }}
        >
          {itemText(discarding) ? (
            <p className="of-text" dir="auto">
              {clip(itemText(discarding)!, 600)}
            </p>
          ) : null}
        </Confirm>
      ) : null}
    </div>
  );
}
