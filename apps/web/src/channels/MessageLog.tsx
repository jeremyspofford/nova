// A channel's message log (FR-110, the M6 known gap; docs/13 §4): every message in and out of one
// binding, newest first, with what happened to it (started a turn, answered, ignored, dropped,
// sent, failed, held back) and why, in plain words. The log keeps no text: the messages are in the
// channel's thread, linked from each row. Senders and conversation names come from the other
// service: shown as text. Filters by direction and status; "Show older" pages back. Live through
// the channel's message events. Pages follow the Hub's `nextCursor`, so messages that share a
// timestamp are never skipped. M8: a file the agent sent with its reply (Telegram) is its own row,
// marked as a file.
import { useCallback, useEffect, useId, useState } from 'react';
import {
  CHANNEL_MESSAGE_STATUSES,
  type ChannelBindingViewM7,
  type ChannelMessageStatus,
  type ChannelMessageView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useChannelsM7Api } from './api-m7.ts';
import { useChannelEvents, useDebouncedCallback } from './events.ts';
import { FILE_BADGE, MESSAGE_STATUS, formatStamp, isFileRow, messageReason } from './format.ts';
import { Chip } from './parts.tsx';

/** Messages per page. */
export const MESSAGE_PAGE = 50;

const MESSAGE_EVENTS = ['channel.message.received', 'channel.message.sent'] as const;

type Direction = '' | 'in' | 'out';

const isStatus = (v: string): v is ChannelMessageStatus =>
  (CHANNEL_MESSAGE_STATUSES as readonly string[]).includes(v);

export function MessageLog({ binding }: { binding: ChannelBindingViewM7 }) {
  const api = useChannelsM7Api();
  const headingId = useId();
  const [direction, setDirection] = useState<Direction>('');
  const [status, setStatus] = useState<ChannelMessageStatus | ''>('');
  const [items, setItems] = useState<ChannelMessageView[] | null>(null);
  /** The Hub's `nextCursor` for the next older page; null on the last page. */
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [version, setVersion] = useState(0);

  const filter = useCallback(
    () => ({
      ...(direction ? { direction } : {}),
      ...(status ? { status } : {}),
    }),
    [direction, status],
  );

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.listChannelMessages(binding.id, { ...filter(), limit: MESSAGE_PAGE }))
      .then(
        (page) => {
          if (!alive) return;
          setItems(page.items);
          setCursor(page.nextCursor);
          setError(null);
        },
        (err: unknown) => alive && setError(errorMessage(err, 'Could not load the messages.')),
      );
    return () => {
      alive = false;
    };
  }, [api, binding.id, filter, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const debounced = useDebouncedCallback(reload, 300);
  useChannelEvents(
    MESSAGE_EVENTS,
    (env) => {
      if (env.payload.bindingId === binding.id) debounced();
    },
    reload,
  );

  const showOlder = async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.listChannelMessages(binding.id, {
        ...filter(),
        cursor,
        limit: MESSAGE_PAGE,
      });
      setItems((list) => {
        const seen = new Set((list ?? []).map((m) => m.id));
        return [...(list ?? []), ...page.items.filter((m) => !seen.has(m.id))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      setOlderError(errorMessage(err, 'Could not load older messages.'));
    } finally {
      setLoadingOlder(false);
    }
  };

  const filtered = direction !== '' || status !== '';
  return (
    <section className="ch-log" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h4 id={headingId} className="ws-subhead">
          Messages
        </h4>
        <Button
          variant="ghost"
          onClick={reload}
          aria-label={`Refresh the messages of ${binding.label}`}
        >
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      <p className="muted ws-flush">
        What came in and went out, and what Nova did with it. The text itself is in the channel’s
        thread.
      </p>
      <div className="ws-toolbar ch-log-filters">
        <SelectField
          label="Direction"
          value={direction}
          onChange={(v) => setDirection(v === 'in' || v === 'out' ? v : '')}
          options={[
            { value: '', label: 'In and out' },
            { value: 'in', label: 'Received' },
            { value: 'out', label: 'Sent' },
          ]}
        />
        <SelectField
          label="What happened"
          value={status}
          onChange={(v) => setStatus(isStatus(v) ? v : '')}
          options={[
            { value: '', label: 'Anything' },
            ...CHANNEL_MESSAGE_STATUSES.map((s) => ({ value: s, label: MESSAGE_STATUS[s].text })),
          ]}
        />
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={reload}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading messages" /> : null}
      {items?.length === 0 ? (
        <p className="muted ws-flush">
          {filtered
            ? 'No message matches these filters.'
            : 'No messages yet. Each message in or out of this channel is listed here.'}
        </p>
      ) : null}
      {items?.length ? (
        <ol className="ws-list" aria-label={`Messages of ${binding.label}, newest first`}>
          {items.map((m) => {
            const why = messageReason(m);
            const who =
              m.direction === 'in'
                ? `From ${m.sender ?? 'an unknown sender'}`
                : `To ${m.conversation ?? binding.externalRef}`;
            return (
              <li key={m.id} className="ws-list-row ch-log-row" data-status={m.status}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <span className="ws-badge">
                      <Icon name={m.direction === 'in' ? 'down' : 'send'} />
                      {m.direction === 'in' ? 'Received' : 'Sent'}
                    </span>
                    {isFileRow(m) ? (
                      <span className="ws-badge">
                        <Icon name="attach" /> {FILE_BADGE}
                      </span>
                    ) : null}
                    <Chip spec={MESSAGE_STATUS[m.status]} />
                    <time className="muted" dateTime={m.createdAt}>
                      {formatStamp(m.createdAt)}
                    </time>
                  </span>
                  <span className="ch-log-who">{who}</span>
                  {why ? <span className="muted">{why}</span> : null}
                </div>
                {m.threadId ? (
                  <Button
                    variant="ghost"
                    aria-label={`Open the thread of this message from ${formatStamp(m.createdAt)}`}
                    onClick={() => navigate(chatPath(m.threadId))}
                  >
                    Open thread
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {olderError ? (
        <div role="alert" className="ws-error">
          <p>{olderError}</p>
          <Button onClick={() => void showOlder()}>Retry</Button>
        </div>
      ) : null}
      {items && items.length > 0 && cursor ? (
        <div className="row">
          <Button onClick={() => void showOlder()} disabled={loadingOlder}>
            {loadingOlder ? <Spinner /> : null} Show older
          </Button>
        </div>
      ) : null}
    </section>
  );
}
