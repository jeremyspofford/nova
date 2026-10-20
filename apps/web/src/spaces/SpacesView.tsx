// Spaces and Pages (FR-036): a space holds Markdown pages that the user and agents write together.
// /spaces lists the spaces, /spaces/:spaceId shows one (its pages, how agent edits land, and the
// new pages agents propose), and /spaces/:spaceId/:pageId opens a page in the editor. Every save
// is a version; agent edits arrive as proposals or as direct versions, as the space says. M8:
// pages are reordered by dragging, with Move up, Move down and "Move to…" as the keyboard and menu
// ways, all in one write; a page's menu deletes it after saying what goes with it, and deleted
// pages stay under "Recently deleted pages" to restore.
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { defineMessages } from '@nova/i18n';
import type {
  DeletedPageView,
  PageProposalView,
  PageSummaryView,
  SpaceAgentEdits,
  SpaceView,
} from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  Menu,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useSetting } from '../settings.tsx';
import { focusMoved, formatWhen, moveItem } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useSpacesApi } from './api.ts';
import { eventIds, useHubEvents, SPACES_EVENTS } from './events.ts';
import {
  AGENT_EDITS_TEXT,
  SPACES_TEXT,
  agentEditsShort,
  refusalText,
  spacePath,
} from './format.ts';
import { DeletePageDialog, toastDeleted } from './PageDelete.tsx';
import { PageEditor } from './PageEditor.tsx';
import { PageMarkdown } from './PageMarkdown.tsx';
import '../workspace.css';
import '../work/work.css';
import './spaces.css';

export function SpacesView({ spaceId, pageId }: { spaceId: string | null; pageId: string | null }) {
  if (spaceId && pageId)
    return <PageEditor key={`${spaceId}/${pageId}`} spaceId={spaceId} pageId={pageId} />;
  if (spaceId) return <SpaceDetail key={spaceId} spaceId={spaceId} />;
  return <SpaceList />;
}

/** The Hub's page order: position, then creation time. */
export function sortPages<T extends { position: number; createdAt: string }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
  );
}

/** M8 words of the space view: ordering, a page's menu, deleted pages. {title} is a page's title. */
export const SPACE_PAGES_TEXT = defineMessages('spaces.pages', {
  moved: 'Moved “{title}” to position {at} of {of}.',
  /** {why} is the Hub's own words (English, D9). */
  moveFailed: 'Could not move it: {why}',
  dragHint: 'Drag a page to move it, or use its Up, Down and Move to buttons.',
  grip: 'Drag to move {title}',
  more: 'More actions for {title}',
  moveTo: 'Move to…',
  moveTop: 'Move to the top',
  moveBottom: 'Move to the bottom',
  delete: 'Delete…',
  moveTitle: 'Move “{title}”',
  position: 'New position',
  positionHere: '{n} (where it is now)',
  positionOf: '{n} (now “{title}”)',
  move: 'Move',
  cancel: 'Cancel',
  deletedTitle: 'Recently deleted pages',
  deletedIntro:
    'Deleted pages keep their history and comments. Restore one to put it back where it was.',
  deletedWhen: 'Deleted {when}',
  deletedComments: '{n, plural, one {# comment} other {# comments}}',
  restore: 'Restore',
  restoreLabel: 'Restore {title}',
  restored: 'Restored “{title}”.',
  restoreFailed: 'Could not restore it: {why}',
});
const P = SPACE_PAGES_TEXT;

