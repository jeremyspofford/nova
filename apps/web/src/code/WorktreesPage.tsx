// Worktrees at /code/worktrees (FR-073; docs/10 §9): the registry of Git worktrees on the Hub,
// grouped by repository, each with its branch, whether it has uncommitted changes, and its lease
// (which session holds it and until when). Renew extends a lease; Release drops it (refused while
// a session works in it); Remove deletes it from disk (its branch stays; a worktree with
// uncommitted changes needs Remove anyway, after a warning). A repository holds at most 15: at the
// cap, New worktree offers to remove the oldest unused clean one, and only does when you accept.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { defineMessages } from '@nova/i18n';
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
import { formatWhen } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink, CodeNav } from './CodeNav.tsx';
import { useCodeEvents, useCoalesced } from './events.ts';
import { sessionPath, sessionTitle } from './labels.ts';
import { errorDetails, errorReason, leaseText } from './m6-format.ts';
import { Badge, ConfirmDialog, ErrorBanner } from './parts.tsx';
import '../workspace.css';

export const WORKTREES_TEXT = defineMessages('code.worktrees', {
  loadFailed: 'Could not load the worktrees.',
  quotedSession: '“{title}”',
  aSession: 'a session',
  renewed: 'Lease renewed: {branch}.',
  released: 'Lease released: {branch}.',
  inUse: 'A Code session works in {branch}. Archive the session first.',
  renewFailed: 'Could not renew the lease of {branch}: {reason}',
  releaseFailed: 'Could not release the lease of {branch}: {reason}',
  removed: 'Removed the worktree of {branch}. The branch stays.',
  removeInUse: 'A Code session works in this worktree. Archive the session first.',
  removeLeased: 'This worktree is leased. Release it first.',
  removeDirty: 'This worktree has uncommitted changes.',
  removeFailed: 'Could not remove the worktree.',
  title: 'Worktrees',
  new: 'New worktree',
  intro:
    'Each worktree is a separate checkout on its own nova/ branch, so parallel sessions do not touch each other’s files. A repository holds at most {max}.',
  show: 'Show',
  onDisk: 'Worktrees on disk',
  all: 'All, including removed',
  loading: 'Loading the worktrees',
  emptyTitle: 'No worktrees',
  emptyBody:
    'Start a session with “Work in a new Git worktree”, or create one here for a session to use later.',
  count: '{n} of {max} worktrees',
  atCap:
    'This repository is at the cap of {max} worktrees. Remove one before another session can get its own.',
  listOf: 'Worktrees of {repo}',
  stateRemoved: 'Removed',
  dirty: 'Uncommitted changes',
  clean: 'Clean',
  unknown: 'State unknown',
  from: 'From {branch}',
  openSession: 'Open the session',
  included: '{n, plural, one {# ignored file copied in} other {# ignored files copied in}}',
  created: 'Created {when}',
  renewLease: 'Renew lease',
  renewHour: 'Renew 1 h',
  release: 'Release',
  releaseFirst: 'Release the lease first.',
  remove: 'Remove…',
  removeTitle: 'Remove the worktree of {branch}?',
  removeDirtyBody:
    'It has uncommitted changes. Removing it deletes them from disk; they cannot be recovered. The branch and its commits stay.',
  removeBody: 'The folder is deleted from disk. The branch and its commits stay.',
  removeAndDelete: 'Remove and delete changes',
  removeConfirm: 'Remove',
  createdToast: 'Created {branch}.',
  cap: 'This repository already has {max} worktrees.',
  createFailed: 'Could not create the worktree.',
  dialogTitle: 'New worktree',
  dialogBody:
    'A checkout of the repository’s current commit on a new nova/ branch. A session can work in it later.',
  repo: 'Repository folder on the Hub',
  repoExample: '/home/me/projects/app',
  branch: 'Branch name (optional)',
  branchExample: 'fix-login',
  branchHint: 'Nova names the branch nova/<name>, with a short suffix if it is taken.',
  canRemove:
    'The oldest one that no session uses and that has no uncommitted changes can be removed to make room.',
  cannotRemove:
    'Every one of them is leased or has uncommitted changes, so none can be removed for you. Remove one yourself first.',
  removeOldest: 'Remove the oldest and create',
  cancel: 'Cancel',
  create: 'Create worktree',
});

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
        (err: unknown) => setError(errorMessage(err, WORKTREES_TEXT.loadFailed)),
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
    return s ? WORKTREES_TEXT.quotedSession({ title: sessionTitle(s) }) : WORKTREES_TEXT.aSession;
  };
  const groups = useMemo(() => {
    const byRepo = new Map<string, WorktreeView[]>();
    for (const w of items ?? []) byRepo.set(w.repoPath, [...(byRepo.get(w.repoPath) ?? []), w]);
    return [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const act = async (
    w: WorktreeView,
    what: 'renew' | 'release',
    fn: () => Promise<WorktreeView>,
  ) => {
    setBusy((s) => new Set([...s, w.id]));
    try {
      const next = await fn();
      setItems((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null);
      announce(
        what === 'renew'
          ? WORKTREES_TEXT.renewed({ branch: w.branch })
          : WORKTREES_TEXT.released({ branch: w.branch }),
      );
    } catch (err) {
      const reason = errorReason(err);
      const p = { branch: w.branch, reason: errorMessage(err) };
      toast.show(
        reason === 'in_use'
          ? WORKTREES_TEXT.inUse({ branch: w.branch })
          : what === 'renew'
            ? WORKTREES_TEXT.renewFailed(p)
            : WORKTREES_TEXT.releaseFailed(p),
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
      toast.show(WORKTREES_TEXT.removed({ branch: w.branch }), { tone: 'success' });
    } catch (err) {
      const reason = errorReason(err);
      setRemoveError(
        reason === 'in_use'
          ? WORKTREES_TEXT.removeInUse
          : reason === 'leased'
            ? WORKTREES_TEXT.removeLeased
            : reason === 'dirty'
              ? WORKTREES_TEXT.removeDirty
              : errorMessage(err, WORKTREES_TEXT.removeFailed),
      );
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div className="ws-page code-m6-page">
      <header className="ws-page-header">
        <h1>{WORKTREES_TEXT.title}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {WORKTREES_TEXT.new}
        </Button>
      </header>
      <CodeNav current="worktrees" />
      <p className="muted">{WORKTREES_TEXT.intro({ max: MAX_WORKTREES })}</p>
      <SelectField
        label={WORKTREES_TEXT.show}
        className="code-filter"
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        options={[
          { value: 'active', label: WORKTREES_TEXT.onDisk },
          { value: 'all', label: WORKTREES_TEXT.all },
        ]}
      />
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {items === null && !error ? <Spinner label={WORKTREES_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title={WORKTREES_TEXT.emptyTitle}
          description={WORKTREES_TEXT.emptyBody}
          icon="branch"
          action={<Button onClick={() => setCreating(true)}>{WORKTREES_TEXT.new}</Button>}
        />
      ) : null}
      {groups.map(([repo, list]) => {
        const onDisk = list.filter((w) => w.status !== 'removed').length;
        return (
          <section key={repo} className="code-wt-group" aria-label={repo}>
            <div className="code-subhead">
              <h2 className="code-path" dir="ltr">
                {repo}
              </h2>
              <span className="muted">
                {WORKTREES_TEXT.count({ n: onDisk, max: MAX_WORKTREES })}
              </span>
            </div>
            {onDisk >= MAX_WORKTREES ? (
              <p className="ws-warning" role="note">
                <Icon name="alert" /> {WORKTREES_TEXT.atCap({ max: MAX_WORKTREES })}
              </p>
            ) : null}
            <ul className="ws-list" aria-label={WORKTREES_TEXT.listOf({ repo })}>
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
                            {WORKTREES_TEXT.stateRemoved}
                          </Badge>
                        ) : w.dirty ? (
                          <Badge tone="warn" icon="edit">
                            {WORKTREES_TEXT.dirty}
                          </Badge>
                        ) : w.dirty === false ? (
                          <Badge tone="ok" icon="check">
                            {WORKTREES_TEXT.clean}
                          </Badge>
                        ) : (
                          <Badge tone="muted" icon="alert">
                            {WORKTREES_TEXT.unknown}
                          </Badge>
                        )}
                      </div>
                      <span className="code-path" dir="ltr">
                        {w.path}
                      </span>
                      <span className="muted code-row-meta">
                        <span>{WORKTREES_TEXT.from({ branch: w.sourceBranch })}</span>
                        <span>
                          {leaseText(w, sessionName)}
                          {w.leasedBy && w.status !== 'removed' ? (
                            <>
                              {' '}
                              <AppLink to={sessionPath(w.leasedBy)}>
                                {WORKTREES_TEXT.openSession}
                              </AppLink>
                            </>
                          ) : null}
                        </span>
                        {w.included ? (
                          <span>{WORKTREES_TEXT.included({ n: w.included })}</span>
                        ) : null}
                        <span>{WORKTREES_TEXT.created({ when: formatWhen(w.createdAt) })}</span>
                      </span>
                    </div>
                    {w.status === 'removed' ? null : (
                      <div className="ws-row-actions code-actions">
                        {w.leasedBy && w.leaseExpiresAt ? (
                          <Button
                            disabled={working}
                            onClick={() => void act(w, 'renew', () => m6.renewWorktree(w.id, 60))}
                          >
                            <Icon name="clock" />{' '}
                            {expired ? WORKTREES_TEXT.renewLease : WORKTREES_TEXT.renewHour}
                          </Button>
                        ) : null}
                        {w.leasedBy ? (
                          <Button
                            disabled={working}
                            onClick={() => void act(w, 'release', () => m6.releaseWorktree(w.id))}
                          >
                            {WORKTREES_TEXT.release}
                          </Button>
                        ) : null}
                        <Button
                          variant="danger"
                          disabled={working || !!w.leasedBy}
                          title={w.leasedBy ? WORKTREES_TEXT.releaseFirst : undefined}
                          onClick={() => {
                            setRemoveError(null);
                            setRemoving(w);
                          }}
                        >
                          <Icon name="trash" /> {WORKTREES_TEXT.remove}
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
        title={WORKTREES_TEXT.removeTitle({ branch: removing?.branch ?? '' })}
        description={removing?.dirty ? WORKTREES_TEXT.removeDirtyBody : WORKTREES_TEXT.removeBody}
        confirmLabel={
          removing?.dirty ? WORKTREES_TEXT.removeAndDelete : WORKTREES_TEXT.removeConfirm
        }
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
          toast.show(WORKTREES_TEXT.createdToast({ branch: w.branch }), { tone: 'success' });
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
          message: WORKTREES_TEXT.cap({ max: MAX_WORKTREES }),
          removable: Array.isArray(removable) ? removable.length : 0,
        });
      } else setError(errorMessage(err, WORKTREES_TEXT.createFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={WORKTREES_TEXT.dialogTitle}
      description={WORKTREES_TEXT.dialogBody}
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
          label={WORKTREES_TEXT.repo}
          value={repo}
          required
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          placeholder={WORKTREES_TEXT.repoExample}
          onChange={(e) => {
            setRepo(e.target.value);
            setCap(null);
          }}
        />
        <TextField
          label={WORKTREES_TEXT.branch}
          value={branch}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          placeholder={WORKTREES_TEXT.branchExample}
          hint={WORKTREES_TEXT.branchHint}
          onChange={(e) => setBranch(e.target.value)}
        />
        {cap ? (
          <div className="code-callout" role="alert">
            <p>
              <Icon name="alert" /> {cap.message}{' '}
              {cap.removable ? WORKTREES_TEXT.canRemove : WORKTREES_TEXT.cannotRemove}
            </p>
            {cap.removable ? (
              <Button variant="danger" disabled={busy} onClick={() => void submit(true)}>
                {WORKTREES_TEXT.removeOldest}
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
          <Button onClick={onClose}>{WORKTREES_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !repo.trim()}>
            {busy ? <Spinner /> : null} {WORKTREES_TEXT.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
