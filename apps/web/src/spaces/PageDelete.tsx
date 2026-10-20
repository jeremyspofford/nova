// Deleting a page (FR-036, M8): the confirmation first asks the Hub what goes with the page (its
// versions, comment threads and replies, the agents' open proposals, and the sites built from the
// space), says the page can be restored, and keeps a refusal in the dialog. After a delete the
// toast offers Undo; the space's "Recently deleted pages" list is the lasting way back.
import { useEffect, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { PageDeletionView } from '@nova/shared';
import { Button, Dialog, Spinner, type ToastApi } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useSpacesApi, type SpacesApi } from './api.ts';

/** Deleting a page. {title} is the page's title (data). */
export const DELETE_PAGE_TEXT = defineMessages('spaces.deletePage', {
  title: 'Delete “{title}”?',
  checking: 'Checking what goes with it',
  intro: 'The page leaves the space. With it go:',
  /** Items of the list after `intro`. */
  versions: '{n, plural, one {its saved version} other {its # saved versions}}',
  comments: '{n, plural, one {# comment thread} other {# comment threads}}',
  replies: '{n, plural, one {# reply} other {# replies}}',
  proposals:
    '{n, plural, one {# open proposal from an agent, which ends rejected and stays rejected if you restore the page} other {# open proposals from agents, which end rejected and stay rejected if you restore the page}}',
  /** {names} lists the sites' names. */
  sites: 'Sites built from this space leave it out of their next build: {names}.',
  published: 'What is published now does not change until you publish again.',
  restore:
    'You can restore it, with its history and comments, from “Recently deleted pages” in this space.',
  unknown:
    'Its history and comments are kept with it, and you can restore it from “Recently deleted pages” in this space.',
  impactFailed: 'Could not check what goes with it.',
  dirty: 'Your unsaved changes are lost.',
  cancel: 'Cancel',
  confirm: 'Delete page',
  failed: 'Could not delete the page.',
  deleted: 'Deleted “{title}”.',
  undo: 'Undo',
  restored: 'Restored “{title}”.',
  /** {why} is the Hub's own words (English, D9). */
  restoreFailed: 'Could not restore it: {why}',
});

const T = DELETE_PAGE_TEXT;

/** Confirm a page's deletion, saying what goes with it; a refusal stays in the dialog. */
export function DeletePageDialog({
  spaceId,
  pageId,
  title,
  dirty = false,
  onClose,
  onDelete,
  fallbackFocus,
}: {
  spaceId: string;
  pageId: string;
  title: string;
  dirty?: boolean;
  onClose: () => void;
  /** Where focus goes when the dialog closes and its opener is gone (a deleted row). */
  fallbackFocus?: () => HTMLElement | null;
  /** Deletes the page (the caller may track it); a rejection keeps the dialog open. */
  onDelete: () => Promise<void>;
}) {
  const api = useSpacesApi();
  const [impact, setImpact] = useState<PageDeletionView | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getPageDeletion(spaceId, pageId).then(
      (v) => alive && setImpact(v),
      () => alive && setImpact('failed'),
    );
    return () => {
      alive = false;
    };
  }, [api, spaceId, pageId]);

  const parts =
    impact && impact !== 'failed'
      ? [
          impact.versions ? T.versions({ n: impact.versions }) : null,
          impact.comments ? T.comments({ n: impact.comments }) : null,
          impact.replies ? T.replies({ n: impact.replies }) : null,
          impact.openProposals ? T.proposals({ n: impact.openProposals }) : null,
        ].filter((p): p is string => p !== null)
      : [];
  const published =
    impact && impact !== 'failed' && impact.sites.some((s) => s.publishedVersion !== null);

  return (
    <Dialog
      open
      title={T.title({ title })}
      onClose={onClose}
      {...(fallbackFocus ? { fallbackFocus } : {})}
      footer={
        <>
          <Button onClick={onClose}>{T.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy || impact === null}
            onClick={() => {
              setBusy(true);
              setError(null);
              onDelete().catch((err: unknown) => {
                setError(errorMessage(err, T.failed));
                setBusy(false);
              });
            }}
          >
            {T.confirm}
          </Button>
        </>
      }
    >
      <div className="stack spaces-delete">
        {impact === null ? <Spinner label={T.checking} /> : null}
        {impact === 'failed' ? (
          <>
            <p className="muted">{T.impactFailed}</p>
            <p>{T.unknown}</p>
          </>
        ) : null}
        {impact && impact !== 'failed' ? (
          <>
            {parts.length ? (
              <>
                <p>{T.intro}</p>
                <ul className="spaces-delete-list">
                  {parts.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {impact.sites.length ? (
              <p>
                {T.sites({
                  names: fmt.list(
                    impact.sites.map((s) => `“${s.name}”`),
                    { type: 'unit', style: 'short' },
                  ),
                })}
                {published ? ` ${T.published}` : ''}
              </p>
            ) : null}
            <p>{T.restore}</p>
          </>
        ) : null}
        {dirty ? <p>{T.dirty}</p> : null}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The toast after a delete, with Undo bringing the page back. */
export function toastDeleted(
  toast: ToastApi,
  api: SpacesApi,
  spaceId: string,
  pageId: string,
  title: string,
  onRestored?: () => void,
): void {
  toast.show(T.deleted({ title }), {
    tone: 'success',
    action: {
      label: T.undo,
      onClick: () => {
        api.undeleteSpacePage(spaceId, pageId).then(
          () => {
            toast.show(T.restored({ title }), { tone: 'success' });
            onRestored?.();
          },
          (err: unknown) =>
            toast.show(T.restoreFailed({ why: errorMessage(err) }), { tone: 'error' }),
        );
      },
    },
  });
}
