// Team → Shared chats (FR-217): the chats other people share with you and the ones you share,
// newest activity first, each with who started it, who is in it and its status. A chat is shared
// from its menu in Chat ("Share with people…"). The list follows `thread.shared` on the shared
// stream, so a chat someone shares with you appears without a reload.
import { useId } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { SharedThreadView } from '@nova/shared';
import { EmptyState, Spinner, StatusChip } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import { SHARED_LIST_EVENTS, useTeamEvents } from './events.ts';
import { TEAM_TEXT, personName, sharedThreadPath } from './format.ts';
import { LoadError, useLoad } from './parts.tsx';

const LIST_TEXT = defineMessages('team.sharedList', {
  heading: 'Shared chats',
  intro:
    'To share a chat, open it in Chat and choose Share with people… from its menu. Nobody’s memory or connectors are used in a shared chat.',
  loadFailed: 'Could not load shared chats.',
  loading: 'Loading shared chats',
  emptyTitle: 'No shared chats',
  emptyDescription: 'Chats that you share, or that someone shares with you, appear here.',
  openChat: 'Open Chat',
  youShare: 'You share it',
  youShareWith: 'You share it with {names}',
  sharesWithYou:
    '{more, plural, =0 {{owner} shares it with you} other {{owner} shares it with you and # more}}',
});

function peopleLine(s: SharedThreadView): string {
  const others = s.participants.map((p) => personName(p));
  if (s.you === 'owner')
    return others.length ? LIST_TEXT.youShareWith({ names: fmt.list(others) }) : LIST_TEXT.youShare;
  return LIST_TEXT.sharesWithYou({
    owner: personName(s.owner),
    more: Math.max(0, others.length - 1),
  });
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
        {LIST_TEXT.heading}
      </h2>
      <p className="muted ws-flush">{LIST_TEXT.intro}</p>
      {list.error ? (
        <LoadError error={list.error} fallback={LIST_TEXT.loadFailed} onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label={LIST_TEXT.loading} /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState
          level={3}
          icon="chat"
          title={LIST_TEXT.emptyTitle}
          description={LIST_TEXT.emptyDescription}
          action={
            <a className="nv-btn" href="/chat" onClick={(e) => followLink(e, '/chat')}>
              {LIST_TEXT.openChat}
            </a>
          }
        />
      ) : null}
      {list.data && list.data.length > 0 ? (
        <ul className="ws-list" aria-label={LIST_TEXT.heading}>
          {list.data.map((s) => {
            const path = sharedThreadPath(s.thread.id);
            return (
              <li key={s.thread.id} className="ws-card">
                <div className="ws-section-header">
                  <a
                    className="ws-card-link"
                    href={path}
                    onClick={(e) => followLink(e, path)}
                    dir="auto"
                  >
                    {s.thread.title?.trim() || TEAM_TEXT.untitledChat}
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