/** The spaces list and one space. {name} is a space's name, {title} a page's title. */
export const SPACE_VIEW_TEXT = defineMessages('spaces.view', {
  breadcrumb: 'Breadcrumb',
  spaces: 'Spaces',
  loadFailed: 'Could not load your spaces.',
  newSpace: 'New space',
  intro:
    'A space holds pages you and Nova write together. Every save is a version you can restore, and you choose whether agent edits wait for your review.',
  loading: 'Loading spaces',
  empty: 'No spaces yet',
  emptyHint: 'Create a space for notes, a handbook or a report, then add pages to it.',
  create: 'Create a space',
  pageCount: '{n, plural, one {# page} other {# pages}}',
  updated: 'Updated {when}',
  saveFailed: 'Could not save the space.',
  rename: 'Rename space',
  name: 'Name',
  description: 'Description (optional)',
  agentEdits: 'When an agent edits a page',
  createSubmit: 'Create space',
  spaceFailed: 'Could not load this space.',
  nowPropose: 'Agent edits now wait for your review.',
  nowDirect: 'Agents now edit pages directly.',
  changeFailed: 'Could not change it: {why}',
  addedPage: 'Added the page “{title}”.',
  rejected: 'Proposal rejected.',
  acceptFailed: 'Could not accept it: {why}',
  rejectFailed: 'Could not reject it: {why}',
  notFound: 'Space not found',
  notFoundHint: 'It may have been deleted.',
  allSpaces: 'All spaces',
  loadingSpace: 'Loading the space',
  renameButton: 'Rename',
  pages: 'Pages',
  newPage: 'New page',
  loadingPages: 'Loading pages',
  noPages: 'No pages yet. Add one to start writing.',
  version: 'Version {v}',
  /** When a page changed and who changed it. */
  updatedBy: '{who, select, agent {Updated {when} by an agent} other {Updated {when} by you}}',
  openComments: '{n, plural, one {# open comment} other {# open comments}}',
  proposals: '{n, plural, one {# proposal} other {# proposals}}',
  moveUp: 'Move {title} up',
  moveDown: 'Move {title} down',
  up: 'Up',
  down: 'Down',
  proposed: 'Proposed new pages',
  proposedIntro: 'An agent suggested these pages. Nothing is added until you accept.',
  saved: 'Space saved.',
  deleteTitle: 'Delete this space?',
  /** {n} counts the space's pages. */
  deleteBody:
    '{n, plural, one {“{name}” and its # page, with their versions and comments, are deleted. This cannot be undone.} other {“{name}” and its # pages, with their versions and comments, are deleted. This cannot be undone.}}',
  deleted: 'Deleted “{name}”.',
  deleteFailed: 'Could not delete it: {why}',
  deleteSpace: 'Delete space',
  agent: 'Agent',
  proposedWhen: 'Proposed {when}',
  accept: 'Accept',
  reject: 'Reject',
  hidePage: 'Hide the page',
  showPage: 'Show the page',
  addFailed: 'Could not add the page.',
  title: 'Title',
  addPage: 'Add page',
});
const V = SPACE_VIEW_TEXT;

function agentEditOptions() {
  return (['propose', 'direct'] as const).map((value) => ({
    value,
    label: AGENT_EDITS_TEXT[value].label,
    description: AGENT_EDITS_TEXT[value].description,
  }));
}

function Breadcrumb({ href, label }: { href: string; label: string }) {
  return (
    <nav aria-label={V.breadcrumb} className="ws-breadcrumb">
      <a href={href} onClick={(e) => followLink(e, href)}>
        <Icon name="back" /> {label}
      </a>
    </nav>
  );
}

// ---- the list of spaces ---------------------------------------------------------------------

