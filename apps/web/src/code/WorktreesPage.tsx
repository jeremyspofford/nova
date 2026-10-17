// Worktrees at /code/worktrees (FR-073; docs/10 §9): the registry of Git worktrees on the Hub,
// grouped by repository, each with its branch, whether it has uncommitted changes, and its lease
// (which session holds it and until when). Renew extends a lease; Release drops it (refused while
// a session works in it); Remove deletes it from disk (its branch stays; a worktree with
// uncommitted changes needs Remove anyway, after a warning). A repository holds at most 15: at the
// cap, New worktree offers to remove the oldest unused clean one, and only does when you accept.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CodeSessionView, WorktreeView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink, CodeNav } from './CodeNav.tsx';
import { useCodeEvents, useCoalesced } from './events.ts';
import { sessionPath, sessionTitle } from './labels.ts';
import { errorDetails, errorReason, leaseText } from './m6-format.ts';
import { Badge, ConfirmDialog, ErrorBanner } from './parts.tsx';
import '../workspace.css';

/** The registry's cap per repository (docs/10 §9). */
export const MAX_WORKTREES = 15;

type Filter = 'active' | 'all';

export function WorktreesPage({ visible = true }: { visible?: boolean }) {
  const { api } = useServices();
  const m6 = useCodeM6Api();
  const toast = useToast();
  const announce = useAnnounce();
  const [filter, setFilter] = useState<Filter>('active');
  const [items, setItems] = useState<WorktreeView[] | null>(null);
  const [sessions, setSessions] = useState<CodeSessionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [removing, setRemoving] = useState<WorktreeView | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    () =>
      m6.listWorktrees({ status: filter }).then(
        ({ items: list }) => {
          setItems(list);
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, 'Could not load the worktrees.')),
      ),
    [filter, m6],
  );
  const reload = useCoalesced(load);
  // `reload` always runs the latest `load`; the filter is a dependency so a change reloads.
  useEffect(() => {
    if (visible) reload();
  }, [reload, visible, filter]);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    api.listCodeSessions().then(
      ({ items: list }) => alive && setSessions(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, visible]);
  useCodeEvents(visible, (env) => {
    if (env.name.startsWith('worktree.') || env.name === 'code.session.created') reload();
  });

  const sessionName = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    return s ? `“${sessionTitle(s)}”` : 'a session';
  };
  const groups = useMemo(() => {
    const byRepo = new Map<string, WorktreeView[]>();
    for (const w of items ?? []) byRepo.set(w.repoPath, [...(byRepo.get(w.repoPath) ?? []), w]);
    return [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const act = async (w: WorktreeView, what: string, fn: () => Promise<WorktreeView>) => {
    setBusy((s) => new Set([...s, w.id]));
    try {
      const next = await fn();
      setItems((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null);
      announce(`${what}: ${w.branch}.`);
    } catch (err) {
      const reason = errorReason(err);
      toast.show(
        reason === 'in_use'
          ? `A Code session works in ${w.branch}. Archive the session first.`
          : `Could not ${what.toLowerCase()} ${w.branch}: ${errorMessage(err)}`,
        { tone: 'error' },
      );
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(w.id);
        return n;
      });
    }
  };

  const remove = async () => {
    const w = removing;
    if (!w) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const next = await m6.removeWorktree(w.id, w.dirty === true);
      setItems((list) =>
        filter === 'all'
          ? (list?.map((x) => (x.id === next.id ? next : x)) ?? null)
          : (list?.filter((x) => x.id !== w.id) ?? null),
      );
      setRemoving(null);
      toast.show(`Removed the worktree of ${w.branch}. The branch stays.`, { tone: 'success' });
    } catch (err) {
      const reason = errorReason(err);
      setRemoveError(
        reason === 'in_use'
          ? 'A Code session works in this worktree. Archive the session first.'
          : reason === 'leased'
            ? 'This worktree is leased. Release it first.'
            : reason === 'dirty'
              ? 'This worktree has uncommitted changes.'
              : errorMessage(err, 'Could not remove the worktree.'),
      );
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div className="ws-page code-m6-page">
      <header className="ws-page-header">
        <h1>Worktrees</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New worktree
        </Button>
      </header>
      <CodeNav current="worktrees" />
      <p className="muted">
        Each worktree is a separate checkout on its own nova/ branch, so parallel sessions do not
        touch each other’s files. A repository holds at most {MAX_WORKTREES}.
      </p>
      <SelectField
        label="Show"
        className="code-filter"
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        options={[
          { value: 'active', label: 'Worktrees on disk' },
          { value: 'all', label: 'All, including removed' },
        ]}
      />
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {items === null && !error ? <Spinner label="Loading the worktrees" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title="No worktrees"
          description="Start a session with “Work in a new Git worktree”, or create one here for a session to use later."
          icon="branch"
          action={<Button onClick={() => setCreating(true)}>New worktree</Button>}
        />
      ) : null}
      {groups.map(([repo, list]) => {
        const onDisk = list.filter((w) => w.status !== 'removed').length;
        return (
          <section key={repo} className="code-wt-group" aria-label={repo}>
            <div className="code-subhead">
              <h2 className="code-path">{repo}</h2>
              <span className="muted">
                {onDisk} of {MAX_WORKTREES} worktrees
              </span>
            </div>
            {onDisk >= MAX_WORKTREES ? (
              <p className="ws-warning" role="note">
                <Icon name="alert" /> This repository is at the cap of {MAX_WORKTREES} worktrees.
                Remove one before another session can get its own.
              </p>
            ) : null}
            <ul className="ws-list" aria-label={`Worktrees of ${repo}`}>
              {list.map((w) => {
                const working = busy.has(w.id);
                const expired =
                  !!w.leaseExpiresAt && Date.parse(w.leaseExpiresAt) <= Date.now() && !!w.leasedBy;
                return (
                  <li key={w.id} className="code-wt-row" aria-label={w.branch}>
                    <div className="code-env-main">
                      <div className="code-row-title">
                        <span className="code-env-name">
                          <Icon name="branch" /> {w.branch}
                        </span>
                        {w.status === 'removed' ? (
                          <Badge tone="muted" icon="trash">
                            Removed
                          </Badge>
                        ) : w.dirty ? (
                          <Badge tone="warn" icon="edit">
                            Uncommitted changes
                          </Badge>
                        ) : w.dirty === false ? (
                          <Badge tone="ok" icon="check">
                            Clean
                          </Badge>
                        ) : (
                          <Badge tone="muted" icon="alert">
                            State unknown
                          </Badge>
                        )}
                      </div>
                      <span className="code-path">{w.path}</span>
                      <span className="muted code-row-meta">
                        <span>From {w.sourceBranch}</span>
                        <span>
                          {leaseText(w, sessionName)}
                          {w.leasedBy && w.status !== 'removed' ? (
                            <>
                              {' '}
                              <AppLink to={sessionPath(w.leasedBy)}>Open the session</AppLink>
                            </>
                          ) : null}
                        </span>
                        {w.included ? (
                          <span>{plural(w.included, 'ignored file')} copied in</span>
                        ) : null}
                        <span>Created {formatWhen(w.createdAt)}</span>
                      </span>
                    </div>
                    {w.status === 'removed' ? null : (
                      <div className="ws-row-actions code-actions">
                        {w.leasedBy && w.leaseExpiresAt ? (
                          <Button
                            disabled={working}
                            onClick={() =>
                              void act(w, 'Lease renewed', () => m6.renewWorktree(w.id, 60))
                            }
                          >
                            <Icon name="clock" /> {expired ? 'Renew lease' : 'Renew 1 h'}
                          </Button>
                        ) : null}
                        {w.leasedBy ? (
                          <Button
                            disabled={working}
                            onClick={() =>
                              void act(w, 'Lease released', () => m6.releaseWorktree(w.id))
                            }
                          >
                            Release
                          </Button>
                        ) : null}
                        <Button
                          variant="danger"
                          disabled={working || !!w.leasedBy}
                          title={w.leasedBy ? 'Release the lease first.' : undefined}
                          onClick={() => {
                            setRemoveError(null);
                            setRemoving(w);
                          }}
                        >
                          <Icon name="trash" /> Remove…
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove the worktree of ${removing?.branch ?? ''}?`}
        description={
          removing?.dirty
            ? 'It has uncommitted changes. Removing it deletes them from disk; they cannot be recovered. The branch and its commits stay.'
            : 'The folder is deleted from disk. The branch and its commits stay.'
        }
        confirmLabel={removing?.dirty ? 'Remove and delete changes' : 'Remove'}
        danger
        busy={removeBusy}
        error={removeError}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
      <NewWorktreeDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(w) => {
          setCreating(false);
          setItems((list) => [...(list ?? []), w]);
          toast.show(`Created ${w.branch}.`, { tone: 'success' });
        }}
      />
    </div>
  );
}

/** The cap message with the oldest removable worktree offered (FR-073). */
interface CapState {
  message: string;
  removable: number;
}

function NewWorktreeDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (w: WorktreeView) => void;
}) {
  return open ? <NewWorktreeForm onClose={onClose} onCreated={onCreated} /> : null;
}

function NewWorktreeForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (w: WorktreeView) => void;
}) {
  const m6 = useCodeM6Api();
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<CapState | null>(null);

  const submit = async (removeOldest = false) => {
    if (!repo.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await m6.createWorktree({
          repo: repo.trim(),
          ...(branch.trim() ? { branch: branch.trim() } : {}),
          ...(removeOldest ? { removeOldest: true } : {}),
        }),
      );
    } catch (err) {
      if (errorReason(err) === 'worktree_cap') {
        const removable = errorDetails(err).removable;
        setCap({
          message: `This repository already has ${MAX_WORKTREES} worktrees.`,
          removable: Array.isArray(removable) ? removable.length : 0,
        });
      } else setError(errorMessage(err, 'Could not create the worktree.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New worktree"
      description="A checkout of the repository’s current commit on a new nova/ branch. A session can work in it later."
      onClose={onClose}
    >
      <form
        className="stack code-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="Repository folder on the Hub"
          value={repo}
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="/home/me/projects/app"
          onChange={(e) => {
            setRepo(e.target.value);
            setCap(null);
          }}
        />
        <TextField
          label="Branch name (optional)"
          value={branch}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          placeholder="fix-login"
          hint="Nova names the branch nova/<name>, with a short suffix if it is taken."
          onChange={(e) => setBranch(e.target.value)}
        />
        {cap ? (
          <div className="code-callout" role="alert">
            <p>
              <Icon name="alert" /> {cap.message}{' '}
              {cap.removable
                ? 'The oldest one that no session uses and that has no uncommitted changes can be removed to make room.'
                : 'Every one of them is leased or has uncommitted changes, so none can be removed for you. Remove one yourself first.'}
            </p>
            {cap.removable ? (
              <Button variant="danger" disabled={busy} onClick={() => void submit(true)}>
                Remove the oldest and create
              </Button>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !repo.trim()}>
            {busy ? <Spinner /> : null} Create worktree
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
