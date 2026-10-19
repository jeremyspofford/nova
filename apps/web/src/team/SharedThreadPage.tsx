// A shared chat (FR-217; `/team/shared/:threadId`): the conversation with who wrote each message
// and who asked for each reply, the people in it (the chat's owner adds people and takes them out;
// anyone else may leave), a composer whose messages run under the account of whoever writes, Stop
// for a running reply (any participant may stop it), and the approvals that wait on you. Nobody's
// memory or connectors are used here, and the page says so. The conversation follows the shared
// thread's own stream; someone taken out of the chat stops hearing it and the page says why.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  EventEnvelope,
  MessageView,
  SharedAuthorView,
  SharedThreadDetailView,
} from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, StatusChip, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { ApprovalCard } from '../chat/ApprovalCard.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import type { ClientApproval } from '../chat/thread-state.ts';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { openStream } from '../sse.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import { SHARED_THREAD_EVENTS } from './events.ts';
import { personName, sharedThreadPath, teamErrorMessage } from './format.ts';
import { ConfirmDialog, FormError } from './parts.tsx';
import { ShareDialog } from './ShareDialog.tsx';
import '../workspace.css';
import './team.css';

const RUNNING = new Set(['streaming', 'waiting_approval', 'waiting_input']);

/** The text of a message, for people's messages (plain text) and replies (Markdown). */
export function messageBody(m: MessageView): string {
  return m.parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'error' ? p.message : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** "Sam wrote", "Nova, asked by Sam"; "you" for the reader. */
export function authorLine(
  m: Pick<MessageView, 'role'>,
  a: SharedAuthorView | undefined,
  you: string | null,
): string {
  const who = a ? (a.accountId === you ? 'you' : personName(a, 'someone')) : null;
  if (m.role === 'user') return who ? (who === 'you' ? 'You' : who) : 'Someone';
  if (m.role === 'assistant') return who ? `Nova, asked by ${who}` : 'Nova';
  return 'Nova';
}

function Breadcrumb() {
  const path = sharedThreadPath(null);
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
      <a href={path} onClick={(e) => followLink(e, path)}>
        <Icon name="back" /> Shared chats
      </a>
    </nav>
  );
}

