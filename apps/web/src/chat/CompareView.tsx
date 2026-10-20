// Compare two chats side by side, read-only (FR-033): usually a chat and one of its branches.
import { useEffect, useState } from 'react';
import type { ThreadDetail } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { modelLabel, useModels } from '../stores.tsx';
import { MessageItem } from './MessageItem.tsx';
import { CHAT_TEXT } from './strings.ts';
import { threadTitle } from './ThreadList.tsx';

export const COMPARE_TEXT = defineMessages('chat.compare', {
  title: 'Compare chats',
  close: 'Close compare',
  first: 'First chat',
  second: 'Second chat',
  loading: 'Loading',
  loadingDots: 'Loading…',
  noMessages: 'No messages.',
});

type Side =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: ThreadDetail }
  | { kind: 'error'; message: string };

export function CompareView({ leftId, rightId }: { leftId: string; rightId: string }) {
  const { api } = useServices();
  const { models } = useModels();
  const [sides, setSides] = useState<{ key: string; left: Side; right: Side } | null>(null);
  const key = `${leftId}|${rightId}`;

  useEffect(() => {
    let alive = true;
    const load = (id: string): Promise<Side> =>
      api.getThread(id).then(
        (detail): Side => ({ kind: 'ready', detail }),
        (err: unknown): Side => ({
          kind: 'error',
          message:
            err instanceof ApiError && err.status === 404
              ? CHAT_TEXT.missing
              : errorMessage(err, CHAT_TEXT.loadFailed),
        }),
      );
    void Promise.all([load(leftId), load(rightId)]).then(([left, right]) => {
      if (alive) setSides({ key: `${leftId}|${rightId}`, left, right });
    });
    return () => {
      alive = false;
    };
  }, [api, leftId, rightId]);

  const current = sides?.key === key ? sides : null;
  const column = (side: Side | undefined, id: string, label: string) => (
    <section className="compare-col" aria-label={label}>
      {!side || side.kind === 'loading' ? (
        <p className="muted">
          <Spinner label={COMPARE_TEXT.loading} /> {COMPARE_TEXT.loadingDots}
        </p>
      ) : side.kind === 'error' ? (
        <p role="alert">{side.message}</p>
      ) : (
        <>
          <h2 className="compare-title" dir="auto">
            <a
              href={chatPath(id)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(chatPath(id));
              }}
            >
              {threadTitle(side.detail.thread)}
            </a>
          </h2>
          <div className="compare-log">
            {side.detail.messages.map((m) => (
              <MessageItem
                key={m.id}
                idPrefix={`cmp-${id}-`}
                message={m}
                streamed={undefined}
                reasoning={undefined}
                attachmentUrl={api.attachmentUrl}
                modelName={m.model ? modelLabel(models, m.model) : null}
                actions={null}
              />
            ))}
            {side.detail.messages.length === 0 ? (
              <p className="muted">{COMPARE_TEXT.noMessages}</p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );

  return (
    <section className="compare" aria-label={COMPARE_TEXT.title}>
      <header className="chat-header">
        <h1 className="chat-title">
          <Icon name="compare" /> {COMPARE_TEXT.title}
        </h1>
        <span className="chat-header-spacer" />
        <Button onClick={() => navigate(chatPath(leftId))}>{COMPARE_TEXT.close}</Button>
      </header>
      <div className="compare-cols">
        {column(current?.left, leftId, COMPARE_TEXT.first)}
        {column(current?.right, rightId, COMPARE_TEXT.second)}
      </div>
    </section>
  );
}
