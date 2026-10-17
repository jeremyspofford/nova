// One chat (FR-017, FR-018, FR-021, FR-023, FR-024): loads the thread, follows its event stream,
// renders Markdown replies as they stream, and owns the composer. A send never loses the user's
// input: on any failure the text and attachments go back into the composer with the reason.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type {
  ChatDeltaPayload,
  ChatMessageCompletedPayload,
  EventEnvelope,
  MessageView,
  REASONING_LEVELS,
} from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, StatusChip, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useAnnounce, useServices, type Draft, type PendingAttachment } from '../services.tsx';
import { useSetting, useSettings } from '../settings.tsx';
import { THREAD_EVENTS, openStream } from '../sse.ts';
import { modelLabel, useModels, useThreads } from '../stores.tsx';
import { readAsBase64 } from './attachments.ts';
import { Composer, useAttachmentIntake } from './Composer.tsx';
import { Markdown } from './Markdown.tsx';
import {
  initialThreadState,
  isStreaming,
  messageText,
  threadReducer,
  type ClientMessage,
} from './thread-state.ts';
import { threadStatus } from './status.ts';

const EMPTY_DRAFT: Draft = { text: '', attachments: [] };

export interface ChatViewProps {
  threadId: string | null;
  /** Message to scroll to and highlight (from search). */
  messageId?: string | null;
  /** False while another mode or page is shown; the view stays mounted to keep its state. */
  active: boolean;
  /** Minimum gap between streaming progress announcements. */
  announceEveryMs?: number;
  /** Lets the app run "Stop generation" and "Focus composer" against this view. */
  onControls?: (c: ChatControls | null) => void;
}

export interface ChatControls {
  streaming: boolean;
  stop: () => void;
  focusComposer: () => void;
}

let tempSeq = 0;