export function SharedThreadPage({ threadId }: { threadId: string }) {
  const api = useTeamApi();
  const { api: hub, eventSource } = useServices();
  const toast = useToast();
  const announce = useAnnounce();
  const settings = useSettings();
  const enterSends = settings.get('general.enterToSend').value === 'enter';
  const [detail, setDetail] = useState<SharedThreadDetailView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [streamed, setStreamed] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [approvals, setApprovals] = useState<ClientApproval[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [stopping, setStopping] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [removing, setRemoving] = useState<{ accountId: string; name: string } | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const formId = useId();
  const peopleId = useId();

  const load = useCallback(() => {
    api.getSharedThread(threadId).then(
      (d) => {
        setDetail(d);
        setLoadError(null);
        setRunning(RUNNING.has(d.thread.state) || d.thread.derived?.status === 'running');
        // Streamed text stays until the Hub has the finished message.
        const streaming = new Set(
          d.messages.filter((m) => m.status === 'streaming').map((m) => m.id),
        );
        setStreamed((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([mid]) => streaming.has(mid))),
        );
      },
      (err: unknown) => {
        setLoadError(err);
        // Taken out of the chat, or it was deleted: what was shown is no longer theirs to see.
        if (err instanceof ApiError && err.status === 404) setDetail(null);
      },
    );
  }, [api, threadId]);
  const refetch = useDebounced(load, 40);

  const listApprovals = useCallback(() => {
    hub.listApprovals({ status: 'pending', threadId }).then(
      ({ items }) => setApprovals(items),
      () => undefined,
    );
  }, [hub, threadId]);

  useEffect(() => {
    load();
    listApprovals();
  }, [load, listApprovals, attempt]);

  // Who "you" is: the account the Hub names as the owner or a participant of this view.
  useEffect(() => {
    let alive = true;
    api.getTeamMe().then(
      (m) => alive && setYou(m.accountId),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const onEvent = useCallback(
    (env: EventEnvelope) => {
      const p = env.payload;
      switch (env.name) {
        case 'turn.started':
          setRunning(true);
          break;
        case 'chat.delta':
          if (
            p.type === 'text_delta' &&
            typeof p.messageId === 'string' &&
            typeof p.text === 'string'
          ) {
            const id = p.messageId;
            const chunk = p.text;
            setStreamed((s) => ({ ...s, [id]: (s[id] ?? '') + chunk }));
          }
          break;
        case 'turn.completed':
        case 'turn.interrupted':
          setRunning(false);
          refetch();
          break;
        case 'approval.requested':
          if (typeof p.approvalId === 'string')
            hub.getApproval(p.approvalId).then(
              (a) => setApprovals((prev) => [...prev.filter((x) => x.id !== a.id), a]),
              () => listApprovals(),
            );
          break;
        case 'approval.decided':
          listApprovals();
          break;
        default:
          refetch();
      }
    },
    [hub, listApprovals, refetch],
  );
  const onEventRef = useRef(onEvent);
  useLayoutEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    let opened = false;
    const handle = openStream(
      api.sharedThreadStreamUrl(threadId),
      {
        onEvent: (e) => onEventRef.current(e),
        onOpen: () => {
          // Anything said between the load and the connection is fetched once it is open.
          if (opened) return;
          opened = true;
          refetch();
        },
      },
      { names: SHARED_THREAD_EVENTS, factory: eventSource },
    );
    return () => handle.close();
  }, [api, eventSource, threadId, refetch]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const out = await api.sendSharedMessage(threadId, { text: body });
      setText('');
      if (out.disposition === 'queued')
        toast.show('Queued: it is sent when the current reply ends.', { tone: 'info' });
      else setRunning(true);
      refetch();
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await api.cancelSharedThread(threadId);
      announce('Stopped.');
    } catch (err) {
      toast.show(teamErrorMessage(err, 'Could not stop the reply.'), { tone: 'error' });
    } finally {
      setStopping(false);
    }
  };

  if (!detail) {
    const gone = loadError instanceof ApiError && loadError.status === 404;
    return (
      <div className="ws-page team-page">
        <Breadcrumb />
        {loadError ? (
          gone ? (
            <EmptyState
              icon="chat"
              title="This chat is not shared with you"
              description="It was never shared with you, its owner took you out, or it was deleted."
            />
          ) : (
            <div role="alert" className="ws-error">
              <p>{teamErrorMessage(loadError, 'Could not load this chat.')}</p>
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            </div>
          )
        ) : (
          <Spinner label="Loading the chat" />
        )}
      </div>
    );
  }

  const owner = detail.you === 'owner';
  const title = detail.thread.title?.trim() || 'Untitled chat';
  const messages = detail.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const mine = approvals.filter((a) => a.status === 'pending');

  return (
    <div className="ws-page team-page team-thread">
      <Breadcrumb />
      <header className="ws-page-header">
        <h1>{title}</h1>
        {detail.thread.derived ? (
          <StatusChip
            status={detail.thread.derived.status}
            reason={detail.thread.derived.reason ?? undefined}
          />
        ) : null}
      </header>
      <p className="muted ws-flush">
        {owner
          ? `You share this chat. Shared ${formatWhen(detail.sharedAt)}.`
          : `${personName(detail.owner)} shares this chat with you.`}{' '}
        Nobody’s memory or connectors are used here, and each message runs as the person who wrote
        it.
      </p>

      <section className="ws-section team-people" aria-labelledby={peopleId}>
        <div className="ws-section-header">
          <h2 id={peopleId}>People in this chat</h2>
          {owner ? (
            <Button onClick={() => setSharing(true)}>
              <Icon name="plus" /> Add people
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setLeaving(true)}>
              Leave this chat
            </Button>
          )}
        </div>
        <ul className="team-chips" aria-label="People in this chat">
          <li className="ws-badge">
            {personName(detail.owner)}
            {detail.owner.accountId === you ? ' (you)' : ''}, started it
          </li>
          {detail.participants.map((p) => (
            <li key={p.accountId} className="ws-badge">
              {personName(p)}
              {p.accountId === you ? ' (you)' : ''}
              {owner ? (
                <button
                  type="button"
                  className="team-chip-x"
                  aria-label={`Take ${personName(p)} out of this chat`}
                  onClick={() => setRemoving({ accountId: p.accountId, name: personName(p) })}
                >
                  <Icon name="close" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <ol
        className="team-messages"
        aria-label="Messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.length === 0 ? (
          <li className="muted">Nothing has been said yet. Write the first message below.</li>
        ) : null}
        {messages.map((m) => {
          const author = detail.authors[m.id];
          const body = streamed[m.id] ?? messageBody(m);
          return (
            <li key={m.id} className="team-msg" data-role={m.role}>
              <p className="team-msg-author">
                <span className="team-strong">{authorLine(m, author, you)}</span>{' '}
                <span className="muted">{formatWhen(m.createdAt)}</span>
              </p>
              {m.role === 'assistant' ? (
                body ? (
                  <div className="team-msg-body">
                    <Markdown text={body} />
                  </div>
                ) : m.status === 'streaming' || streamed[m.id] !== undefined ? (
                  <Spinner label="Writing" />
                ) : (
                  <p className="muted ws-flush">No text in this reply.</p>
                )
              ) : (
                <p className="team-msg-body team-pre">{body}</p>
              )}
            </li>
          );
        })}
      </ol>

      {mine.length ? (
        <section className="stack" aria-label="Waiting for your decision">
          {mine.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              onChange={(next) =>
                setApprovals((prev) => prev.map((x) => (x.id === next.id ? next : x)))
              }
            />
          ))}
        </section>
      ) : null}

      <form
        className="team-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label id={`${formId}-l`} htmlFor={`${formId}-t`} className="nv-field-label">
          Message everyone in this chat
        </label>
        <textarea
          id={`${formId}-t`}
          className="nv-input ws-textarea"
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            if (!enterSends && !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            void send();
          }}
        />
        <div className="row team-actions">
          {running ? (
            <Button onClick={() => void stop()} disabled={stopping}>
              {stopping ? <Spinner /> : <Icon name="stop" />} Stop
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={sending || !text.trim()}>
            {sending ? <Spinner /> : <Icon name="send" />} Send
          </Button>
        </div>
        <FormError error={sendError} fallback="Could not send the message." />
      </form>

      {sharing ? (
        <ShareDialog
          thread={detail.thread}
          onClose={() => {
            setSharing(false);
            refetch();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={leaving}
        title="Leave this chat?"
        description={`You stop seeing it. ${personName(detail.owner)} can share it with you again.`}
        confirmLabel="Leave"
        danger
        onClose={() => setLeaving(false)}
        onConfirm={async () => {
          const self = you ?? (await api.getTeamMe()).accountId;
          await api.unshareThread(threadId, self);
          setLeaving(false);
          toast.show('You left the chat.', { tone: 'success' });
          navigate(sharedThreadPath(null));
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Take ${removing?.name ?? 'them'} out of this chat?`}
        description="They stop seeing it at once, including what was said before. You can share it with them again."
        confirmLabel="Take out"
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await api.unshareThread(threadId, removing.accountId);
          setRemoving(null);
          refetch();
        }}
      />
    </div>
  );
}
