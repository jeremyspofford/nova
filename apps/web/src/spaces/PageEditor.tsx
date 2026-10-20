// The page editor (FR-036): Markdown with a live preview, saved as versions. A save names the
// version it was based on; when someone (or an agent) saved in between, the Hub refuses it and
// the user's text stays put next to a diff, to keep or discard. Beside the editor: comments
// (on the page or on a selected passage), the version history with restore, and the agent's
// proposed edits to accept or reject. The view follows `space.*` events: an untouched editor
// reloads quietly; one with edits says a newer version is there.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type {
  CommentAnchor,
  PageCommentView,
  PageProposalView,
  PageVersionView,
  PageView,
  SpaceView,
} from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, Tabs, TextField, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useSpacesApi } from './api.ts';
import { DiffView } from './DiffView.tsx';
import { eventIds, SPACES_EVENTS, useHubEvents } from './events.ts';
import { SPACES_TEXT, authorText, conflictPage, conflictReason, spacePath } from './format.ts';
import { PageMarkdown } from './PageMarkdown.tsx';
import { DeletePageDialog, toastDeleted } from './PageDelete.tsx';
import '../workspace.css';
import './spaces.css';

/**
 * The page editor and its panels. {v} is a version number; {why} is the Hub's own words (English,
 * D9); comment and proposal texts are data.
 */
export const EDITOR_TEXT = defineMessages('spaces.editor', {
  openFailed: 'Could not open the page.',
  panelsFailed: 'Could not load the panels.',
  newerAvailable: 'A newer version ({v}) of this page is available.',
  needsTitle: 'A page needs a title.',
  savedAs: 'Saved as version {v}.',
  notSavedAnnounce: 'Not saved: version {v} was saved first. Your text is kept.',
  saveFailed: 'Could not save: {why}',
  loadFailed: 'Could not load it: {why}',
  selectFirst: 'Select some text in the page first.',
  commentAdded: 'Comment added.',
  commentFailed: 'Could not add the comment: {why}',
  commentResolved: 'Comment resolved.',
  commentReopened: 'Comment reopened.',
  changeFailed: 'Could not change it: {why}',
  commentDeleted: 'Comment deleted.',
  deleteFailed: 'Could not delete it: {why}',
  restoredAs: 'Restored version {from} as version {v}.',
  restoreStale:
    'The page changed (now version {v}). Look at the newest version, then restore again.',
  restoreFailed: 'Could not restore it: {why}',
  proposalRejected: 'Proposal rejected.',
  accepted: 'Accepted. The page is now version {v}.',
  proposalStale:
    'The page changed since this was proposed. Look at the changes, then accept anyway or reject it.',
  decideFailed: 'Could not decide it: {why}',
  space: 'Space',
  breadcrumb: 'Breadcrumb',
  deleted: 'This page was deleted',
  notFound: 'Page not found',
  unsavedBelow: 'Your unsaved text is still below; copy it if you need it.',
  maybeDeleted: 'It may have been deleted.',
  back: 'Back to the space',
  unsavedText: 'Your unsaved text',
  loading: 'Loading the page',
  version: 'Version {v}',
  savedBy: '{who, select, agent {Saved {when} by an agent} other {Saved {when} by you}}',
  deletePage: 'Delete page',
  newerVersion: 'Newer version',
  notSaved:
    '{who, select, agent {Not saved: version {v} was saved by an agent while you were editing.} other {Not saved: version {v} was saved elsewhere while you were editing.}}',
  textKept: 'Your text is still here.',
  keepMine: 'Keep mine and save',
  loadedVersion: 'Loaded version {v}.',
  discardMine: 'Discard mine',
  diffHint: 'Lines marked − are only in version {v}; lines marked + are only in yours.',
  diffLabel: 'Differences between version {v} and your text',
  newerNote:
    '{agent, select, yes {A newer version ({v}) is available, made by an agent. You have unsaved changes.} other {A newer version ({v}) is available. You have unsaved changes.}}',
  compare: 'Compare with mine',
  editPage: 'Edit the page',
  title: 'Title',
  editor: 'Editor',
  write: 'Write',
  text: 'Page text (Markdown)',
  commentOnSelection: 'Comment on selection',
  saveFirst: 'Save first to comment on a passage.',
  preview: 'Preview',
  nothingToPreview: 'Nothing to preview yet.',
  note: 'Change note (optional)',
  noteHint: 'Shown in the history next to this version.',
  unsaved: 'Unsaved changes',
  allSaved: 'All changes saved',
  aside: 'Comments, history and proposals',
  panels: 'Page panels',
  comments: '{n, plural, =0 {Comments} other {Comments (#)}}',
  history: 'History',
  proposalsTab: '{n, plural, =0 {Proposals} other {Proposals (#)}}',
  loadingComments: 'Loading comments',
  onPassage: 'Comment on this passage',
  yourComment: 'Your comment on the passage',
  comment: 'Comment',
  onPage: 'Comment on the page',
  showResolved: 'Show resolved ({n})',
  noOpen: 'No open comments.',
  noComments: 'No comments yet. Select a passage to comment on it.',
  commentsList: 'Comments',
  /** When a comment was made, and that it was resolved. */
  resolvedWhen: '{when}, resolved',
  detached: 'The text this comment pointed to has changed.',
  repliesTo: 'Replies to {who}',
  deleteReply: 'Delete reply',
  reopen: 'Reopen',
  resolve: 'Resolve',
  reply: 'Reply',
  yourReply: 'Your reply',
  sendReply: 'Send reply',
  loadingHistory: 'Loading the history',
  versions: 'Versions',
  current: 'Current',
  restoredFrom: 'Restored from version {v}',
  acceptedProposal: 'Accepted proposal',
  viewOf: 'View version {v}',
  view: 'View',
  restoreOf: 'Restore version {v}',
  restore: 'Restore',
  versionFailed: 'Could not load it.',
  restoreTitle: 'Restore version {v}?',
  restoreBody: 'It becomes the newest version ({next}); every version stays in the history.',
  restoreBodyDirty:
    'It becomes the newest version ({next}); every version stays in the history. Your unsaved changes are replaced.',
  restoreThis: 'Restore this version',
  loadingVersion: 'Loading the version',
  loadingProposals: 'Loading proposals',
  noProposals: 'No proposed edits. Agent proposals show here.',
  proposedEdits: 'Proposed edits',
  proposedEdit: 'Proposed edit',
  agentWhen: 'Agent, {when}',
  stale: 'The page changed since this was proposed. Accepting replaces the newer text.',
  staleBased:
    'The page changed since this was proposed (it was based on version {v}). Accepting replaces the newer text.',
  /** A proposed new title: "Title: Old → New". */
  titleChange: 'Title: {from} → {to}',
  changesIn: 'Changes proposed in “{name}”',
  acceptAnyway: 'Accept anyway',
  accept: 'Accept',
  reject: 'Reject',
});
const E = EDITOR_TEXT;

