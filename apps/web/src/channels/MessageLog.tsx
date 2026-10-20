// A channel's message log (FR-110, the M6 known gap; docs/13 §4): every message in and out of one
// binding, newest first, with what happened to it (started a turn, answered, ignored, dropped,
// sent, failed, held back) and why, in plain words. The log keeps no text: the messages are in the
// channel's thread, linked from each row. Senders and conversation names come from the other
// service: shown as text. Filters by direction and status; "Show older" pages back. Live through
// the channel's message events. Pages follow the Hub's `nextCursor`, so messages that share a
// timestamp are never skipped. M8: an entry lists its files (a file received and kept with the
// chat or refused, one the agent sent, held back or that failed) by name, size and state, with why
// in plain words; a file the agent sent with its reply is its own row.
import { useCallback, useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import {
  CHANNEL_MESSAGE_STATUSES,
  type ChannelBindingViewM7,
  type ChannelMessageFileView,
  type ChannelMessageStatus,
  type ChannelMessageView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useChannelsM7Api } from './api-m7.ts';
import { useChannelEvents, useDebouncedCallback } from './events.ts';
import {
  FILE_TEXT,
  MESSAGE_STATUS,
  entryFiles,
  fileReason,
  fileSize,
  fileStatus,
  formatStamp,
  isFileRow,
  messageReason,
} from './format.ts';
import { Chip } from './parts.tsx';

/** The message log's words (FR-016). Senders, conversations and file names are data. */
export const LOG_TEXT = defineMessages('channels.log', {
  title: 'Messages',
  refreshLabel: 'Refresh the messages of {name}',
  refresh: 'Refresh',
  intro:
    'What came in and went out, and what Nova did with it. The text itself is in the channel’s thread.',
  direction: 'Direction',
  both: 'In and out',
  received: 'Received',
  sent: 'Sent',
  status: 'What happened',
  anything: 'Anything',
  loadFailed: 'Could not load the messages.',
  olderFailed: 'Could not load older messages.',
  retry: 'Retry',
  loading: 'Loading messages',
  noMatch: 'No message matches these filters.',
  empty: 'No messages yet. Each message in or out of this channel is listed here.',
  list: 'Messages of {name}, newest first',
  from: 'From {sender}',
  fromUnknown: 'From an unknown sender',
  to: 'To {conversation}',
  openThreadLabel: 'Open the thread of this message from {when}',
  openThread: 'Open thread',
  older: 'Show older',
});

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
        (err: unknown) => alive && setError(errorMessage(err, LOG_TEXT.loadFailed)),
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
      setOlderError(errorMessage(err, LOG_TEXT.olderFailed));
    } finally {
      setLoadingOlder(false);
    }
  };

  const filtered = direction !== '' || status !== '';
  const S = LOG_TEXT;
  return (
    <section className="ch-log" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h4 id={headingId} className="ws-subhead">
          {S.title}
        </h4>
        <Button
          variant="ghost"
          onClick={reload}
          aria-label={S.refreshLabel({ name: binding.label })}
        >
          <Icon name="refresh" /> {S.refresh}
        </Button>
      </div>
      <p className="muted ws-flush">{S.intro}</p>
      <div className="ws-toolbar ch-log-filters">
        <SelectField
          label={S.direction}
          value={direction}
          onChange={(v) => setDirection(v === 'in' || v === 'out' ? v : '')}
          options={[
            { value: '', label: S.both },
            { value: 'in', label: S.received },
            { value: 'out', label: S.sent },
          ]}
        />
        <SelectField
          label={S.status}
          value={status}
          onChange={(v) => setStatus(isStatus(v) ? v : '')}
          options={[
            { value: '', label: S.anything },
            ...CHANNEL_MESSAGE_STATUSES.map((s) => ({ value: s, label: MESSAGE_STATUS[s].text })),
          ]}
        />
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={reload}>{S.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <p className="muted ws-flush">{filtered ? S.noMatch : S.empty}</p>
      ) : null}
      {items?.length ? (
        <ol className="ws-list" aria-label={S.list({ name: binding.label })}>
          {items.map((m) => {
            const why = messageReason(m);
            const files = entryFiles(m);
            const who =
              m.direction === 'in'
                ? m.sender
                  ? S.from({ sender: m.sender })
                  : S.fromUnknown
                : S.to({ conversation: m.conversation ?? binding.externalRef });
            return (
              <li key={m.id} className="ws-list-row ch-log-row" data-status={m.status}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <span className="ws-badge">
                      <Icon name={m.direction === 'in' ? 'down' : 'send'} />
                      {m.direction === 'in' ? S.received : S.sent}
                    </span>
                    {isFileRow(m) && files.length === 0 ? (
                      <span className="ws-badge">
                        <Icon name="attach" /> {FILE_TEXT.badge}
                      </span>
                    ) : null}
                    <Chip spec={MESSAGE_STATUS[m.status]} />
                    <time className="muted" dateTime={m.createdAt}>
                      {formatStamp(m.createdAt)}
                    </time>
                  </span>
                  <span className="ch-log-who">{who}</span>
                  {why ? <span className="muted">{why}</span> : null}
                  {files.length ? <EntryFiles files={files} rowReason={why} /> : null}
                </div>
                {m.threadId ? (
                  <Button
                    variant="ghost"
                    aria-label={S.openThreadLabel({ when: formatStamp(m.createdAt) })}
                    onClick={() => navigate(chatPath(m.threadId))}
                  >
                    {S.openThread}
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
          <Button onClick={() => void showOlder()}>{S.retry}</Button>
        </div>
      ) : null}
      {items && items.length > 0 && cursor ? (
        <div className="row">
          <Button onClick={() => void showOlder()} disabled={loadingOlder}>
            {loadingOlder ? <Spinner /> : null} {S.older}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** The files of a log entry: name, size, what happened to it and why (never its content). */
function EntryFiles({
  files,
  rowReason,
}: {
  files: ChannelMessageFileView[];
  rowReason: string | null;
}) {
  return (
    <ul className="ch-log-files" aria-label={FILE_TEXT.listLabel({ n: files.length })}>
      {files.map((f, i) => {
        // Said once: the entry's own reason may already say why (a held-back file's row).
        const reason = fileReason(f);
        return (
          <li key={`${i}:${f.name}`} className="ch-log-file">
            <Icon name="attach" />
            <span className="ch-log-file-name" dir="auto">
              {f.name}
            </span>
            <span className="muted">{fileSize(f.size)}</span>
            <Chip spec={fileStatus(f)} />
            {reason && reason !== rowReason ? <span className="muted">{reason}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