function SpaceList() {
  const api = useSpacesApi();
  const [items, setItems] = useState<SpaceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listSpaces().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, V.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  useHubEvents(SPACES_EVENTS, (env) => {
    if (env.name.startsWith('space.') && !env.name.startsWith('space.comment')) reload();
  });

  return (
    <div className="ws-page spaces-page">
      <header className="ws-page-header">
        <h1>{V.spaces}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {V.newSpace}
        </Button>
      </header>
      <p className="muted ws-flush">{V.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{SPACES_TEXT.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={V.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title={V.empty}
          description={V.emptyHint}
          icon="edit"
          level={2}
          action={<Button onClick={() => setCreating(true)}>{V.create}</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={V.spaces}>
          {items.map((s) => (
            <li key={s.id} className="ws-list-row">
              <div className="spaces-row-main">
                <a
                  href={spacePath(s.id)}
                  className="ws-card-link"
                  onClick={(e) => followLink(e, spacePath(s.id))}
                  dir="auto"
                >
                  {s.name}
                </a>
                {s.description ? (
                  <p className="spaces-desc" dir="auto">
                    {s.description}
                  </p>
                ) : null}
                <span className="muted ws-row-meta">
                  <span>{V.pageCount({ n: s.pageCount })}</span>
                  <span>{agentEditsShort(s.agentEdits)}</span>
                  <span>{V.updated({ when: formatWhen(s.updatedAt) })}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {creating ? (
        <SpaceDialog
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            setCreating(false);
            navigate(spacePath(s.id));
          }}
        />
      ) : null}
    </div>
  );
}

/** Create a space, or rename and describe one (`editing`). */
function SpaceDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing?: SpaceView;
  onClose: () => void;
  onSaved: (s: SpaceView) => void;
}) {
  const api = useSpacesApi();
  const preferred = useSetting('spaces.agentEdits').value;
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [mode, setMode] = useState<SpaceAgentEdits>(preferred);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const desc = description.trim() || null;
      onSaved(
        editing
          ? await api.updateSpace(editing.id, { name: name.trim(), description: desc })
          : await api.createSpace({ name: name.trim(), description: desc, agentEdits: mode }),
      );
    } catch (err) {
      setError(errorMessage(err, V.saveFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? V.rename : V.newSpace}
      onClose={onClose}
      initialFocusRef={nameRef}
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={nameRef}
          label={V.name}
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${formId}-desc`}>
            {V.description}
          </label>
          <textarea
            id={`${formId}-desc`}
            className="nv-input ws-textarea"
            rows={2}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {editing ? null : (
          <RadioGroup
            legend={V.agentEdits}
            name={`${formId}-agent-edits`}
            value={mode}
            options={agentEditOptions()}
            onChange={(v) => setMode(v === 'direct' ? 'direct' : 'propose')}
          />
        )}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{SPACES_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : null} {editing ? SPACES_TEXT.save : V.createSubmit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- one space ------------------------------------------------------------------------------

function SpaceDetail({ spaceId }: { spaceId: string }) {
  const api = useSpacesApi();
  const toast = useToast();
  const announce = useAnnounce();
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [pages, setPages] = useState<PageSummaryView[] | null>(null);
  const [proposals, setProposals] = useState<PageProposalView[]>([]);
  const [deleted, setDeleted] = useState<DeletedPageView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'page' | null>(null);
  const [pageDialog, setPageDialog] = useState<{
    kind: 'move' | 'delete';
    page: PageSummaryView;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null);
  const pageList = useRef<HTMLOListElement>(null);
  const newPageButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.getSpace(spaceId),
      api.listSpacePages(spaceId),
      api.listSpaceProposals(spaceId, { status: 'open' }),
      api.listDeletedPages(spaceId),
    ]).then(
      ([s, p, x, d]) => {
        if (!alive) return;
        setSpace(s);
        setPages(sortPages(p.items));
        setProposals(x.items.filter((q) => q.pageId === null));
        setDeleted(d.items);
        setError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setGone(true);
        else setError(errorMessage(err, V.spaceFailed));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, spaceId, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  // Page, comment and proposal events all change what this view shows (rows carry counts).
  useHubEvents(SPACES_EVENTS, (env) => {
    if (eventIds(env).spaceId === spaceId) reload();
  });

  /**
   * Put `page` at `to` in the order (M8): the whole new order goes to the Hub in one write, so a
   * move never leaves pages half-renumbered; a list that went stale meanwhile is refused and the
   * Hub's order comes back.
   */
  const moveTo = (page: PageSummaryView, to: number, focus?: 'up' | 'down') => {
    if (!pages || moving) return;
    const from = pages.findIndex((p) => p.id === page.id);
    if (from < 0 || to === from || to < 0 || to >= pages.length) return;
    const order = moveItem(pages, from, to - from).map((p, i) => ({ ...p, position: i }));
    setPages(order);
    if (focus) focusMoved(pageList.current, page.id, focus);
    setMoving(true);
    api
      .reorderSpacePages(
        spaceId,
        order.map((p) => p.id),
      )
      .then(
        () => announce(P.moved({ title: page.title, at: to + 1, of: order.length })),
        (err: unknown) =>
          toast.show(P.moveFailed({ why: refusalText(err, '') }), { tone: 'error' }),
      )
      .finally(() => {
        setMoving(false);
        // The Hub's order is the truth, whether the move went through or not.
        setAttempt((n) => n + 1);
      });
  };

  const move = (index: number, dir: 'up' | 'down') => {
    const page = pages?.[index];
    if (page) moveTo(page, dir === 'up' ? index - 1 : index + 1, dir);
  };

  // Dragging: the drop place is before the row under the pointer, or after it in its lower half.
  const dragOver = (e: DragEvent<HTMLLIElement>, i: number) => {
    if (!drag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const over = r.height > 0 && e.clientY > r.top + r.height / 2 ? i + 1 : i;
    if (drag.over !== over) setDrag({ ...drag, over });
  };
  const drop = (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    const d = drag;
    setDrag(null);
    if (!d || d.over === null || !pages) return;
    const from = pages.findIndex((p) => p.id === d.id);
    const page = pages[from];
    if (!page) return;
    moveTo(page, d.over > from ? d.over - 1 : d.over);
  };

  const restore = (d: DeletedPageView) => {
    setBusy(d.id);
    api
      .undeleteSpacePage(spaceId, d.id)
      .then(
        () => {
          setDeleted((list) => list.filter((x) => x.id !== d.id));
          toast.show(P.restored({ title: d.title }), { tone: 'success' });
          announce(P.restored({ title: d.title }));
        },
        (err: unknown) =>
          toast.show(P.restoreFailed({ why: errorMessage(err) }), { tone: 'error' }),
      )
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  const setMode = (mode: SpaceAgentEdits) => {
    if (!space || mode === space.agentEdits) return;
    const before = space;
    setSpace({ ...space, agentEdits: mode });
    api.updateSpace(spaceId, { agentEdits: mode }).then(
      (s) => {
        setSpace(s);
        announce(mode === 'propose' ? V.nowPropose : V.nowDirect);
      },
      (err: unknown) => {
        setSpace(before);
        toast.show(V.changeFailed({ why: errorMessage(err) }), { tone: 'error' });
      },
    );
  };

  const decide = (x: PageProposalView, accept: boolean) => {
    setBusy(x.id);
    const call = accept
      ? api.acceptSpaceProposal(spaceId, x.id).then((p) => {
          toast.show(V.addedPage({ title: p.title }), { tone: 'success' });
        })
      : api.rejectSpaceProposal(spaceId, x.id).then(() => {
          toast.show(V.rejected);
        });
    call
      .then(
        () => setProposals((list) => list.filter((q) => q.id !== x.id)),
        (err: unknown) =>
          toast.show(
            accept
              ? V.acceptFailed({ why: errorMessage(err) })
              : V.rejectFailed({ why: errorMessage(err) }),
            { tone: 'error' },
          ),
      )
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  if (gone)
    return (
      <div className="ws-page spaces-page">
        <Breadcrumb href={spacePath()} label={V.spaces} />
        <EmptyState
          title={V.notFound}
          description={V.notFoundHint}
          level={2}
          action={<Button onClick={() => navigate(spacePath())}>{V.allSpaces}</Button>}
        />
      </div>
    );

  return (
    <div className="ws-page spaces-page">
      <Breadcrumb href={spacePath()} label={V.spaces} />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{SPACES_TEXT.retry}</Button>
        </div>
      ) : null}
      {!space && !error ? <Spinner label={V.loadingSpace} /> : null}
      {space ? (
        <>
          <header className="ws-page-header">
            <h1 dir="auto">{space.name}</h1>
            <div className="spaces-actions">
              <Button onClick={() => setDialog('rename')}>
                <Icon name="edit" /> {V.renameButton}
              </Button>
              <Button variant="danger" onClick={() => setDialog('delete')}>
                <Icon name="trash" /> {SPACES_TEXT.delete}
              </Button>
            </div>
          </header>
          {space.description ? (
            <p className="spaces-desc" dir="auto">
              {space.description}
            </p>
          ) : null}
          <RadioGroup
            legend={V.agentEdits}
            name={`agent-edits-${space.id}`}
            value={space.agentEdits}
            options={agentEditOptions()}
            onChange={(v) => setMode(v === 'direct' ? 'direct' : 'propose')}
          />

          <section className="ws-section" aria-labelledby="space-pages">
            <div className="ws-section-header">
              <h2 id="space-pages">{V.pages}</h2>
              <Button ref={newPageButton} onClick={() => setDialog('page')}>
                <Icon name="plus" /> {V.newPage}
              </Button>
            </div>
            {pages && pages.length > 1 ? <p className="muted ws-flush">{P.dragHint}</p> : null}
            {pages === null ? <Spinner label={V.loadingPages} /> : null}
            {pages?.length === 0 ? <p className="muted ws-flush">{V.noPages}</p> : null}
            {pages?.length ? (
              <ol ref={pageList} className="ws-list" aria-label={V.pages}>
                {pages.map((p, i) => (
                  <li
                    key={p.id}
                    className="ws-list-row spaces-page-row"
                    data-move-key={p.id}
                    draggable={!moving}
                    data-dragging={drag?.id === p.id || undefined}
                    data-drop={
                      drag?.over === i
                        ? 'before'
                        : drag?.over === pages.length && i === pages.length - 1
                          ? 'after'
                          : undefined
                    }
                    onDragStart={(e) => {
                      if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', p.id);
                      }
                      setDrag({ id: p.id, over: null });
                    }}
                    onDragOver={(e) => dragOver(e, i)}
                    onDrop={drop}
                    onDragEnd={() => setDrag(null)}
                  >
                    <span
                      className="spaces-grip"
                      title={P.grip({ title: p.title })}
                      aria-hidden="true"
                    >
                      <Icon name="grip" />
                    </span>
                    <div className="spaces-row-main">
                      <a
                        href={spacePath(spaceId, p.id)}
                        className="ws-card-link"
                        onClick={(e) => followLink(e, spacePath(spaceId, p.id))}
                        dir="auto"
                      >
                        {p.title}
                      </a>
                      <span className="muted ws-row-meta">
                        <span>{V.version({ v: p.version })}</span>
                        <span>
                          {V.updatedBy({
                            who: p.updatedBy === 'agent' ? 'agent' : 'user',
                            when: formatWhen(p.updatedAt),
                          })}
                        </span>
                      </span>
                    </div>
                    <span className="spaces-badges">
                      {p.openComments ? (
                        <span className="ws-badge">
                          <Icon name="chat" /> {V.openComments({ n: p.openComments })}
                        </span>
                      ) : null}
                      {p.openProposals ? (
                        <span className="ws-badge" data-tone="warn">
                          <Icon name="edit" /> {V.proposals({ n: p.openProposals })}
                        </span>
                      ) : null}
                    </span>
                    <span className="spaces-actions">
                      <Button
                        variant="ghost"
                        data-move="up"
                        aria-label={V.moveUp({ title: p.title })}
                        disabled={i === 0}
                        onClick={() => move(i, 'up')}
                      >
                        {V.up}
                      </Button>
                      <Button
                        variant="ghost"
                        data-move="down"
                        aria-label={V.moveDown({ title: p.title })}
                        disabled={i === pages.length - 1}
                        onClick={() => move(i, 'down')}
                      >
                        {V.down}
                      </Button>
                      <Menu
                        label={P.more({ title: p.title })}
                        trigger={<Icon name="more" />}
                        items={[
                          {
                            id: 'move',
                            label: P.moveTo,
                            disabled: pages.length < 2,
                            onSelect: () => setPageDialog({ kind: 'move', page: p }),
                          },
                          {
                            id: 'top',
                            label: P.moveTop,
                            disabled: i === 0,
                            onSelect: () => moveTo(p, 0),
                          },
                          {
                            id: 'bottom',
                            label: P.moveBottom,
                            disabled: i === pages.length - 1,
                            onSelect: () => moveTo(p, pages.length - 1),
                          },
                          {
                            id: 'delete',
                            label: P.delete,
                            danger: true,
                            onSelect: () => setPageDialog({ kind: 'delete', page: p }),
                          },
                        ]}
                      />
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          {deleted.length ? (
            <section className="ws-section" aria-labelledby="space-deleted">
              <h2 id="space-deleted">{P.deletedTitle}</h2>
              <p className="muted">{P.deletedIntro}</p>
              <ul className="ws-list" aria-label={P.deletedTitle}>
                {deleted.map((d) => (
                  <li key={d.id} className="ws-list-row">
                    <div className="spaces-row-main">
                      <span className="ws-card-link" dir="auto">
                        {d.title}
                      </span>
                      <span className="muted ws-row-meta">
                        <span>{P.deletedWhen({ when: formatWhen(d.deletedAt) })}</span>
                        {d.comments ? <span>{P.deletedComments({ n: d.comments })}</span> : null}
                      </span>
                    </div>
                    <Button
                      aria-label={P.restoreLabel({ title: d.title })}
                      disabled={busy === d.id}
                      onClick={() => restore(d)}
                    >
                      <Icon name="undo" /> {P.restore}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {proposals.length ? (
            <section className="ws-section" aria-labelledby="space-new-pages">
              <h2 id="space-new-pages">{V.proposed}</h2>
              <p className="muted">{V.proposedIntro}</p>
              <ul className="ws-list" aria-label={V.proposed}>
                {proposals.map((x) => (
                  <NewPageProposal
                    key={x.id}
                    proposal={x}
                    busy={busy === x.id}
                    onDecide={(accept) => decide(x, accept)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {dialog === 'rename' ? (
            <SpaceDialog
              editing={space}
              onClose={() => setDialog(null)}
              onSaved={(s) => {
                setDialog(null);
                setSpace(s);
                toast.show(V.saved, { tone: 'success' });
              }}
            />
          ) : null}
          {pageDialog?.kind === 'move' && pages ? (
            <MovePageDialog
              pages={pages}
              page={pageDialog.page}
              onClose={() => setPageDialog(null)}
              onMove={(to) => {
                setPageDialog(null);
                moveTo(pageDialog.page, to);
              }}
            />
          ) : null}
          {pageDialog?.kind === 'delete' ? (
            <DeletePageDialog
              spaceId={spaceId}
              pageId={pageDialog.page.id}
              title={pageDialog.page.title}
              onClose={() => setPageDialog(null)}
              fallbackFocus={() => newPageButton.current}
              onDelete={async () => {
                const p = pageDialog.page;
                await api.deleteSpacePage(spaceId, p.id);
                setPageDialog(null);
                setPages((list) => list?.filter((x) => x.id !== p.id) ?? null);
                toastDeleted(toast, api, spaceId, p.id, p.title, reload);
                reload();
              }}
            />
          ) : null}
          {dialog === 'page' ? (
            <NewPageDialog
              spaceId={spaceId}
              onClose={() => setDialog(null)}
              onCreated={(pid) => {
                setDialog(null);
                navigate(spacePath(spaceId, pid));
              }}
            />
          ) : null}
          <Dialog
            open={dialog === 'delete'}
            title={V.deleteTitle}
            description={V.deleteBody({
              name: space.name,
              n: pages?.length ?? space.pageCount,
            })}
            onClose={() => setDialog(null)}
            footer={
              <>
                <Button onClick={() => setDialog(null)}>{SPACES_TEXT.cancel}</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setDialog(null);
                    api.deleteSpace(spaceId).then(
                      () => {
                        toast.show(V.deleted({ name: space.name }), { tone: 'success' });
                        navigate(spacePath());
                      },
                      (err: unknown) =>
                        toast.show(V.deleteFailed({ why: errorMessage(err) }), { tone: 'error' }),
                    );
                  }}
                >
                  {V.deleteSpace}
                </Button>
              </>
            }
          />
        </>
      ) : null}
    </div>
  );
}

function NewPageProposal({
  proposal: x,
  busy,
  onDecide,
}: {
  proposal: PageProposalView;
  busy: boolean;
  onDecide: (accept: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="ws-card">
      <span className="ws-card-link" dir="auto">
        {x.title}
      </span>
      <span className="muted ws-row-meta">
        <span>{V.agent}</span>
        <span>{V.proposedWhen({ when: formatWhen(x.createdAt) })}</span>
      </span>
      {x.summary ? (
        <p className="spaces-item-body" dir="auto">
          {x.summary}
        </p>
      ) : null}
      <div className="spaces-actions">
        <Button variant="primary" disabled={busy} onClick={() => onDecide(true)}>
          {V.accept}
        </Button>
        <Button disabled={busy} onClick={() => onDecide(false)}>
          {V.reject}
        </Button>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? V.hidePage : V.showPage}
        </Button>
      </div>
      {open ? (
        <div className="spaces-preview">
          <PageMarkdown text={x.content} />
        </div>
      ) : null}
    </li>
  );
}

/** "Move to…": pick the page's new place; the keyboard and menu way to reorder (M8). */
function MovePageDialog({
  pages,
  page,
  onClose,
  onMove,
}: {
  pages: PageSummaryView[];
  page: PageSummaryView;
  onClose: () => void;
  onMove: (to: number) => void;
}) {
  const from = pages.findIndex((p) => p.id === page.id);
  const [to, setTo] = useState(String(Math.max(0, from)));
  return (
    <Dialog
      open
      title={P.moveTitle({ title: page.title })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{P.cancel}</Button>
          <Button
            variant="primary"
            disabled={Number(to) === from}
            onClick={() => onMove(Number(to))}
          >
            {P.move}
          </Button>
        </>
      }
    >
      <SelectField
        label={P.position}
        value={to}
        onChange={setTo}
        options={pages.map((p, i) => ({
          value: String(i),
          label:
            i === from ? P.positionHere({ n: i + 1 }) : P.positionOf({ n: i + 1, title: p.title }),
        }))}
      />
    </Dialog>
  );
}

function NewPageDialog({
  spaceId,
  onClose,
  onCreated,
}: {
  spaceId: string;
  onClose: () => void;
  onCreated: (pageId: string) => void;
}) {
  const api = useSpacesApi();
  const ref = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createSpacePage(spaceId, { title: title.trim(), content: '' });
      onCreated(p.id);
    } catch (err) {
      setError(errorMessage(err, V.addFailed));
      setBusy(false);
    }
  };
  return (
    <Dialog open title={V.newPage} onClose={onClose} initialFocusRef={ref}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={ref}
          label={V.title}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{SPACES_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
            {busy ? <Spinner /> : null} {V.addPage}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
