// Compare two chats side by side, read-only (FR-033): usually a chat and one of its branches.
import { useEffect, useState } from 'react';
import type { ThreadDetail } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { modelLabel, useModels } from '../stores.tsx';
import { MessageItem } from './MessageItem.tsx';
import { threadTitle } from './ThreadList.tsx';

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
              ? 'This chat was deleted or does not exist.'
              : errorMessage(err, 'Could not load this chat.'),
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
          <Spinner label="Loading" /> Loading…
        </p>
      ) : side.kind === 'error' ? (
        <p role="alert">{side.message}</p>
      ) : (
        <>
          <h2 className="compare-title">
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
            {side.detail.messages.length === 0 ? <p className="muted">No messages.</p> : null}
          </div>
        </>
      )}
    </section>
  );

  return (
    <section className="compare" aria-label="Compare chats">
      <header className="chat-header">
        <h1 className="chat-title">
          <Icon name="compare" /> Compare chats
        </h1>
        <span className="chat-header-spacer" />
        <Button onClick={() => navigate(chatPath(leftId))}>Close compare</Button>
      </header>
      <div className="compare-cols">
        {column(current?.left, leftId, 'First chat')}
        {column(current?.right, rightId, 'Second chat')}
      </div>
    </section>
  );
}
