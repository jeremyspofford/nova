// The page editor (FR-036): Markdown with a live preview, saved as versions. A save names the
// version it was based on; when someone (or an agent) saved in between, the Hub refuses it and
// the user's text stays put next to a diff, to keep or discard. Beside the editor: comments
// (on the page or on a selected passage), the version history with restore, and the agent's
// proposed edits to accept or reject. The view follows `space.*` events: an untouched editor
// reloads quietly; one with edits says a newer version is there.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { authorText, conflictPage, conflictReason, spacePath } from './format.ts';
import { PageMarkdown } from './PageMarkdown.tsx';
import '../workspace.css';
import './spaces.css';

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
        else setError(errorMessage(err, 'Could not open the page.'));
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
      (err: unknown) => alive && setSideError(errorMessage(err, 'Could not load the panels.')),
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
      announce(`A newer version (${ids.version}) of this page is available.`);
    } else reloadQuietly();
  });

  const save = async (baseVersion?: number) => {
    if (!page || saving) return;
    if (!title.trim()) {
      toast.show('A page needs a title.', { tone: 'error' });
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
      announce(`Saved as version ${next.version}.`);
    } catch (err) {
      const current = conflictReason(err) === 'stale_version' ? conflictPage(err) : null;
      if (current) {
        setConflict(current);
        setNewer(null);
        announce(`Not saved: version ${current.version} was saved first. Your text is kept.`);
      } else toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
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
      (err: unknown) => toast.show(`Could not load it: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const commentOnSelection = () => {
    const el = textRef.current;
    if (!el || !page) return;
    const start = el.selectionStart;
    const end = Math.min(el.selectionEnd, start + QUOTE_MAX);
    const quote = content.slice(start, end);
    if (end <= start || !quote.trim()) {
      setSelectionHint('Select some text in the page first.');
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
      announce('Comment added.');
      return true;
    } catch (err) {
      toast.show(`Could not add the comment: ${errorMessage(err)}`, { tone: 'error' });
      return false;
    }
  };

  const resolveComment = (c: PageCommentView, resolved: boolean) => {
    api.resolvePageComment(spaceId, pageId, c.id, resolved).then(
      () => {
        bumpSide();
        announce(resolved ? 'Comment resolved.' : 'Comment reopened.');
      },
      (err: unknown) => toast.show(`Could not change it: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const deleteComment = (c: PageCommentView) => {
    api.deletePageComment(spaceId, pageId, c.id).then(
      () => {
        bumpSide();
        announce('Comment deleted.');
      },
      (err: unknown) => toast.show(`Could not delete it: ${errorMessage(err)}`, { tone: 'error' }),
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
      toast.show(`Restored version ${version} as version ${next.version}.`, { tone: 'success' });
    } catch (err) {
      const current = conflictPage(err);
      if (current) {
        if (!latest.current.dirty) adopt(current);
        toast.show(
          `The page changed (now version ${current.version}). Look at the newest version, then restore again.`,
          { tone: 'error' },
        );
      } else toast.show(`Could not restore it: ${errorMessage(err)}`, { tone: 'error' });
      bumpSide();
    }
  };

  const decide = async (x: PageProposalView, accept: boolean, force = false) => {
    try {
      if (!accept) {
        await api.rejectSpaceProposal(spaceId, x.id);
        toast.show('Proposal rejected.');
      } else {
        const next = await api.acceptSpaceProposal(spaceId, x.id, force ? { force: true } : {});
        if (latest.current.dirty) setNewer({ version: next.version, agent: true });
        else adopt(next);
        toast.show(`Accepted. The page is now version ${next.version}.`, { tone: 'success' });
      }
    } catch (err) {
      if (conflictReason(err) === 'stale_proposal') {
        setProposals(
          (list) => list?.map((q) => (q.id === x.id ? { ...q, stale: true } : q)) ?? null,
        );
        const current = conflictPage(err);
        if (current && !latest.current.dirty) adopt(current);
        toast.show(
          'The page changed since this was proposed. Look at the changes, then accept anyway or reject it.',
          { tone: 'error' },
        );
      } else toast.show(`Could not decide it: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      bumpSide();
    }
  };

  const backHref = spacePath(spaceId);
  if (gone)
    return (
      <div className="ws-page spaces-page">
        <Breadcrumb href={backHref} label={space?.name ?? 'Space'} />
        <EmptyState
          title={gone === 'deleted' ? 'This page was deleted' : 'Page not found'}
          description={
            gone === 'deleted' && dirty
              ? 'Your unsaved text is still below; copy it if you need it.'
              : 'It may have been deleted.'
          }
          level={2}
          action={<Button onClick={() => navigate(backHref)}>Back to the space</Button>}
        />
        {gone === 'deleted' && dirty ? (
          <textarea
            className="nv-input spaces-text"
            aria-label="Your unsaved text"
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
      <Breadcrumb href={backHref} label={space?.name ?? 'Space'} />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {!page && !error ? <Spinner label="Loading the page" /> : null}
      {page ? (
        <>
          <header className="ws-page-header">
            <div className="spaces-head">
              <h1>{page.title}</h1>
              <span className="muted ws-row-meta">
                <span>Version {page.version}</span>
                <span>
                  Saved {formatWhen(page.updatedAt)} by{' '}
                  {page.updatedBy === 'agent' ? 'an agent' : 'you'}
                </span>
              </span>
            </div>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              <Icon name="trash" /> Delete page
            </Button>
          </header>

          {conflict ? (
            <section className="spaces-banner" role="alert" aria-label="Newer version">
              <p>
                <strong>
                  Not saved: version {conflict.version} was saved{' '}
                  {conflict.updatedBy === 'agent' ? 'by an agent' : 'elsewhere'} while you were
                  editing.
                </strong>{' '}
                Your text is still here.
              </p>
              <div className="spaces-actions">
                <Button
                  variant="primary"
                  disabled={saving}
                  onClick={() => void save(conflict.version)}
                >
                  Keep mine and save
                </Button>
                <Button
                  onClick={() => {
                    adopt(conflict);
                    announce(`Loaded version ${conflict.version}.`);
                  }}
                >
                  Discard mine
                </Button>
              </div>
              <p className="muted">
                Lines marked − are only in version {conflict.version}; lines marked + are only in
                yours.
              </p>
              <DiffView
                before={conflict.content}
                after={content}
                label={`Differences between version ${conflict.version} and your text`}
              />
            </section>
          ) : newer ? (
            <section className="spaces-banner" role="status" aria-label="Newer version">
              <p>
                A newer version ({newer.version}) is available
                {newer.agent ? ', made by an agent' : ''}. You have unsaved changes.
              </p>
              <div className="spaces-actions">
                <Button onClick={review}>Compare with mine</Button>
              </div>
            </section>
          ) : null}

          <div className="spaces-page-grid">
            <form
              className="spaces-editor"
              aria-label="Edit the page"
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
                label="Title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Tabs
                label="Editor"
                value={tab}
                onChange={setTab}
                items={[
                  {
                    id: 'write',
                    label: 'Write',
                    panel: (
                      <div className="stack">
                        <textarea
                          ref={textRef}
                          className="nv-input spaces-text"
                          aria-label="Page text (Markdown)"
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
                            <Icon name="quote" /> Comment on selection
                          </Button>
                          {dirty ? (
                            <span id="spaces-sel-hint" className="nv-field-hint">
                              Save first to comment on a passage.
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
                    label: 'Preview',
                    panel: (
                      <div className="spaces-preview">
                        {content.trim() ? (
                          <PageMarkdown text={content} />
                        ) : (
                          <p className="muted">Nothing to preview yet.</p>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
              <TextField
                label="Change note (optional)"
                hint="Shown in the history next to this version."
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="spaces-actions">
                <Button type="submit" variant="primary" disabled={!dirty || saving}>
                  {saving ? <Spinner /> : <Icon name="save" />} Save
                </Button>
                {dirty ? (
                  <span className="spaces-dirty">
                    <Icon name="edit" /> Unsaved changes
                  </span>
                ) : (
                  <span className="spaces-saved">All changes saved</span>
                )}
              </div>
            </form>

            <aside className="spaces-aside" aria-label="Comments, history and proposals">
              {sideError ? (
                <div role="alert" className="ws-error">
                  <p>{sideError}</p>
                  <Button onClick={bumpSide}>Retry</Button>
                </div>
              ) : null}
              <Tabs
                label="Page panels"
                value={panel}
                onChange={(v) => setPanel(v as Panel)}
                items={[
                  {
                    id: 'comments',
                    label: openComments ? `Comments (${openComments})` : 'Comments',
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
                    label: 'History',
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
                    label: openProposals ? `Proposals (${openProposals})` : 'Proposals',
                    panel: <ProposalsPanel page={page} proposals={proposals} onDecide={decide} />,
                  },
                ]}
              />
            </aside>
          </div>
          {deleting ? (
            <DeletePageDialog
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
                toast.show(`Deleted “${page.title}”.`, { tone: 'success' });
                navigate(backHref);
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Confirm a page's deletion; a refusal stays in the dialog. */
function DeletePageDialog({
  title,
  dirty,
  onClose,
  onDelete,
}: {
  title: string;
  dirty: boolean;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      title={`Delete “${title}”?`}
      description={`Its history and comments go with it; open proposals for it are rejected.${
        dirty ? ' Your unsaved changes are lost too.' : ''
      }`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              onDelete().catch((err: unknown) => {
                setError(errorMessage(err, 'Could not delete the page.'));
                setBusy(false);
              });
            }}
          >
            Delete page
          </Button>
        </>
      }
    >
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function Breadcrumb({ href, label }: { href: string; label: string }) {
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
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
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
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
  if (comments === null) return <Spinner label="Loading comments" />;
  const byTime = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const top = byTime.filter((c) => !c.parentId);
  const open = top.filter((c) => !c.resolved);
  const resolved = top.filter((c) => c.resolved);
  const shown = showResolved ? [...open, ...resolved] : open;
  return (
    <div className="stack">
      {pending ? (
        <div className="spaces-item">
          <span className="nv-field-label">Comment on this passage</span>
          <blockquote className="ws-quote">{quoteOf(pending.anchor)}</blockquote>
          <CommentForm
            label="Your comment on the passage"
            submitLabel="Comment"
            autoFocus
            onSubmit={(body) => onPost(body, pending)}
            onCancel={onCancelPending}
          />
        </div>
      ) : (
        <CommentForm
          label="Comment on the page"
          submitLabel="Comment"
          onSubmit={(body) => onPost(body)}
        />
      )}
      {resolved.length ? (
        <label className="spaces-check">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved ({resolved.length})
        </label>
      ) : null}
      {shown.length === 0 ? (
        <p className="muted ws-flush">
          {top.length ? 'No open comments.' : 'No comments yet. Select a passage to comment on it.'}
        </p>
      ) : (
        <ul className="spaces-items" aria-label="Comments">
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
          {formatWhen(c.createdAt)}
          {c.resolved ? ', resolved' : ''}
        </span>
      </div>
      {quote ? <blockquote className="ws-quote">{quote}</blockquote> : null}
      {c.detached ? (
        <p className="spaces-detached">
          <Icon name="alert" /> The text this comment pointed to has changed.
        </p>
      ) : null}
      <p className="spaces-item-body">{c.body}</p>
      {replies.length ? (
        <ul className="spaces-replies" aria-label={`Replies to ${who}`}>
          {replies.map((r) => (
            <li key={r.id} className="spaces-item">
              <div className="spaces-item-head">
                <strong>{authorText(r.authorKind)}</strong>
                <span className="muted">{formatWhen(r.createdAt)}</span>
              </div>
              <p className="spaces-item-body">{r.body}</p>
              <div className="spaces-actions">
                <Button variant="ghost" onClick={() => onDelete(r)}>
                  Delete reply
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="spaces-actions">
        <Button variant="ghost" onClick={() => onResolve(c, !c.resolved)}>
          {c.resolved ? 'Reopen' : 'Resolve'}
        </Button>
        {c.resolved ? null : (
          <Button variant="ghost" aria-expanded={replying} onClick={() => setReplying((r) => !r)}>
            Reply
          </Button>
        )}
        <Button variant="ghost" onClick={() => onDelete(c)}>
          Delete
        </Button>
      </div>
      {replying ? (
        <CommentForm
          label="Your reply"
          submitLabel="Send reply"
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
  if (versions === null) return <Spinner label="Loading the history" />;
  return (
    <>
      <ol className="spaces-items" aria-label="Versions">
        {versions.map((v) => (
          <li key={v.version} className="spaces-item">
            <div className="spaces-item-head">
              <strong>Version {v.version}</strong>
              {v.version === current ? <span className="ws-badge">Current</span> : null}
            </div>
            <span className="muted ws-row-meta">
              <span>{authorText(v.authorKind)}</span>
              <span>{formatWhen(v.createdAt)}</span>
              {v.restoredFrom !== null ? <span>Restored from version {v.restoredFrom}</span> : null}
              {v.proposalId ? <span>Accepted proposal</span> : null}
            </span>
            {v.summary ? <p className="spaces-item-body">{v.summary}</p> : null}
            <div className="spaces-actions">
              <Button
                variant="ghost"
                aria-label={`View version ${v.version}`}
                onClick={() => setOpen({ version: v.version, confirm: false })}
              >
                View
              </Button>
              {v.version === current ? null : (
                <Button
                  variant="ghost"
                  aria-label={`Restore version ${v.version}`}
                  onClick={() => setOpen({ version: v.version, confirm: true })}
                >
                  Restore
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
      (err: unknown) => alive && setData({ error: errorMessage(err, 'Could not load it.') }),
    );
    return () => {
      alive = false;
    };
  }, [api, spaceId, pageId, version, confirm]);

  if (confirm)
    return (
      <Dialog
        open
        title={`Restore version ${version}?`}
        description={`It becomes the newest version (${current + 1}); every version stays in the history.${
          dirty ? ' Your unsaved changes are replaced.' : ''
        }`}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={onRestore}>
              Restore version {version}
            </Button>
          </>
        }
      />
    );

  return (
    <Dialog
      open
      title={`Version ${version}`}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {isCurrent ? null : (
            <Button variant="primary" onClick={onConfirm}>
              Restore this version
            </Button>
          )}
        </>
      }
    >
      {data === null ? (
        <Spinner label="Loading the version" />
      ) : 'error' in data ? (
        <p role="alert" className="nv-field-error">
          {data.error}
        </p>
      ) : (
        <div className="spaces-version-body">
          <h3 className="ws-subhead">{data.v.title}</h3>
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
  if (proposals === null) return <Spinner label="Loading proposals" />;
  if (proposals.length === 0)
    return <p className="muted ws-flush">No proposed edits. Agent proposals show here.</p>;
  const run = (x: PageProposalView, accept: boolean, force?: boolean) => {
    setBusy(x.id);
    void onDecide(x, accept, force).finally(() => setBusy(null));
  };
  return (
    <ul className="spaces-items" aria-label="Proposed edits">
      {proposals.map((x) => {
        const stale = x.stale || (x.baseVersion !== null && x.baseVersion !== page.version);
        const name = x.summary ?? 'Proposed edit';
        return (
          <li key={x.id} className="spaces-item" aria-label={name}>
            <div className="spaces-item-head">
              <strong>{name}</strong>
              <span className="muted">Agent, {formatWhen(x.createdAt)}</span>
            </div>
            {stale ? (
              <p className="spaces-detached">
                <Icon name="alert" /> The page changed since this was proposed
                {x.baseVersion !== null ? ` (it was based on version ${x.baseVersion})` : ''}.
                Accepting replaces the newer text.
              </p>
            ) : null}
            {x.title !== page.title ? (
              <p className="spaces-item-body">
                Title: {page.title} → {x.title}
              </p>
            ) : null}
            <DiffView
              before={page.content}
              after={x.content}
              label={`Changes proposed in “${name}”`}
            />
            <div className="spaces-actions">
              {stale ? (
                <Button disabled={busy === x.id} onClick={() => run(x, true, true)}>
                  Accept anyway
                </Button>
              ) : (
                <Button variant="primary" disabled={busy === x.id} onClick={() => run(x, true)}>
                  Accept
                </Button>
              )}
              <Button disabled={busy === x.id} onClick={() => run(x, false)}>
                Reject
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
