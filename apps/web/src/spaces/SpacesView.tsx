// Spaces and Pages (FR-036): a space holds Markdown pages that the user and agents write together.
// /spaces lists the spaces, /spaces/:spaceId shows one (its pages, how agent edits land, and the
// new pages agents propose), and /spaces/:spaceId/:pageId opens a page in the editor. Every save
// is a version; agent edits arrive as proposals or as direct versions, as the space says.
import { useEffect, useId, useRef, useState } from 'react';
import type { PageProposalView, PageSummaryView, SpaceAgentEdits, SpaceView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  RadioGroup,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useSetting } from '../settings.tsx';
import { focusMoved, formatWhen, moveItem, plural } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useSpacesApi } from './api.ts';
import { eventIds, useHubEvents, SPACES_EVENTS } from './events.ts';
import { AGENT_EDITS_TEXT, agentEditsShort, spacePath } from './format.ts';
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

const AGENT_EDIT_OPTIONS = (['propose', 'direct'] as const).map((value) => ({
  value,
  label: AGENT_EDITS_TEXT[value].label,
  description: AGENT_EDITS_TEXT[value].description,
}));

function Breadcrumb({ href, label }: { href: string; label: string }) {
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load your spaces.')),
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
        <h1>Spaces</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New space
        </Button>
      </header>
      <p className="muted ws-flush">
        A space holds pages you and Nova write together. Every save is a version you can restore,
        and you choose whether agent edits wait for your review.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading spaces" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title="No spaces yet"
          description="Create a space for notes, a handbook or a report, then add pages to it."
          icon="edit"
          level={2}
          action={<Button onClick={() => setCreating(true)}>Create a space</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Spaces">
          {items.map((s) => (
            <li key={s.id} className="ws-list-row">
              <div className="spaces-row-main">
                <a
                  href={spacePath(s.id)}
                  className="ws-card-link"
                  onClick={(e) => followLink(e, spacePath(s.id))}
                >
                  {s.name}
                </a>
                {s.description ? <p className="spaces-desc">{s.description}</p> : null}
                <span className="muted ws-row-meta">
                  <span>{plural(s.pageCount, 'page')}</span>
                  <span>{agentEditsShort(s.agentEdits)}</span>
                  <span>Updated {formatWhen(s.updatedAt)}</span>
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
      setError(errorMessage(err, 'Could not save the space.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? 'Rename space' : 'New space'}
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
          label="Name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${formId}-desc`}>
            Description (optional)
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
            legend="When an agent edits a page"
            name={`${formId}-agent-edits`}
            value={mode}
            options={AGENT_EDIT_OPTIONS}
            onChange={(v) => setMode(v === 'direct' ? 'direct' : 'propose')}
          />
        )}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : null} {editing ? 'Save' : 'Create space'}
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
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'page' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const pageList = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.getSpace(spaceId),
      api.listSpacePages(spaceId),
      api.listSpaceProposals(spaceId, { status: 'open' }),
    ]).then(
      ([s, p, x]) => {
        if (!alive) return;
        setSpace(s);
        setPages(sortPages(p.items));
        setProposals(x.items.filter((q) => q.pageId === null));
        setError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setGone(true);
        else setError(errorMessage(err, 'Could not load this space.'));
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
   * Move a page one place up or down. Distinct positions swap (two updates); pages that share a
   * position (the Hub then orders them by creation time) are renumbered in the new order.
   */
  const move = (index: number, dir: 'up' | 'down') => {
    if (!pages || moving) return;
    const a = pages[index];
    const b = pages[dir === 'up' ? index - 1 : index + 1];
    if (!a || !b) return;
    const order = moveItem(pages, index, dir === 'up' ? -1 : 1);
    const updates =
      a.position !== b.position
        ? [
            { id: a.id, position: b.position },
            { id: b.id, position: a.position },
          ]
        : order.flatMap((p, i) => (p.position === i ? [] : [{ id: p.id, position: i }]));
    const next = new Map(updates.map((u) => [u.id, u.position]));
    setPages(order.map((p) => ({ ...p, position: next.get(p.id) ?? p.position })));
    focusMoved(pageList.current, a.id, dir);
    setMoving(true);
    Promise.all(updates.map((u) => api.updateSpacePage(spaceId, u.id, { position: u.position })))
      .then(
        () =>
          announce(`Moved “${a.title}” to position ${order.indexOf(a) + 1} of ${order.length}.`),
        (err: unknown) => toast.show(`Could not move it: ${errorMessage(err)}`, { tone: 'error' }),
      )
      .finally(() => {
        setMoving(false);
        // The Hub's order is the truth, whether the moves went through or not.
        setAttempt((n) => n + 1);
      });
  };

  const setMode = (mode: SpaceAgentEdits) => {
    if (!space || mode === space.agentEdits) return;
    const before = space;
    setSpace({ ...space, agentEdits: mode });
    api.updateSpace(spaceId, { agentEdits: mode }).then(
      (s) => {
        setSpace(s);
        announce(
          mode === 'propose'
            ? 'Agent edits now wait for your review.'
            : 'Agents now edit pages directly.',
        );
      },
      (err: unknown) => {
        setSpace(before);
        toast.show(`Could not change it: ${errorMessage(err)}`, { tone: 'error' });
      },
    );
  };

  const decide = (x: PageProposalView, accept: boolean) => {
    setBusy(x.id);
    const call = accept
      ? api.acceptSpaceProposal(spaceId, x.id).then((p) => {
          toast.show(`Added the page “${p.title}”.`, { tone: 'success' });
        })
      : api.rejectSpaceProposal(spaceId, x.id).then(() => {
          toast.show('Proposal rejected.');
        });
    call
      .then(
        () => setProposals((list) => list.filter((q) => q.id !== x.id)),
        (err: unknown) =>
          toast.show(`Could not ${accept ? 'accept' : 'reject'} it: ${errorMessage(err)}`, {
            tone: 'error',
          }),
      )
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  if (gone)
    return (
      <div className="ws-page spaces-page">
        <Breadcrumb href={spacePath()} label="Spaces" />
        <EmptyState
          title="Space not found"
          description="It may have been deleted."
          level={2}
          action={<Button onClick={() => navigate(spacePath())}>All spaces</Button>}
        />
      </div>
    );

  return (
    <div className="ws-page spaces-page">
      <Breadcrumb href={spacePath()} label="Spaces" />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {!space && !error ? <Spinner label="Loading the space" /> : null}
      {space ? (
        <>
          <header className="ws-page-header">
            <h1>{space.name}</h1>
            <div className="spaces-actions">
              <Button onClick={() => setDialog('rename')}>
                <Icon name="edit" /> Rename
              </Button>
              <Button variant="danger" onClick={() => setDialog('delete')}>
                <Icon name="trash" /> Delete
              </Button>
            </div>
          </header>
          {space.description ? <p className="spaces-desc">{space.description}</p> : null}
          <RadioGroup
            legend="When an agent edits a page"
            name={`agent-edits-${space.id}`}
            value={space.agentEdits}
            options={AGENT_EDIT_OPTIONS}
            onChange={(v) => setMode(v === 'direct' ? 'direct' : 'propose')}
          />

          <section className="ws-section" aria-labelledby="space-pages">
            <div className="ws-section-header">
              <h2 id="space-pages">Pages</h2>
              <Button onClick={() => setDialog('page')}>
                <Icon name="plus" /> New page
              </Button>
            </div>
            {pages === null ? <Spinner label="Loading pages" /> : null}
            {pages?.length === 0 ? (
              <p className="muted ws-flush">No pages yet. Add one to start writing.</p>
            ) : null}
            {pages?.length ? (
              <ol ref={pageList} className="ws-list" aria-label="Pages">
                {pages.map((p, i) => (
                  <li key={p.id} className="ws-list-row" data-move-key={p.id}>
                    <div className="spaces-row-main">
                      <a
                        href={spacePath(spaceId, p.id)}
                        className="ws-card-link"
                        onClick={(e) => followLink(e, spacePath(spaceId, p.id))}
                      >
                        {p.title}
                      </a>
                      <span className="muted ws-row-meta">
                        <span>Version {p.version}</span>
                        <span>
                          Updated {formatWhen(p.updatedAt)} by{' '}
                          {p.updatedBy === 'agent' ? 'an agent' : 'you'}
                        </span>
                      </span>
                    </div>
                    <span className="spaces-badges">
                      {p.openComments ? (
                        <span className="ws-badge">
                          <Icon name="chat" /> {plural(p.openComments, 'open comment')}
                        </span>
                      ) : null}
                      {p.openProposals ? (
                        <span className="ws-badge" data-tone="warn">
                          <Icon name="edit" /> {plural(p.openProposals, 'proposal')}
                        </span>
                      ) : null}
                    </span>
                    <span className="spaces-actions">
                      <Button
                        variant="ghost"
                        data-move="up"
                        aria-label={`Move ${p.title} up`}
                        disabled={i === 0}
                        onClick={() => move(i, 'up')}
                      >
                        Up
                      </Button>
                      <Button
                        variant="ghost"
                        data-move="down"
                        aria-label={`Move ${p.title} down`}
                        disabled={i === pages.length - 1}
                        onClick={() => move(i, 'down')}
                      >
                        Down
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          {proposals.length ? (
            <section className="ws-section" aria-labelledby="space-new-pages">
              <h2 id="space-new-pages">Proposed new pages</h2>
              <p className="muted">
                An agent suggested these pages. Nothing is added until you accept.
              </p>
              <ul className="ws-list" aria-label="Proposed new pages">
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
                toast.show('Space saved.', { tone: 'success' });
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
            title="Delete this space?"
            description={`“${space.name}” and its ${plural(pages?.length ?? space.pageCount, 'page')}, with their versions and comments, are deleted. This cannot be undone.`}
            onClose={() => setDialog(null)}
            footer={
              <>
                <Button onClick={() => setDialog(null)}>Cancel</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setDialog(null);
                    api.deleteSpace(spaceId).then(
                      () => {
                        toast.show(`Deleted “${space.name}”.`, { tone: 'success' });
                        navigate(spacePath());
                      },
                      (err: unknown) =>
                        toast.show(`Could not delete it: ${errorMessage(err)}`, { tone: 'error' }),
                    );
                  }}
                >
                  Delete space
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
      <span className="ws-card-link">{x.title}</span>
      <span className="muted ws-row-meta">
        <span>Agent</span>
        <span>Proposed {formatWhen(x.createdAt)}</span>
      </span>
      {x.summary ? <p className="spaces-item-body">{x.summary}</p> : null}
      <div className="spaces-actions">
        <Button variant="primary" disabled={busy} onClick={() => onDecide(true)}>
          Accept
        </Button>
        <Button disabled={busy} onClick={() => onDecide(false)}>
          Reject
        </Button>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide the page' : 'Show the page'}
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
      setError(errorMessage(err, 'Could not add the page.'));
      setBusy(false);
    }
  };
  return (
    <Dialog open title="New page" onClose={onClose} initialFocusRef={ref}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={ref}
          label="Title"
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
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
            {busy ? <Spinner /> : null} Add page
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
