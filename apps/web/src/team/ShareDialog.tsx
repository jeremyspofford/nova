// Share a chat with people of this Hub (FR-217, decision 5). The dialog says plainly what is not
// shared (anyone's memory, connectors, projects and instructions) and that each message runs as
// the person who wrote it; it lists who is already in the chat, lets the chat's owner take someone
// out, and shares with the people chosen. Only a plain chat outside a project can be shared, and
// sharing turns memory off for it, so nothing said there becomes anyone's memory. The chat view's
// menu opens it through `useShareMenu`.
import { useId, useState, type ReactNode } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { SharedThreadView, TeamMemberView, ThreadView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast, type MenuItem } from '@nova/ui';
import { ApiError } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import {
  MEMBERS_SETTINGS_PATH,
  SHARING_TEXT,
  TEAM_TEXT,
  personName,
  sharedThreadPath,
} from './format.ts';
import { FormError, LoadError, useLoad } from './parts.tsx';
import './team.css';

const SHARE_TEXT = defineMessages('team.share', {
  temporary: 'A temporary chat cannot be shared.',
  side: 'A side chat cannot be shared.',
  onlyChats: 'Only chats can be shared.',
  inProject: 'A chat in a project cannot be shared: projects stay their owner’s.',
  chooseSomeone: 'Choose at least one person.',
  sharedWith: 'Shared with {names}.',
  takenOut: 'Taken out of the chat.',
  loadingPeople: 'Loading people',
  loadFailed: 'Could not load who can see this chat.',
  inThisChat: 'In this chat',
  startedIt: '(started it)',
  takeOutLabel: 'Take {name} out of this chat',
  takeOut: 'Take out',
  shareWith: 'Share with',
  everyoneIn: 'Everyone on this Hub is in this chat.',
  nobodyElse: 'Nobody else uses this Hub yet',
  ownerInvites: 'The owner invites people in {link}.',
  onlyOwnerAdds: 'Only {name} can add people to this chat.',
  title: 'Share this chat',
  about: '“{title}” with people of this Hub.',
  openShared: 'Open the shared view',
  share: 'Share',
  whatSharingDoes: 'What sharing does',
  notShared: 'What is not shared',
  seesAll: 'Everyone in the chat sees all of it, including what was said before you shared it.',
  shareFailed: 'Could not share the chat.',
  menuItem: 'Share with people…',
});

/** Why a thread cannot be shared, or null (the Hub's rule: a plain chat outside a project). */
export function notShareableReason(
  t: Pick<ThreadView, 'mode' | 'temporary' | 'side' | 'projectId'>,
): string | null {
  if (t.temporary) return SHARE_TEXT.temporary;
  if (t.side) return SHARE_TEXT.side;
  if (t.mode !== 'chat') return SHARE_TEXT.onlyChats;
  if (t.projectId) return SHARE_TEXT.inProject;
  return null;
}

function names(people: { displayName: string | null; username: string | null }[]): string {
  return fmt.list(people.map((p) => personName(p)));
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
      setError(new Error(SHARE_TEXT.chooseSomeone));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await api.shareThread(thread.id, ids);
      sharing.setData(() => out);
      setChosen(new Set());
      const added = (people.data ?? []).filter((p) => ids.includes(p.accountId));
      const text = SHARE_TEXT.sharedWith({ names: names(added) });
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
      announce(SHARE_TEXT.takenOut);
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
  else if (loading) body = <Spinner label={SHARE_TEXT.loadingPeople} />;
  else if (people.error || sharing.error)
    body = (
      <LoadError
        error={people.error ?? sharing.error}
        fallback={SHARE_TEXT.loadFailed}
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
              {SHARE_TEXT.inThisChat}
            </h3>
            <ul className="ws-list">
              <li className="ws-list-row">
                <span>
                  <span dir="auto">{personName(s.owner)}</span>{' '}
                  <span className="muted">{SHARE_TEXT.startedIt}</span>
                </span>
              </li>
              {s.participants.map((p) => (
                <li key={p.accountId} className="ws-list-row">
                  <span dir="auto">{personName(p)}</span>
                  {isOwner ? (
                    <Button
                      variant="ghost"
                      disabled={removing !== null}
                      aria-label={SHARE_TEXT.takeOutLabel({ name: personName(p) })}
                      onClick={() => void takeOut(p.accountId)}
                    >
                      {removing === p.accountId ? <Spinner /> : null} {SHARE_TEXT.takeOut}
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
              <legend>{SHARE_TEXT.shareWith}</legend>
              {others.map((p) => (
                <label key={p.accountId} className="ws-check">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.accountId)}
                    onChange={() => toggle(p)}
                  />
                  <span dir="auto">{personName(p)}</span>
                </label>
              ))}
            </fieldset>
          ) : s ? (
            <p className="muted ws-flush">{SHARE_TEXT.everyoneIn}</p>
          ) : (
            <EmptyState
              level={3}
              icon="at"
              title={SHARE_TEXT.nobodyElse}
              description={rich(SHARE_TEXT.ownerInvites, {
                link: (
                  <a
                    href={MEMBERS_SETTINGS_PATH}
                    onClick={(e) => {
                      onClose();
                      followLink(e, MEMBERS_SETTINGS_PATH);
                    }}
                  >
                    {TEAM_TEXT.membersLink}
                  </a>
                ),
              })}
            />
          )
        ) : (
          <p className="muted ws-flush">
            {SHARE_TEXT.onlyOwnerAdds({ name: personName(s.owner) })}
          </p>
        )}
      </div>
    );

  return (
    <Dialog
      open
      title={SHARE_TEXT.title}
      description={SHARE_TEXT.about({ title: thread.title?.trim() || TEAM_TEXT.untitledChat })}
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
              {SHARE_TEXT.openShared}
            </Button>
          ) : null}
          <Button onClick={onClose}>
            {why || !others.length ? TEAM_TEXT.close : TEAM_TEXT.cancel}
          </Button>
          {!why && isOwner && others.length ? (
            <Button variant="primary" disabled={busy} onClick={() => void share()}>
              {busy ? <Spinner /> : null} {SHARE_TEXT.share}
            </Button>
          ) : null}
        </>
      }
    >
      {body}
      {!why ? (
        <div role="group" className="team-not-shared" aria-label={SHARE_TEXT.whatSharingDoes}>
          <p className="team-strong ws-flush">
            <Icon name="shield" /> {SHARE_TEXT.notShared}
          </p>
          <ul className="ws-plain-list">
            {Object.entries(SHARING_TEXT.notShared).map(([key, t]) => (
              <li key={key}>{t}</li>
            ))}
          </ul>
          <p className="muted ws-flush">{SHARING_TEXT.actsAs}</p>
          <p className="muted ws-flush">{SHARE_TEXT.seesAll}</p>
        </div>
      ) : null}
      <FormError error={error} fallback={SHARE_TEXT.shareFailed} />
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
        label: SHARE_TEXT.menuItem,
        onSelect: () => setOpen(true),
        ...(why ? { disabled: true, description: why } : {}),
      },
    ],
    dialog: open ? <ShareDialog thread={thread} onClose={() => setOpen(false)} /> : null,
  };
}
