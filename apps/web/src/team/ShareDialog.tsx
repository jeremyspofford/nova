// Share a chat with people of this Hub (FR-217, decision 5). The dialog says plainly what is not
// shared (anyone's memory, connectors, projects and instructions) and that each message runs as
// the person who wrote it; it lists who is already in the chat, lets the chat's owner take someone
// out, and shares with the people chosen. Only a plain chat outside a project can be shared, and
// sharing turns memory off for it, so nothing said there becomes anyone's memory. The chat view's
// menu opens it through `useShareMenu`.
import { useId, useState, type ReactNode } from 'react';
import type { SharedThreadView, TeamMemberView, ThreadView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast, type MenuItem } from '@nova/ui';
import { ApiError } from '../api.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import {
  MEMBERS_SETTINGS_PATH,
  NOT_SHARED,
  SHARED_ACTS_AS,
  personName,
  sharedThreadPath,
} from './format.ts';
import { FormError, LoadError, useLoad } from './parts.tsx';
import './team.css';

/** Why a thread cannot be shared, or null (the Hub's rule: a plain chat outside a project). */
export function notShareableReason(
  t: Pick<ThreadView, 'mode' | 'temporary' | 'side' | 'projectId'>,
): string | null {
  if (t.temporary) return 'A temporary chat cannot be shared.';
  if (t.side) return 'A side chat cannot be shared.';
  if (t.mode !== 'chat') return 'Only chats can be shared.';
  if (t.projectId) return 'A chat in a project cannot be shared: projects stay their owner’s.';
  return null;
}