export function ChatView({
  threadId,
  messageId,
  active,
  announceEveryMs = 4000,
  onControls,
}: ChatViewProps) {
  const { api, eventSource, registry, memory } = useServices();
  const threads = useThreads();
  const { models } = useModels();
  const settings = useSettings();
  const enterToSend = useSetting('general.enterToSend').value;
  const defaultModel = useSetting('chat.defaultModel').value;
  const announce = useAnnounce();
  const toast = useToast();
  const known = threadId ? (threads.threads.find((t) => t.id === threadId) ?? null) : null;
  const [state, dispatch] = useReducer(threadReducer, known, initialThreadState);
  const [draft, setDraftState] = useState<Draft>(
    () => memory.drafts.get(threadId ?? 'new') ?? EMPTY_DRAFT,
  );
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftReasoning, setDraftReasoning] = useState<ReasoningLevel | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progress = useRef({ last: 0, words: 0 });

  const setDraft = useCallback(
    (d: Draft) => {
      memory.drafts.set(threadId ?? 'new', d);
      setDraftState(d);
    },
    [memory, threadId],
  );
  const intake = useAttachmentIntake(draft, setDraft);
  const streaming = isStreaming(state);
  const thread = state.thread;

  // ---- loading and refetching ------------------------------------------------------------------

  const refetch = useCallback(() => {
    if (!threadId) return;
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      api.getThread(threadId).then(
        (detail) => {
          dispatch({ type: 'loaded', detail });
          threads.upsertLocal(detail.thread);
        },
        () => undefined,
      );
    }, 40);
  }, [api, threadId, threads]);

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    api.getThread(threadId).then(
      (detail) => {
        if (!alive) return;
        dispatch({ type: 'loaded', detail });
        if (detail.thread.unread) {
          threads.update(threadId, { unread: false }).catch(() => undefined);
        }
      },
      (err: unknown) => {
        if (!alive) return;
        dispatch({
          type: 'load_failed',
          message:
            err instanceof ApiError && err.status === 404
              ? 'This chat was deleted or does not exist.'
              : errorMessage(err, 'Could not load this chat.'),
        });
      },
    );
    return () => {
      alive = false;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
    // Only a different thread reloads; the threads store changes on every list update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, threadId]);

  // ---- the event stream ------------------------------------------------------------------------

  const onEvent = useCallback(
    (env: EventEnvelope) => {
      const p = env.payload;
      // The stream is per thread; anything else is ignored rather than mixed in.
      const about =
        env.correlation?.threadId ?? (typeof p.threadId === 'string' ? p.threadId : null);
      if (about && about !== threadId) return;
      switch (env.name) {
        case 'turn.started':
          dispatch({ type: 'turn', running: true });
          progress.current = { last: Date.now(), words: 0 };
          announce('Assistant is responding.');
          if (threadId) threads.upsertLocal({ id: threadId, state: 'streaming' });
          break;
        case 'turn.completed':
        case 'turn.interrupted':
          dispatch({ type: 'turn', running: false });
          if (threadId) threads.upsertLocal({ id: threadId, state: 'idle' });
          refetch();
          break;
        case 'chat.message.created':
          dispatch({
            type: 'created',
            messageId: String(p.messageId),
            role: p.role as MessageView['role'],
            turnId: typeof p.turnId === 'string' ? p.turnId : null,
          });
          break;
        case 'chat.delta': {
          const d = p as unknown as ChatDeltaPayload;
          dispatch({ type: 'delta', payload: d });
          if (d.type === 'text_delta') {
            // Throttled progress for screen readers (docs/04 §4.4): never every token.
            const pr = progress.current;
            pr.words += d.text.split(/\s+/).filter(Boolean).length;
            const now = Date.now();
            if (now - pr.last >= announceEveryMs) {
              pr.last = now;
              announce(`Still responding, about ${pr.words} words so far.`);
            }
          }
          break;
        }
        case 'chat.message.completed': {
          const c = p as unknown as ChatMessageCompletedPayload;
          dispatch({ type: 'completed', payload: c });
          if (c.status === 'complete') announce('Response complete.');
          else if (c.status === 'incomplete')
            announce('Response stopped. The partial reply is kept.');
          else if (c.status === 'error') announce('The response failed. Retry is available.');
          refetch();
          break;
        }
        case 'chat.message.updated':
          refetch();
          break;
        default:
          break;
      }
    },
    [announce, announceEveryMs, refetch, threadId, threads],
  );
  const onEventRef = useRef(onEvent);
  useLayoutEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (!threadId) return;
    const handle = openStream(
      api.threadStreamUrl(threadId),
      { onEvent: (e) => onEventRef.current(e) },
      { names: THREAD_EVENTS, factory: eventSource },
    );
    return () => handle.close();
  }, [api, eventSource, threadId]);

  // ---- sending -----------------------------------------------------------------------------------

  const model = thread?.model ?? draftModel ?? defaultModel ?? models[0]?.ref ?? null;
  const reasoningLevel = thread?.reasoningLevel ?? draftReasoning;

  const restore = useCallback(
    (d: Draft, reason: string) => {
      // Put the text back unless the user already started typing something new.
      const current = memory.drafts.get(threadId ?? 'new') ?? EMPTY_DRAFT;
      if (!current.text && current.attachments.length === 0) setDraft(d);
      setSendError(reason);
    },
    [memory, setDraft, threadId],
  );

  const sendTo = useCallback(
    async (id: string, d: Draft) => {
      const tempId = `local-${++tempSeq}`;
      dispatch({
        type: 'optimistic',
        message: {
          id: tempId,
          threadId: id,
          turnId: null,
          role: 'user',
          status: 'complete',
          parts: [
            ...(d.text ? [{ type: 'text' as const, text: d.text }] : []),
            ...d.attachments.map((a) => ({
              type: 'file' as const,
              attachmentId: '',
              name: a.name,
              mime: a.mime,
              size: a.size,
            })),
          ],
          model: null,
          usage: null,
          createdAt: new Date().toISOString(),
          local: true,
        },
      });
      stick.current = true;
      try {
        const res = await api.sendMessage(id, {
          text: d.text,
          attachments: d.attachments.length
            ? d.attachments.map((a) => ({ name: a.name, mime: a.mime, data: a.data }))
            : undefined,
        });
        dispatch({ type: 'accepted', tempId, res });
        threads.upsertLocal({ id, state: 'streaming', updatedAt: new Date().toISOString() });
      } catch (err) {
        dispatch({ type: 'send_failed', tempId });
        restore(
          d,
          err instanceof ApiError && err.status === 409
            ? 'A reply is still running in this chat. Stop it or wait, then send again. Your message is back in the box.'
            : `Message not sent: ${errorMessage(err)} Your message is back in the box.`,
        );
      }
    },
    [api, restore, threads],
  );

  // A first message queued by "new chat" or onboarding is sent once this chat opens.
  useEffect(() => {
    if (!threadId) return;
    const queued = memory.pending.get(threadId);
    if (!queued) return;
    memory.pending.delete(threadId);
    // Sent exactly once when the chat opens; its optimistic bubble should render right away.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sendTo(threadId, queued);
  }, [memory, sendTo, threadId]);

  const send = async (d: Draft) => {
    setSendError(null);
    intake.clearErrors();
    setDraft(EMPTY_DRAFT);
    if (threadId) {
      await sendTo(threadId, d);
      return;
    }
    try {
      const created = await api.createThread({
        mode: 'chat',
        title: titleFrom(d),
        model: model ?? undefined,
        reasoningLevel: draftReasoning ?? undefined,
      });
      memory.pending.set(created.id, d);
      threads.upsertLocal(created);
      memory.drafts.delete('new');
      navigate(chatPath(created.id));
    } catch (err) {
      restore(d, `Could not start the chat: ${errorMessage(err)} Your message is back in the box.`);
    }
  };

  const stop = useCallback(() => {
    if (!threadId || stopping) return;
    setStopping(true);
    api
      .cancel(threadId)
      .then(
        () => refetch(),
        (err: unknown) => toast.show(`Could not stop: ${errorMessage(err)}`, { tone: 'error' }),
      )
      .finally(() => setStopping(false));
  }, [api, refetch, stopping, threadId, toast]);

  const retry = async (failed: ClientMessage) => {
    if (!threadId) return;
    const idx = state.messages.indexOf(failed);
    const lastUser = state.messages
      .slice(0, idx < 0 ? undefined : idx)
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUser) return;
    try {
      const attachments: PendingAttachment[] = [];
      for (const p of lastUser.parts) {
        if (p.type !== 'file' || !p.attachmentId) continue;
        const blob = await api.fetchAttachment(p.attachmentId);
        attachments.push({
          id: p.attachmentId,
          name: p.name,
          mime: p.mime,
          size: p.size,
          data: await readAsBase64(blob),
        });
      }
      await sendTo(threadId, { text: messageText(lastUser, undefined), attachments });
    } catch (err) {
      toast.show(`Retry failed: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const changeModel = (ref: string) => {
    if (!threadId || !thread) {
      setDraftModel(ref);
      return;
    }
    const before = thread;
    dispatch({ type: 'thread', thread: { ...thread, model: ref } });
    threads.update(threadId, { model: ref }).then(
      (view) => dispatch({ type: 'thread', thread: view }),
      (err: unknown) => {
        dispatch({ type: 'thread', thread: before });
        toast.show(`Could not change the model: ${errorMessage(err)}`, { tone: 'error' });
      },
    );
  };

  const changeReasoning = (level: ReasoningLevel) => {
    if (!threadId || !thread) {
      setDraftReasoning(level);
      return;
    }
    dispatch({ type: 'thread', thread: { ...thread, reasoningLevel: level } });
    threads.update(threadId, { reasoningLevel: level }).then(
      (view) => dispatch({ type: 'thread', thread: view }),
      (err: unknown) =>
        toast.show(`Could not change the reasoning level: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  // ---- controls for global commands --------------------------------------------------------------

  const focusComposer = useCallback(() => input.current?.focus(), []);
  useEffect(() => {
    if (!active || !onControls) return;
    onControls({ streaming, stop, focusComposer });
  }, [active, onControls, streaming, stop, focusComposer]);
  useEffect(() => {
    if (!onControls) return;
    return () => onControls(null);
  }, [onControls]);

  // ---- scrolling ---------------------------------------------------------------------------------

  const scrollKey = threadId ?? 'new';
  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !active) return;
    const saved = memory.scroll.get(scrollKey);
    if (saved !== undefined) el.scrollTop = saved;
  }, [active, memory, scrollKey]);

  const lastText = state.messages.length
    ? (state.streamed[state.messages.at(-1)!.id]?.length ?? 0)
    : 0;
  useLayoutEffect(() => {
    const el = log.current;
    if (el && active && stick.current) el.scrollTop = el.scrollHeight;
  }, [active, state.messages.length, lastText]);

  useEffect(() => {
    if (!messageId || state.status !== 'ready') return;
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView?.({ block: 'center' });
    el.focus();
    const on = setTimeout(() => setHighlight(messageId), 0);
    const off = setTimeout(() => setHighlight(null), 2500);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, [messageId, state.status]);

  // ---- render ------------------------------------------------------------------------------------

  const title = thread?.title || (threadId ? 'Untitled chat' : 'New chat');
  const status = thread ? threadStatus(thread, streaming) : null;
  const noModel = models.length === 0;

  return (
    <section
      className="chat"
      aria-label={title}
      data-chat-view
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        void intake.addFiles(files);
      }}
    >
      <header className="chat-header">
        <h1 className="chat-title">{title}</h1>
        {status ? <StatusChip status={status} /> : null}
        {thread?.model ? (
          <span className="muted chat-model">{modelLabel(models, thread.model)}</span>
        ) : null}
      </header>
      <div
        ref={log}
        className="chat-log"
        role="log"
        aria-label="Messages"
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          memory.scroll.set(scrollKey, el.scrollTop);
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {state.status === 'loading' ? (
          <p className="muted chat-loading">
            <Spinner label="Loading messages" /> Loading messages…
          </p>
        ) : null}
        {state.status === 'error' ? (
          <div className="chat-error" role="alert">
            <p>{state.loadError}</p>
            <Button onClick={() => navigate(chatPath(null))}>Start a new chat</Button>
          </div>
        ) : null}
        {state.status === 'ready' && state.messages.length === 0 ? (
          <EmptyState
            title={threadId ? 'No messages yet' : 'Start a conversation'}
            description={
              noModel
                ? 'Connect a model provider in Settings → Accounts to start chatting.'
                : 'Ask a question, paste text to work on, or attach a file.'
            }
            icon="chat"
            action={
              noModel ? (
                <Button onClick={() => navigate('/settings/accounts')}>Connect a provider</Button>
              ) : undefined
            }
          />
        ) : null}
        {state.messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            streamed={state.streamed[m.id]}
            reasoning={state.reasoning[m.id]}
            highlighted={highlight === m.id}
            attachmentUrl={api.attachmentUrl}
            onRetry={() => void retry(m)}
            retryDisabled={streaming}
          />
        ))}
      </div>
      <Composer
        draft={draft}
        onDraftChange={(d) => {
          setDraft(d);
          if (sendError) setSendError(null);
        }}
        onSend={(d) => void send(d)}
        onStop={stop}
        streaming={streaming}
        stopping={stopping}
        enterToSend={enterToSend}
        mac={registry.platform.mac}
        sendError={sendError}
        attachmentErrors={intake.errors}
        onAddFiles={(f) => void intake.addFiles(f)}
        onDismissAttachmentErrors={intake.clearErrors}
        models={models}
        model={model}
        onModelChange={changeModel}
        reasoningLevel={reasoningLevel}
        onReasoningChange={changeReasoning}
        inputRef={input}
        noModelHint={noModel ? 'Connect a model provider to start' : undefined}
      />
      {!threadId && defaultModel === null && models[0] && model === models[0].ref ? (
        <p className="muted composer-note">
          Using {models[0].label}.{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              settings.set('chat.defaultModel', models[0]!.ref).catch(() => undefined);
            }}
          >
            Make it the default
          </button>
        </p>
      ) : null}
    </section>
  );
}