/** The longest quote a range comment carries (the Hub's limit). */
const QUOTE_MAX = 2000;

interface PendingComment {
  anchor: Extract<CommentAnchor, { kind: 'range' }>;
  version: number;
}

type Panel = 'comments' | 'history' | 'proposals';

export function PageEditor({ spaceId, pageId }: { spaceId: string; pageId: string }) {
  const api = useSpacesApi();
  const toast = useToast();
  const announce = useAnnounce();
  /** The saved version the editor is based on. */
  const [page, setPage] = useState<PageView | null>(null);
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [tab, setTab] = useState('write');
  const [panel, setPanel] = useState<Panel>('comments');
  const [saving, setSaving] = useState(false);
  /** A newer version the Hub answered a save with; the user's text is kept until they choose. */
  const [conflict, setConflict] = useState<PageView | null>(null);
  /** A newer version that arrived live while the user had edits. */
  const [newer, setNewer] = useState<{ version: number; agent: boolean } | null>(null);
  const [gone, setGone] = useState<'missing' | 'deleted' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [comments, setComments] = useState<PageCommentView[] | null>(null);
  const [versions, setVersions] = useState<PageVersionView[] | null>(null);
  const [proposals, setProposals] = useState<PageProposalView[] | null>(null);
  const [sideError, setSideError] = useState<string | null>(null);
  const [sideRev, setSideRev] = useState(0);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [selectionHint, setSelectionHint] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [deleting, setDeleting] = useState(false);
  /** Set when this editor deleted the page, so its own delete event is not news. */
  const deletedHere = useRef(false);
  const dirty = !!page && (title !== page.title || content !== page.content);
  const latest = useRef({ dirty, page });
  useLayoutEffect(() => {
    latest.current = { dirty, page };
  });

  /** Take a saved version as the editor's base and text. */
  const adopt = useCallback((p: PageView) => {
    setPage(p);
    setTitle(p.title);
    setContent(p.content);
    setConflict(null);
    setNewer(null);
  }, []);

  useEffect(() => {
    let alive = true;
    api.getSpacePage(spaceId, pageId).then(
      (p) => {
        if (!alive) return;
        adopt(p);
        setError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setGone('missing');
        else setError(errorMessage(err, E.openFailed));
      },
    );
    api.getSpace(spaceId).then(
      (s) => alive && setSpace(s),
      () => undefined, // the name is only for the breadcrumb
    );
    return () => {
      alive = false;
    };
  }, [api, spaceId, pageId, adopt, attempt]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.listPageComments(spaceId, pageId),
      api.listPageVersions(spaceId, pageId),
      api.listSpaceProposals(spaceId, { status: 'open', pageId }),
    ]).then(
      ([c, v, x]) => {
        if (!alive) return;
        setComments(c.items);
        setVersions([...v.items].sort((a, b) => b.version - a.version));
        setProposals(x.items.filter((q) => q.pageId === pageId));
        setSideError(null);
      },
      (err: unknown) => alive && setSideError(errorMessage(err, E.panelsFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, spaceId, pageId, sideRev]);

  const bumpSide = useCallback(() => setSideRev((n) => n + 1), []);
  const bumpSideSoon = useDebounced(bumpSide, 150);

  // Leaving with unsaved text asks first (the browser's own prompt).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const reloadQuietly = useCallback(() => {
    api.getSpacePage(spaceId, pageId).then(
      (p) => {
        // The user may have started typing while it loaded.
        if (latest.current.dirty) setNewer({ version: p.version, agent: p.updatedBy === 'agent' });
        else adopt(p);
      },
      () => undefined,
    );
  }, [api, spaceId, pageId, adopt]);

  useHubEvents(SPACES_EVENTS, (env) => {
    const ids = eventIds(env);
    if (ids.pageId !== pageId) return;
    if (env.name === 'space.page.deleted') {
      if (!deletedHere.current) setGone('deleted');
      return;
    }
    bumpSideSoon();
    if (env.name !== 'space.page.updated') return;
    const base = latest.current.page;
    if (!base || ids.version === null || ids.version <= base.version) return;
    if (latest.current.dirty) {
      setNewer({ version: ids.version, agent: ids.authorKind === 'agent' });
      announce(E.newerAvailable({ v: ids.version }));
    } else reloadQuietly();
  });

  const save = async (baseVersion?: number) => {
    if (!page || saving) return;
    if (!title.trim()) {
      toast.show(E.needsTitle, { tone: 'error' });
      return;
    }
    setSaving(true);
    try {
      const next = await api.saveSpacePage(spaceId, pageId, {
        baseVersion: baseVersion ?? page.version,
        title,
        content,
        ...(note.trim() ? { summary: note.trim() } : {}),
      });
      setPage(next);
      // Keep anything typed while the save was on its way.
      setTitle((t) => (t.trim() === next.title ? next.title : t));
      setConflict(null);
      setNewer(null);
      setNote('');
      setPending(null);
      bumpSide();
      announce(E.savedAs({ v: next.version }));
    } catch (err) {
      const current = conflictReason(err) === 'stale_version' ? conflictPage(err) : null;
      if (current) {
        setConflict(current);
        setNewer(null);
        announce(E.notSavedAnnounce({ v: current.version }));
      } else toast.show(E.saveFailed({ why: errorMessage(err) }), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const review = () => {
    api.getSpacePage(spaceId, pageId).then(
      (p) => {
        if (p.version === page?.version) setNewer(null);
        else setConflict(p);
      },
      (err: unknown) => toast.show(E.loadFailed({ why: errorMessage(err) }), { tone: 'error' }),
    );
  };

  const commentOnSelection = () => {
    const el = textRef.current;
    if (!el || !page) return;
    const start = el.selectionStart;
    const end = Math.min(el.selectionEnd, start + QUOTE_MAX);
    const quote = content.slice(start, end);
    if (end <= start || !quote.trim()) {
      setSelectionHint(E.selectFirst);
      return;
    }
    setSelectionHint(null);
    setPending({ anchor: { kind: 'range', start, end, quote }, version: page.version });
    setPanel('comments');
  };

  const postComment = async (body: {
    body: string;
    anchor?: CommentAnchor;
    version?: number;
    parentId?: string;
  }): Promise<boolean> => {
    try {
      await api.createPageComment(spaceId, pageId, body);
      bumpSide();
      announce(E.commentAdded);
      return true;
    } catch (err) {
      toast.show(E.commentFailed({ why: errorMessage(err) }), { tone: 'error' });
      return false;
    }
  };

  const resolveComment = (c: PageCommentView, resolved: boolean) => {
    api.resolvePageComment(spaceId, pageId, c.id, resolved).then(
      () => {
        bumpSide();
        announce(resolved ? E.commentResolved : E.commentReopened);
      },
      (err: unknown) => toast.show(E.changeFailed({ why: errorMessage(err) }), { tone: 'error' }),
    );
  };

  const deleteComment = (c: PageCommentView) => {
    api.deletePageComment(spaceId, pageId, c.id).then(
      () => {
        bumpSide();
        announce(E.commentDeleted);
      },
      (err: unknown) => toast.show(E.deleteFailed({ why: errorMessage(err) }), { tone: 'error' }),
    );
  };

  const restore = async (version: number) => {
    if (!page) return;
    try {
      const next = await api.restoreSpacePage(spaceId, pageId, {
        version,
        baseVersion: page.version,
      });
      adopt(next);
      setNote('');
      bumpSide();
      toast.show(E.restoredAs({ from: version, v: next.version }), { tone: 'success' });
    } catch (err) {
      const current = conflictPage(err);
      if (current) {
        if (!latest.current.dirty) adopt(current);
        toast.show(E.restoreStale({ v: current.version }), { tone: 'error' });
      } else toast.show(E.restoreFailed({ why: errorMessage(err) }), { tone: 'error' });
      bumpSide();
    }
  };

  const decide = async (x: PageProposalView, accept: boolean, force = false) => {
    try {
      if (!accept) {
        await api.rejectSpaceProposal(spaceId, x.id);
        toast.show(E.proposalRejected);
      } else {
        const next = await api.acceptSpaceProposal(spaceId, x.id, force ? { force: true } : {});
        if (latest.current.dirty) setNewer({ version: next.version, agent: true });
        else adopt(next);
        toast.show(E.accepted({ v: next.version }), { tone: 'success' });
      }
    } catch (err) {
      if (conflictReason(err) === 'stale_proposal') {
        setProposals(
          (list) => list?.map((q) => (q.id === x.id ? { ...q, stale: true } : q)) ?? null,
        );
        const current = conflictPage(err);
        if (current && !latest.current.dirty) adopt(current);
        toast.show(E.proposalStale, { tone: 'error' });
      } else toast.show(E.decideFailed({ why: errorMessage(err) }), { tone: 'error' });
    } finally {
      bumpSide();
    }
  };

  const backHref = spacePath(spaceId);
  if (gone)
    return (
      <div className="ws-page spaces-page">
        <Breadcrumb href={backHref} label={space?.name ?? E.space} />
        <EmptyState
          title={gone === 'deleted' ? E.deleted : E.notFound}
          description={gone === 'deleted' && dirty ? E.unsavedBelow : E.maybeDeleted}
          level={2}
          action={<Button onClick={() => navigate(backHref)}>{E.back}</Button>}
        />
        {gone === 'deleted' && dirty ? (
          <textarea
            className="nv-input spaces-text"
            aria-label={E.unsavedText}
            readOnly
            value={content}
          />
        ) : null}
      </div>
    );

  const openComments = (comments ?? []).filter((c) => !c.parentId && !c.resolved).length;
  const openProposals = proposals?.length ?? 0;

  return (
    <div className="ws-page spaces-page spaces-page-wide">
      <Breadcrumb href={backHref} label={space?.name ?? E.space} />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{SPACES_TEXT.retry}</Button>
        </div>
      ) : null}
      {!page && !error ? <Spinner label={E.loading} /> : null}
      {page ? (
        <>
          <header className="ws-page-header">
            <div className="spaces-head">
              <h1 dir="auto">{page.title}</h1>
              <span className="muted ws-row-meta">
                <span>{E.version({ v: page.version })}</span>
                <span>
                  {E.savedBy({
                    who: page.updatedBy === 'agent' ? 'agent' : 'user',
                    when: formatWhen(page.updatedAt),
                  })}
                </span>
              </span>
            </div>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              <Icon name="trash" /> {E.deletePage}
            </Button>
          </header>

          {conflict ? (
            <section className="spaces-banner" role="alert" aria-label={E.newerVersion}>
              <p>
                <strong>
                  {E.notSaved({
                    who: conflict.updatedBy === 'agent' ? 'agent' : 'other',
                    v: conflict.version,
                  })}
                </strong>{' '}
                {E.textKept}
              </p>
              <div className="spaces-actions">
                <Button
                  variant="primary"
                  disabled={saving}
                  onClick={() => void save(conflict.version)}
                >
                  {E.keepMine}
                </Button>
                <Button
                  onClick={() => {
                    adopt(conflict);
                    announce(E.loadedVersion({ v: conflict.version }));
                  }}
                >
                  {E.discardMine}
                </Button>
              </div>
              <p className="muted">{E.diffHint({ v: conflict.version })}</p>
              <DiffView
                before={conflict.content}
                after={content}
                label={E.diffLabel({ v: conflict.version })}
              />
            </section>
          ) : newer ? (
            <section className="spaces-banner" role="status" aria-label={E.newerVersion}>
              <p>{E.newerNote({ agent: newer.agent ? 'yes' : 'no', v: newer.version })}</p>
              <div className="spaces-actions">
                <Button onClick={review}>{E.compare}</Button>
              </div>
            </section>
          ) : null}

          <div className="spaces-page-grid">
            <form
              className="spaces-editor"
              aria-label={E.editPage}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  if (dirty) void save();
                }
              }}
            >
              <TextField
                label={E.title}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Tabs
                label={E.editor}
                value={tab}
                onChange={setTab}
                items={[
                  {
                    id: 'write',
                    label: E.write,
                    panel: (
                      <div className="stack">
                        <textarea
                          ref={textRef}
                          className="nv-input spaces-text"
                          aria-label={E.text}
                          spellCheck
                          value={content}
                          onChange={(e) => setContent(e.target.value)}
                        />
                        <div className="spaces-actions">
                          <Button
                            onClick={commentOnSelection}
                            disabled={dirty}
                            aria-describedby={dirty ? 'spaces-sel-hint' : undefined}
                          >
                            <Icon name="quote" /> {E.commentOnSelection}
                          </Button>
                          {dirty ? (
                            <span id="spaces-sel-hint" className="nv-field-hint">
                              {E.saveFirst}
                            </span>
                          ) : selectionHint ? (
                            <span className="nv-field-hint" role="status">
                              {selectionHint}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ),
                  },
                  {
                    id: 'preview',
                    label: E.preview,
                    panel: (
                      <div className="spaces-preview">
                        {content.trim() ? (
                          <PageMarkdown text={content} />
                        ) : (
                          <p className="muted">{E.nothingToPreview}</p>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
              <TextField
                label={E.note}
                hint={E.noteHint}
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="spaces-actions">
                <Button type="submit" variant="primary" disabled={!dirty || saving}>
                  {saving ? <Spinner /> : <Icon name="save" />} {SPACES_TEXT.save}
                </Button>
                {dirty ? (
                  <span className="spaces-dirty">
                    <Icon name="edit" /> {E.unsaved}
                  </span>
                ) : (
                  <span className="spaces-saved">{E.allSaved}</span>
                )}
              </div>
            </form>

            <aside className="spaces-aside" aria-label={E.aside}>
              {sideError ? (
                <div role="alert" className="ws-error">
                  <p>{sideError}</p>
                  <Button onClick={bumpSide}>{SPACES_TEXT.retry}</Button>
                </div>
              ) : null}
              <Tabs
                label={E.panels}
                value={panel}
                onChange={(v) => setPanel(v as Panel)}
                items={[
                  {
                    id: 'comments',
                    label: E.comments({ n: openComments }),
                    panel: (
                      <CommentsPanel
                        comments={comments}
                        pending={pending}
                        onCancelPending={() => setPending(null)}
                        onPost={async (body, anchor) => {
                          const ok = await postComment(
                            anchor
                              ? { body, anchor: anchor.anchor, version: anchor.version }
                              : { body },
                          );
                          if (ok && anchor) setPending(null);
                          return ok;
                        }}
                        onReply={(parent, body) => postComment({ body, parentId: parent.id })}
                        onResolve={resolveComment}
                        onDelete={deleteComment}
                      />
                    ),
                  },
                  {
                    id: 'history',
                    label: E.history,
                    panel: (
                      <HistoryPanel
                        spaceId={spaceId}
                        pageId={pageId}
                        versions={versions}
                        current={page.version}
                        dirty={dirty}
                        onRestore={restore}
                      />
                    ),
                  },
                  {
                    id: 'proposals',
                    label: E.proposalsTab({ n: openProposals }),
                    panel: <ProposalsPanel page={page} proposals={proposals} onDecide={decide} />,
                  },
                ]}
              />
            </aside>
          </div>
          {deleting ? (
            <DeletePageDialog
              spaceId={spaceId}
              pageId={pageId}
              title={page.title}
              dirty={dirty}
              onClose={() => setDeleting(false)}
              onDelete={async () => {
                deletedHere.current = true;
                try {
                  await api.deleteSpacePage(spaceId, pageId);
                } catch (err) {
                  deletedHere.current = false;
                  throw err;
                }
                // M8: the page can come back (Undo here, or the space's deleted list).
                toastDeleted(toast, api, spaceId, pageId, page.title);
                navigate(backHref);
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Breadcrumb({ href, label }: { href: string; label: string }) {
  return (
    <nav aria-label={E.breadcrumb} className="ws-breadcrumb">
      <a href={href} onClick={(e) => followLink(e, href)}>
        <Icon name="back" /> {label}
      </a>
    </nav>
  );
}

// ---- comments -------------------------------------------------------------------------------

function quoteOf(a: CommentAnchor): string | null {
  if (a.kind === 'page') return null;
  return a.quote.length > 240 ? `${a.quote.slice(0, 240)}…` : a.quote;
}

function CommentForm({
  label,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  label: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim() || busy) return;
        setBusy(true);
        void onSubmit(body.trim()).then((ok) => {
          setBusy(false);
          if (ok) setBody('');
        });
      }}
    >
      <textarea
        ref={ref}
        className="nv-input spaces-note"
        aria-label={label}
        maxLength={4000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="spaces-actions">
        <Button type="submit" variant="primary" disabled={busy || !body.trim()}>
          {submitLabel}
        </Button>
        {onCancel ? <Button onClick={onCancel}>{SPACES_TEXT.cancel}</Button> : null}
      </div>
    </form>
  );
}

function CommentsPanel({
  comments,
  pending,
  onCancelPending,
  onPost,
  onReply,
  onResolve,
  onDelete,
}: {
  comments: PageCommentView[] | null;
  pending: PendingComment | null;
  onCancelPending: () => void;
  onPost: (body: string, anchor?: PendingComment) => Promise<boolean>;
  onReply: (parent: PageCommentView, body: string) => Promise<boolean>;
  onResolve: (c: PageCommentView, resolved: boolean) => void;
  onDelete: (c: PageCommentView) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  if (comments === null) return <Spinner label={E.loadingComments} />;
  const byTime = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const top = byTime.filter((c) => !c.parentId);
  const open = top.filter((c) => !c.resolved);
  const resolved = top.filter((c) => c.resolved);
  const shown = showResolved ? [...open, ...resolved] : open;
  return (
    <div className="stack">
      {pending ? (
        <div className="spaces-item">
          <span className="nv-field-label">{E.onPassage}</span>
          <blockquote className="ws-quote" dir="auto">
            {quoteOf(pending.anchor)}
          </blockquote>
          <CommentForm
            label={E.yourComment}
            submitLabel={E.comment}
            autoFocus
            onSubmit={(body) => onPost(body, pending)}
            onCancel={onCancelPending}
          />
        </div>
      ) : (
        <CommentForm label={E.onPage} submitLabel={E.comment} onSubmit={(body) => onPost(body)} />
      )}
      {resolved.length ? (
        <label className="spaces-check">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          {E.showResolved({ n: resolved.length })}
        </label>
      ) : null}
      {shown.length === 0 ? (
        <p className="muted ws-flush">{top.length ? E.noOpen : E.noComments}</p>
      ) : (
        <ul className="spaces-items" aria-label={E.commentsList}>
          {shown.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              replies={byTime.filter((r) => r.parentId === c.id)}
              onReply={onReply}
              onResolve={onResolve}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentItem({
  comment: c,
  replies,
  onReply,
  onResolve,
  onDelete,
}: {
  comment: PageCommentView;
  replies: PageCommentView[];
  onReply: (parent: PageCommentView, body: string) => Promise<boolean>;
  onResolve: (c: PageCommentView, resolved: boolean) => void;
  onDelete: (c: PageCommentView) => void;
}) {
  const [replying, setReplying] = useState(false);
  const quote = quoteOf(c.anchor);
  const who = authorText(c.authorKind);
  return (
    <li className="spaces-item" data-resolved={c.resolved || undefined}>
      <div className="spaces-item-head">
        <strong>{who}</strong>
        <span className="muted">
          {c.resolved ? E.resolvedWhen({ when: formatWhen(c.createdAt) }) : formatWhen(c.createdAt)}
        </span>
      </div>
      {quote ? (
        <blockquote className="ws-quote" dir="auto">
          {quote}
        </blockquote>
      ) : null}
      {c.detached ? (
        <p className="spaces-detached">
          <Icon name="alert" /> {E.detached}
        </p>
      ) : null}
      <p className="spaces-item-body" dir="auto">
        {c.body}
      </p>
      {replies.length ? (
        <ul className="spaces-replies" aria-label={E.repliesTo({ who })}>
          {replies.map((r) => (
            <li key={r.id} className="spaces-item">
              <div className="spaces-item-head">
                <strong>{authorText(r.authorKind)}</strong>
                <span className="muted">{formatWhen(r.createdAt)}</span>
              </div>
              <p className="spaces-item-body" dir="auto">
                {r.body}
              </p>
              <div className="spaces-actions">
                <Button variant="ghost" onClick={() => onDelete(r)}>
                  {E.deleteReply}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="spaces-actions">
        <Button variant="ghost" onClick={() => onResolve(c, !c.resolved)}>
          {c.resolved ? E.reopen : E.resolve}
        </Button>
        {c.resolved ? null : (
          <Button variant="ghost" aria-expanded={replying} onClick={() => setReplying((r) => !r)}>
            {E.reply}
          </Button>
        )}
        <Button variant="ghost" onClick={() => onDelete(c)}>
          {SPACES_TEXT.delete}
        </Button>
      </div>
      {replying ? (
        <CommentForm
          label={E.yourReply}
          submitLabel={E.sendReply}
          autoFocus
          onSubmit={async (body) => {
            const ok = await onReply(c, body);
            if (ok) setReplying(false);
            return ok;
          }}
          onCancel={() => setReplying(false)}
        />
      ) : null}
    </li>
  );
}

// ---- history --------------------------------------------------------------------------------

function HistoryPanel({
  spaceId,
  pageId,
  versions,
  current,
  dirty,
  onRestore,
}: {
  spaceId: string;
  pageId: string;
  versions: PageVersionView[] | null;
  current: number;
  dirty: boolean;
  onRestore: (version: number) => Promise<void>;
}) {
  const [open, setOpen] = useState<{ version: number; confirm: boolean } | null>(null);
  if (versions === null) return <Spinner label={E.loadingHistory} />;
  return (
    <>
      <ol className="spaces-items" aria-label={E.versions}>
        {versions.map((v) => (
          <li key={v.version} className="spaces-item">
            <div className="spaces-item-head">
              <strong>{E.version({ v: v.version })}</strong>
              {v.version === current ? <span className="ws-badge">{E.current}</span> : null}
            </div>
            <span className="muted ws-row-meta">
              <span>{authorText(v.authorKind)}</span>
              <span>{formatWhen(v.createdAt)}</span>
              {v.restoredFrom !== null ? (
                <span>{E.restoredFrom({ v: v.restoredFrom })}</span>
              ) : null}
              {v.proposalId ? <span>{E.acceptedProposal}</span> : null}
            </span>
            {v.summary ? (
              <p className="spaces-item-body" dir="auto">
                {v.summary}
              </p>
            ) : null}
            <div className="spaces-actions">
              <Button
                variant="ghost"
                aria-label={E.viewOf({ v: v.version })}
                onClick={() => setOpen({ version: v.version, confirm: false })}
              >
                {E.view}
              </Button>
              {v.version === current ? null : (
                <Button
                  variant="ghost"
                  aria-label={E.restoreOf({ v: v.version })}
                  onClick={() => setOpen({ version: v.version, confirm: true })}
                >
                  {E.restore}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {open ? (
        <VersionDialog
          spaceId={spaceId}
          pageId={pageId}
          version={open.version}
          confirm={open.confirm}
          isCurrent={open.version === current}
          current={current}
          dirty={dirty}
          onConfirm={() => setOpen({ ...open, confirm: true })}
          onClose={() => setOpen(null)}
          onRestore={() => {
            setOpen(null);
            void onRestore(open.version);
          }}
        />
      ) : null}
    </>
  );
}

function VersionDialog({
  spaceId,
  pageId,
  version,
  confirm,
  isCurrent,
  current,
  dirty,
  onConfirm,
  onClose,
  onRestore,
}: {
  spaceId: string;
  pageId: string;
  version: number;
  confirm: boolean;
  isCurrent: boolean;
  current: number;
  dirty: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onRestore: () => void;
}) {
  const api = useSpacesApi();
  const [data, setData] = useState<{ v: PageVersionView } | { error: string } | null>(null);
  useEffect(() => {
    if (confirm) return;
    let alive = true;
    api.getPageVersion(spaceId, pageId, version).then(
      (v) => alive && setData({ v }),
      (err: unknown) => alive && setData({ error: errorMessage(err, E.versionFailed) }),
    );
    return () => {
      alive = false;
    };
  }, [api, spaceId, pageId, version, confirm]);

  if (confirm)
    return (
      <Dialog
        open
        title={E.restoreTitle({ v: version })}
        description={
          dirty ? E.restoreBodyDirty({ next: current + 1 }) : E.restoreBody({ next: current + 1 })
        }
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>{SPACES_TEXT.cancel}</Button>
            <Button variant="primary" onClick={onRestore}>
              {E.restoreOf({ v: version })}
            </Button>
          </>
        }
      />
    );

  return (
    <Dialog
      open
      title={E.version({ v: version })}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{SPACES_TEXT.close}</Button>
          {isCurrent ? null : (
            <Button variant="primary" onClick={onConfirm}>
              {E.restoreThis}
            </Button>
          )}
        </>
      }
    >
      {data === null ? (
        <Spinner label={E.loadingVersion} />
      ) : 'error' in data ? (
        <p role="alert" className="nv-field-error">
          {data.error}
        </p>
      ) : (
        <div className="spaces-version-body">
          <h3 className="ws-subhead" dir="auto">
            {data.v.title}
          </h3>
          <PageMarkdown text={data.v.content ?? ''} />
        </div>
      )}
    </Dialog>
  );
}

// ---- proposals ------------------------------------------------------------------------------

function ProposalsPanel({
  page,
  proposals,
  onDecide,
}: {
  page: PageView;
  proposals: PageProposalView[] | null;
  onDecide: (x: PageProposalView, accept: boolean, force?: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (proposals === null) return <Spinner label={E.loadingProposals} />;
  if (proposals.length === 0) return <p className="muted ws-flush">{E.noProposals}</p>;
  const run = (x: PageProposalView, accept: boolean, force?: boolean) => {
    setBusy(x.id);
    void onDecide(x, accept, force).finally(() => setBusy(null));
  };
  return (
    <ul className="spaces-items" aria-label={E.proposedEdits}>
      {proposals.map((x) => {
        const stale = x.stale || (x.baseVersion !== null && x.baseVersion !== page.version);
        const name = x.summary ?? E.proposedEdit;
        return (
          <li key={x.id} className="spaces-item" aria-label={name}>
            <div className="spaces-item-head">
              <strong dir="auto">{name}</strong>
              <span className="muted">{E.agentWhen({ when: formatWhen(x.createdAt) })}</span>
            </div>
            {stale ? (
              <p className="spaces-detached">
                <Icon name="alert" />{' '}
                {x.baseVersion !== null ? E.staleBased({ v: x.baseVersion }) : E.stale}
              </p>
            ) : null}
            {x.title !== page.title ? (
              <p className="spaces-item-body" dir="auto">
                {E.titleChange({ from: page.title, to: x.title })}
              </p>
            ) : null}
            <DiffView before={page.content} after={x.content} label={E.changesIn({ name })} />
            <div className="spaces-actions">
              {stale ? (
                <Button disabled={busy === x.id} onClick={() => run(x, true, true)}>
                  {E.acceptAnyway}
                </Button>
              ) : (
                <Button variant="primary" disabled={busy === x.id} onClick={() => run(x, true)}>
                  {E.accept}
                </Button>
              )}
              <Button disabled={busy === x.id} onClick={() => run(x, false)}>
                {E.reject}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