function names(people: { displayName: string | null; username: string | null }[]): string {
  const list = people.map((p) => personName(p));
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1) ?? ''}`;
}

export function ShareDialog({
  thread,
  onClose,
}: {
  thread: Pick<ThreadView, 'id' | 'title' | 'mode' | 'temporary' | 'side' | 'projectId'>;
  onClose: () => void;
}) {
  const api = useTeamApi();
  const toast = useToast();
  const announce = useAnnounce();
  const listId = useId();
  const people = useLoad(() => api.listTeamMembers().then((r) => r.items), 'share-people');
  // Who is in it already: a thread that is not shared yet answers 404.
  const sharing = useLoad(
    () =>
      api.getSharedThread(thread.id).then(
        (d): SharedThreadView | null => d,
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        },
      ),
    `share-${thread.id}`,
  );
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const why = notShareableReason(thread);
  const s = sharing.data;
  const inside = new Set(s ? [s.owner.accountId, ...s.participants.map((p) => p.accountId)] : []);
  const isOwner = !s || s.you === 'owner';
  const others = (people.data ?? []).filter((p) => !p.you && !inside.has(p.accountId));
  const loading = people.loading || (sharing.loading && !sharing.error);

  const share = async () => {
    const ids = [...chosen];
    if (!ids.length) {
      setError(new Error('Choose at least one person.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await api.shareThread(thread.id, ids);
      sharing.setData(() => out);
      setChosen(new Set());
      const added = (people.data ?? []).filter((p) => ids.includes(p.accountId));
      const text = `Shared with ${names(added)}.`;
      toast.show(text, { tone: 'success' });
      announce(text);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const takeOut = async (accountId: string) => {
    setRemoving(accountId);
    setError(null);
    try {
      await api.unshareThread(thread.id, accountId);
      sharing.reload();
      announce('Taken out of the chat.');
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(null);
    }
  };

  const toggle = (p: TeamMemberView) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(p.accountId)) next.delete(p.accountId);
      else next.add(p.accountId);
      return next;
    });

  let body: ReactNode;
  if (why) body = <p className="ws-flush">{why}</p>;
  else if (loading) body = <Spinner label="Loading people" />;
  else if (people.error || sharing.error)
    body = (
      <LoadError
        error={people.error ?? sharing.error}
        fallback="Could not load who can see this chat."
        onRetry={() => {
          people.reload();
          sharing.reload();
        }}
      />
    );
  else
    body = (
      <div className="stack">
        {s ? (
          <section aria-labelledby={`${listId}-in`} className="stack team-in-chat">
            <h3 id={`${listId}-in`} className="team-subhead">
              In this chat
            </h3>
            <ul className="ws-list">
              <li className="ws-list-row">
                <span>
                  {personName(s.owner)} <span className="muted">(started it)</span>
                </span>
              </li>
              {s.participants.map((p) => (
                <li key={p.accountId} className="ws-list-row">
                  <span>{personName(p)}</span>
                  {isOwner ? (
                    <Button
                      variant="ghost"
                      disabled={removing !== null}
                      aria-label={`Take ${personName(p)} out of this chat`}
                      onClick={() => void takeOut(p.accountId)}
                    >
                      {removing === p.accountId ? <Spinner /> : null} Take out
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {isOwner ? (
          others.length ? (
            <fieldset className="ws-fieldset">
              <legend>Share with</legend>
              {others.map((p) => (
                <label key={p.accountId} className="ws-check">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.accountId)}
                    onChange={() => toggle(p)}
                  />
                  <span>{personName(p)}</span>
                </label>
              ))}
            </fieldset>
          ) : s ? (
            <p className="muted ws-flush">Everyone on this Hub is in this chat.</p>
          ) : (
            <EmptyState
              level={3}
              icon="at"
              title="Nobody else uses this Hub yet"
              description={
                <>
                  The owner invites people in{' '}
                  <a
                    href={MEMBERS_SETTINGS_PATH}
                    onClick={(e) => {
                      onClose();
                      followLink(e, MEMBERS_SETTINGS_PATH);
                    }}
                  >
                    Settings → Members
                  </a>
                  .
                </>
              }
            />
          )
        ) : (
          <p className="muted ws-flush">Only {personName(s.owner)} can add people to this chat.</p>
        )}
      </div>
    );

  return (
    <Dialog
      open
      title="Share this chat"
      description={`“${thread.title?.trim() || 'Untitled chat'}” with people of this Hub.`}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          {s ? (
            <Button
              variant="ghost"
              onClick={() => {
                onClose();
                navigate(sharedThreadPath(thread.id));
              }}
            >
              Open the shared view
            </Button>
          ) : null}
          <Button onClick={onClose}>{why || !others.length ? 'Close' : 'Cancel'}</Button>
          {!why && isOwner && others.length ? (
            <Button variant="primary" disabled={busy} onClick={() => void share()}>
              {busy ? <Spinner /> : null} Share
            </Button>
          ) : null}
        </>
      }
    >
      {body}
      {!why ? (
        <div className="team-not-shared" aria-label="What sharing does">
          <p className="team-strong ws-flush">
            <Icon name="shield" /> What is not shared
          </p>
          <ul className="ws-plain-list">
            {NOT_SHARED.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="muted ws-flush">{SHARED_ACTS_AS}</p>
          <p className="muted ws-flush">
            Everyone in the chat sees all of it, including what was said before you shared it.
          </p>
        </div>
      ) : null}
      <FormError error={error} fallback="Could not share the chat." />
    </Dialog>
  );
}

/**
 * The chat menu's "Share with people…" and its dialog, for the chat view:
 * `const share = useShareMenu(thread)`, spread `share.items` into the menu, render `share.dialog`.
 */
export function useShareMenu(thread: ThreadView | null): { items: MenuItem[]; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  if (!thread) return { items: [], dialog: null };
  const why = notShareableReason(thread);
  return {
    items: [
      {
        id: 'share',
        label: 'Share with people…',
        onSelect: () => setOpen(true),
        ...(why ? { disabled: true, description: why } : {}),
      },
    ],
    dialog: open ? <ShareDialog thread={thread} onClose={() => setOpen(false)} /> : null,
  };
}