type ReasoningLevel = (typeof REASONING_LEVELS)[number];

function titleFrom(d: Draft): string | undefined {
  const line = d.text.trim().split('\n')[0]?.trim() ?? '';
  if (line) return line.length > 60 ? `${line.slice(0, 57)}…` : line;
  return d.attachments[0]?.name;
}

function MessageItem({
  message: m,
  streamed,
  reasoning,
  highlighted,
  attachmentUrl,
  onRetry,
  retryDisabled,
}: {
  message: ClientMessage;
  streamed: string | undefined;
  reasoning: string | undefined;
  highlighted: boolean;
  attachmentUrl: (id: string) => string;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const text = messageText(m, streamed);
  const storedReasoning = m.parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => (p.type === 'reasoning' ? p.text : ''))
    .join('');
  const thinking = reasoning ?? storedReasoning;
  const files = m.parts.filter((p) => p.type === 'file');
  const errors = m.parts.filter((p) => p.type === 'error');
  const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : m.role;
  return (
    <article
      id={`msg-${m.id}`}
      className="msg"
      data-role={m.role}
      data-status={m.status}
      data-highlight={highlighted || undefined}
      aria-label={`${who}${m.status === 'incomplete' ? ', stopped' : ''}`}
      tabIndex={-1}
    >
      <div className="msg-meta">
        <span className="msg-who">{who}</span>
        {m.status === 'incomplete' ? (
          <span className="msg-badge" data-kind="stopped">
            <Icon name="stop" /> Stopped
          </span>
        ) : null}
        {m.status === 'streaming' ? <Spinner label="Responding" /> : null}
      </div>
      {thinking ? (
        <details className="msg-reasoning">
          <summary>Reasoning</summary>
          <p>{thinking}</p>
        </details>
      ) : null}
      {text ? (
        m.role === 'assistant' ? (
          <Markdown text={text} />
        ) : (
          <p className="msg-text">{text}</p>
        )
      ) : null}
      {files.length ? (
        <ul className="chips" aria-label="Attached files">
          {files.map((f, i) =>
            f.type === 'file' ? (
              <li key={`${f.attachmentId}-${i}`} className="chip">
                <Icon name="file" />
                {f.attachmentId ? (
                  <a href={attachmentUrl(f.attachmentId)} target="_blank" rel="noopener noreferrer">
                    {f.name}
                  </a>
                ) : (
                  <span>{f.name}</span>
                )}
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      {errors.map((e, i) =>
        e.type === 'error' ? (
          <div key={i} className="msg-error" role="alert">
            <Icon name="alert" />
            <span>
              {e.message || 'The reply failed.'} <span className="muted">({e.code})</span>
            </span>
            <Button onClick={onRetry} disabled={retryDisabled}>
              Retry
            </Button>
          </div>
        ) : null,
      )}
      {m.status === 'error' && errors.length === 0 ? (
        <div className="msg-error" role="alert">
          <Icon name="alert" />
          <span>The reply failed.</span>
          <Button onClick={onRetry} disabled={retryDisabled}>
            Retry
          </Button>
        </div>
      ) : null}
    </article>
  );
}
