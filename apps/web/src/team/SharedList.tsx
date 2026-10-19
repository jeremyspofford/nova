// Team → Shared chats (FR-217): the chats other people share with you and the ones you share,
// newest activity first, each with who started it, who is in it and its status. A chat is shared
// from its menu in Chat ("Share with people…"). The list follows `thread.shared` on the shared
// stream, so a chat someone shares with you appears without a reload.
import { useId } from 'react';
import type { SharedThreadView } from '@nova/shared';
import { EmptyState, Spinner, StatusChip } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import { SHARED_LIST_EVENTS, useTeamEvents } from './events.ts';
import { personName, sharedThreadPath } from './format.ts';
import { LoadError, useLoad } from './parts.tsx';

function peopleLine(s: SharedThreadView): string {
  const others = s.participants.map((p) => personName(p));
  if (s.you === 'owner')
    return others.length ? `You share it with ${others.join(', ')}` : 'You share it';
  return `${personName(s.owner)} shares it with you${
    others.length > 1 ? ` and ${others.length - 1} more` : ''
  }`;
}

export function SharedList() {
  const api = useTeamApi();
  const headingId = useId();
  const list = useLoad(() => api.listSharedThreads().then((r) => r.items), 'shared-threads');
  const reload = useDebounced(list.reload, 150);
  useTeamEvents(SHARED_LIST_EVENTS, reload, reload);

  return (
    <section className="stack team-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="nv-vh">
        Shared chats
      </h2>
      <p className="muted ws-flush">
        To share a chat, open it in Chat and choose Share with people… from its menu. Nobody’s
        memory or connectors are used in a shared chat.
      </p>
      {list.error ? (
        <LoadError
          error={list.error}
          fallback="Could not load shared chats."
          onRetry={list.reload}
        />
      ) : null}
      {list.loading ? <Spinner label="Loading shared chats" /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState
          level={3}
          icon="chat"
          title="No shared chats"
          description="Chats that you share, or that someone shares with you, appear here."
          action={
            <a className="nv-btn" href="/chat" onClick={(e) => followLink(e, '/chat')}>
              Open Chat
            </a>
          }
        />
      ) : null}
      {list.data && list.data.length > 0 ? (
        <ul className="ws-list" aria-label="Shared chats">
          {list.data.map((s) => {
            const path = sharedThreadPath(s.thread.id);
            return (
              <li key={s.thread.id} className="ws-card">
                <div className="ws-section-header">
                  <a className="ws-card-link" href={path} onClick={(e) => followLink(e, path)}>
                    {s.thread.title?.trim() || 'Untitled chat'}
                  </a>
                  {s.thread.derived ? (
                    <StatusChip
                      status={s.thread.derived.status}
                      reason={s.thread.derived.reason ?? undefined}
                    />
                  ) : null}
                </div>
                <span className="ws-card-meta muted">
                  {peopleLine(s)} · {formatWhen(s.thread.updatedAt)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
