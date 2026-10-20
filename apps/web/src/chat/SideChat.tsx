// Side chat (FR-026): a question about the open chat, answered with its context, in a child thread
// that adds nothing to the main chat. The first question creates the side thread; later ones are
// normal sends to it. The side thread outlives this panel until the main chat changes.
import { useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { modelLabel, useModels } from '../stores.tsx';
import { MessageItem } from './MessageItem.tsx';
import { isStreaming } from './thread-state.ts';
import { useThreadFeed } from './useThreadFeed.ts';

export const SIDE_CHAT_TEXT = defineMessages('chat.side', {
  title: 'Side chat',
  answered: 'Side chat answer complete.',
  failed: 'The side chat answer failed.',
  openChat: 'Open a chat to ask a side question about it.',
  notSent: 'Not sent: {reason} Your question is back in the box.',
  stopFailed: 'Could not stop: {reason}',
  note: 'Answers use this chat as context and add nothing to it.',
  log: 'Side chat messages',
  you: 'You',
  question: 'Side question',
  placeholder: 'Ask about this chat',
  stop: 'Stop',
  ask: 'Ask',
});

export interface SideChatProps {
  /** The main chat the questions are about; null when no chat is open. */
  parentId: string | null;
  /** The side thread for this chat, once one exists. */
  sideId: string | null;
  onSideId: (id: string) => void;
}

export function SideChat({ parentId, sideId, onSideId }: SideChatProps) {
  const { api } = useServices();
  const { models } = useModels();
  const toast = useToast();
  const announce = useAnnounce();
  const { state, refetch } = useThreadFeed(sideId, null, {
    onEvent: (env) => {
      if (env.name !== 'chat.message.completed') return;
      if (env.payload.status === 'complete') announce(SIDE_CHAT_TEXT.answered);
      else if (env.payload.status === 'error') announce(SIDE_CHAT_TEXT.failed);
    },
  });
  const [text, setText] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const streaming = isStreaming(state);

  if (!parentId) {
    return <p className="muted">{SIDE_CHAT_TEXT.openChat}</p>;
  }

  const ask = async () => {
    const q = text.trim();
    if (!q || asking !== null || streaming) return;
    setAsking(q);
    setError(null);
    setText('');
    try {
      if (sideId) {
        await api.sendMessage(sideId, { text: q });
        refetch();
      } else {
        const res = await api.sideChat(parentId, { text: q });
        onSideId(res.thread.id);
      }
    } catch (err) {
      setText((now) => now || q);
      setError(SIDE_CHAT_TEXT.notSent({ reason: errorMessage(err) }));
    } finally {
      setAsking(null);
    }
  };

  const stop = () => {
    if (!sideId) return;
    api.cancel(sideId).then(
      () => refetch(),
      (err: unknown) =>
        toast.show(SIDE_CHAT_TEXT.stopFailed({ reason: errorMessage(err) }), { tone: 'error' }),
    );
  };

  return (
    <section className="side-chat" aria-label={SIDE_CHAT_TEXT.title}>
      <p className="muted side-chat-note">{SIDE_CHAT_TEXT.note}</p>
      <div className="side-chat-log" role="log" aria-label={SIDE_CHAT_TEXT.log} aria-live="off">
        {state.messages.map((m) => (
          <MessageItem
            key={m.id}
            idPrefix="side-msg-"
            message={m}
            streamed={state.streamed[m.id]}
            reasoning={state.reasoning[m.id]}
            attachmentUrl={api.attachmentUrl}
            modelName={m.model ? modelLabel(models, m.model) : null}
            actions={null}
          />
        ))}
        {asking !== null && !state.messages.length ? (
          <article className="msg" data-role="user" aria-label={SIDE_CHAT_TEXT.you}>
            <p className="msg-text" dir="auto">
              {asking}
            </p>
          </article>
        ) : null}
        {state.status === 'error' ? (
          <p role="alert" className="composer-error">
            {state.loadError}
          </p>
        ) : null}
      </div>
      <form
        className="side-chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        {error ? (
          <p className="composer-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        ) : null}
        <label htmlFor="side-chat-input" className="nv-vh">
          {SIDE_CHAT_TEXT.question}
        </label>
        <textarea
          id="side-chat-input"
          ref={box}
          className="nv-input side-chat-input"
          rows={2}
          placeholder={SIDE_CHAT_TEXT.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div className="row">
          {streaming ? (
            <Button onClick={stop}>
              <Icon name="stop" /> {SIDE_CHAT_TEXT.stop}
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={!text.trim() || asking !== null || streaming}
          >
            {asking !== null ? <Spinner /> : null}
            {SIDE_CHAT_TEXT.ask}
          </Button>
        </div>
      </form>
    </section>
  );
}
