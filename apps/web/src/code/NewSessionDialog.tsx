// New Code session (FR-061, FR-062, FR-063, FR-073; docs/04 §2.4, docs/09 §2): a folder (a
// project folder, or a path typed for the Hub or for the chosen machine), the environment with
// its health (This Hub by default; saved container, SSH, WSL and device environments), the model,
// the permission mode, a new Git worktree or an existing unleased one from the registry, and
// optional time, token and cost budgets. The mode starts as the one last used in that folder,
// else the default from Settings → Code; unavailable modes are listed with the reason.
import { useEffect, useId, useState } from 'react';
import type { z } from 'zod';
import type {
  CodeSessionView,
  EnvironmentView,
  PermissionMode,
  ProjectFolderView,
  ProjectView,
  WorktreeView,
  createCodeSessionM6Schema,
} from '@nova/shared';
import { Button, Dialog, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink, ENVIRONMENTS_PATH, WORKTREES_PATH } from './CodeNav.tsx';
import { environmentLabel } from './labels.ts';
import {
  HEALTH_TEXT,
  errorReason,
  formatCost,
  formatSpan,
  formatTokens,
  inRepo,
  isBindable,
  isRemoteKind,
} from './m6-format.ts';
import { ModeSelect, useModeContext } from './ModeSelect.tsx';
import { initialMode, modeUnavailable } from './modes.ts';

type CreateBody = z.input<typeof createCodeSessionM6Schema>;

/** The folder select's value for "type a path on the Hub". */
const TYPED = '__typed';
/** The existing-worktree select's value for "none". */
const NO_WORKTREE = '';

interface FolderChoice {
  folder: ProjectFolderView;
  project: ProjectView;
}

export interface BudgetDraft {
  minutes: string;
  tokens: string;
  cost: string;
}

/** The budgets to send (only those filled in), or the first problem. */
export function parseBudgets(
  d: BudgetDraft,
): { budgets: NonNullable<CreateBody['budgets']> | null } | { error: string } {
  const out: NonNullable<CreateBody['budgets']> = {};
  if (d.minutes.trim()) {
    const m = Number(d.minutes);
    if (!/^\d+$/.test(d.minutes.trim()) || m < 1 || m > 7 * 24 * 60)
      return { error: 'Set the time limit in whole minutes, from 1 to 10,080.' };
    out.timeSeconds = m * 60;
  }
  if (d.tokens.trim()) {
    const t = Number(d.tokens);
    if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 1_000_000_000)
      return { error: 'Set the token limit from 1,000 to 1,000,000,000.' };
    out.tokens = t;
  }
  if (d.cost.trim()) {
    const c = Number(d.cost);
    if (!Number.isFinite(c) || c < 0.01 || c > 100_000)
      return { error: 'Set the cost limit from 0.01 to 100,000 US dollars.' };
    out.costUsd = c;
  }
  return { budgets: Object.keys(out).length ? out : null };
}

export function NewSessionDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (s: CodeSessionView) => void;
}) {
  return open ? <NewSessionForm onClose={onClose} onCreated={onCreated} /> : null;
}

function NewSessionForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: CodeSessionView) => void;
}) {
  const { api } = useServices();
  const m6 = useCodeM6Api();
  const settings = useSettings();
  const { models } = useModels();
  const formId = `ns${useId()}`;
  const [folders, setFolders] = useState<FolderChoice[] | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentView[] | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folderChoice, setFolderChoice] = useState<string | null>(null);
  const [typedPath, setTypedPath] = useState('');
  const [envChoice, setEnvChoice] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [chosenMode, setChosenMode] = useState<PermissionMode | null>(null);
  const [title, setTitle] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [worktreeId, setWorktreeId] = useState(NO_WORKTREE);
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>({
    minutes: '',
    tokens: '',
    cost: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; worktrees?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    const loadFolders = async (): Promise<FolderChoice[]> => {
      const { items: projects } = await api.listProjects();
      const lists = await Promise.all(
        projects.map((p) =>
          api.listProjectFolders(p.id).then(
            ({ items }) => items.map((folder) => ({ folder, project: p })),
            // One project's folders failing to load leaves the others usable.
            () => [] as FolderChoice[],
          ),
        ),
      );
      return lists.flat();
    };
    Promise.all([loadFolders(), api.listEnvironments()]).then(
      ([f, { items }]) => {
        if (!alive) return;
        setFolders(f);
        setEnvironments(items);
      },
      (err: unknown) => {
        if (!alive) return;
        setLoadError(errorMessage(err, 'Could not load folders and environments.'));
        setFolders([]);
        setEnvironments([]);
      },
    );
    // Existing worktrees are an option when the registry can be read; otherwise only new ones.
    m6.listWorktrees({ status: 'active' }).then(
      ({ items }) => alive && setWorktrees(items),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, m6]);

  // Defaults until the user picks: a working local environment, and the first project folder.
  const usable = (environments ?? []).filter((e) => e.status !== 'down');
  const envValue =
    envChoice ?? (usable.find((e) => e.kind === 'local') ?? usable[0] ?? null)?.id ?? '';
  const environment = environments?.find((e) => e.id === envValue) ?? null;
  // A session on another machine works in a folder there; project folders are on the Hub.
  const remote = isRemoteKind(environment?.kind);
  const folderValue = remote
    ? TYPED
    : (folderChoice ?? (folders?.[0] ? folders[0].folder.id : TYPED));
  const picked = remote ? null : (folders?.find((f) => f.folder.id === folderValue) ?? null);
  const path = picked ? picked.folder.path : typedPath.trim();
  const ctx = useModeContext(environment);
  const startMode = initialMode(
    path,
    {
      permissionMode: settings.get('code.permissionMode').value,
      folderModes: settings.get('code.folderModes').value,
    },
    ctx,
  );
  // A mode the user chose stays unless the new environment cannot run it.
  const mode =
    chosenMode && !modeUnavailable(chosenMode, ctx)
      ? chosenMode
      : chosenMode
        ? 'manual'
        : startMode;

  // Unleased worktrees of the folder's repository (the Hub checks the repository again).
  const bindable = remote
    ? []
    : worktrees.filter((w) => isBindable(w) && !!path && inRepo(path, w.repoPath));
  const existing = bindable.find((w) => w.id === worktreeId) ?? null;
  const defaults = settings.get('code.budgets').value;
  const parsedBudgets = parseBudgets(budgetDraft);

  const loading = folders === null || environments === null;
  const canCreate = !loading && !busy && !!path && !('error' in parsedBudgets);

  const submit = async () => {
    if (!canCreate || 'error' in parsedBudgets) return;
    setBusy(true);
    setError(null);
    const body: CreateBody = {
      folder: path,
      permissionMode: mode,
      ...(picked ? { projectId: picked.project.id } : {}),
      ...(envValue ? { environmentId: envValue } : {}),
      ...(model ? { model } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(worktree && !remote && !existing ? { worktree: true } : {}),
      ...(existing ? { worktreeId: existing.id } : {}),
      ...(parsedBudgets.budgets ? { budgets: parsedBudgets.budgets } : {}),
    };
    try {
      onCreated(await api.createCodeSession(body));
    } catch (err) {
      const reason = errorReason(err);
      setError(
        reason === 'worktree_cap'
          ? {
              text: 'This repository already has 15 worktrees, the most it can hold. Remove one, or start without a new worktree.',
              worktrees: true,
            }
          : reason === 'leased'
            ? {
                text: 'That worktree was just leased to another session. Pick another one.',
                worktrees: true,
              }
            : reason === 'worktree_repo'
              ? { text: 'That worktree belongs to another repository than the folder.' }
              : reason === 'worktree_unavailable'
                ? { text: 'Worktrees are only available for folders on the Hub.' }
                : { text: errorMessage(err, 'Could not start the session.') },
      );
      setBusy(false);
    }
  };

  const defaultLine = [
    defaults.timeSeconds === null ? null : formatSpan(defaults.timeSeconds),
    defaults.tokens === null ? null : `${formatTokens(defaults.tokens)} tokens`,
    defaults.costUsd === null ? null : formatCost(defaults.costUsd),
  ].filter(Boolean);

  return (
    <Dialog
      open
      title="New Code session"
      description="Choose where the agent works and how much it may do without asking."
      onClose={onClose}
    >
      {loading ? (
        <p className="muted">
          <Spinner label="Loading folders" /> Loading folders and environments…
        </p>
      ) : (
        <form
          id={formId}
          className="stack code-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {loadError ? (
            <p className="nv-field-error" role="alert">
              {loadError}
            </p>
          ) : null}
          {environments.length ? (
            <SelectField
              label="Environment"
              value={envValue}
              onChange={setEnvChoice}
              options={environments.map((e) => ({
                value: e.id,
                label: environmentLabel(e),
                disabled: e.status === 'down',
                ...(e.detail ? { title: e.detail } : {}),
              }))}
              hint={
                <>
                  {environment && environment.status !== 'ok'
                    ? `${HEALTH_TEXT[environment.status]}${environment.detail ? `: ${environment.detail}` : ''}. `
                    : null}
                  <AppLink to={ENVIRONMENTS_PATH}>Manage environments</AppLink>
                </>
              }
            />
          ) : (
            <p className="muted">The session runs on the Hub.</p>
          )}
          {remote ? null : (
            <SelectField
              label="Folder"
              value={folderValue}
              onChange={setFolderChoice}
              options={[{ value: TYPED, label: 'A folder on the Hub…' }]}
              groups={groupFolders(folders)}
              hint={
                folders.length
                  ? 'A project folder, or any folder on the Hub you type below.'
                  : 'No project folders yet. Type a folder on the Hub, or add one to a project.'
              }
            />
          )}
          {picked ? null : (
            <TextField
              label={
                remote
                  ? `Folder path on ${environment?.label ?? 'that machine'}`
                  : 'Folder path on the Hub'
              }
              value={typedPath}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder={remote ? '/home/me/src/app' : '/home/me/projects/app'}
              onChange={(e) => setTypedPath(e.target.value)}
            />
          )}
          <SelectField
            label="Model"
            value={model}
            onChange={setModel}
            options={[{ value: '', label: 'Default model' }]}
            groups={modelGroups(models)}
          />
          <ModeSelect value={mode} onChange={setChosenMode} ctx={ctx} />
          <TextField
            label="Title (optional)"
            value={title}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => setTitle(e.target.value)}
          />
          <label className="code-check">
            <input
              type="checkbox"
              checked={worktree && !remote && !existing}
              disabled={remote || !!existing}
              aria-describedby={`${formId}-wt`}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            Work in a new Git worktree
          </label>
          <span id={`${formId}-wt`} className="nv-field-hint">
            {remote
              ? 'Worktrees are only available for folders on the Hub.'
              : existing
                ? 'The session works in the existing worktree you picked below.'
                : 'The agent works on its own branch, nova/…, so your checkout stays as it is.'}
          </span>
          {bindable.length ? (
            <SelectField
              label="Or work in an existing worktree"
              value={existing ? existing.id : NO_WORKTREE}
              onChange={setWorktreeId}
              options={[
                { value: NO_WORKTREE, label: 'None' },
                ...bindable.map((w) => ({
                  value: w.id,
                  label: `${w.branch}${w.dirty ? ' (uncommitted changes)' : ''}`,
                })),
              ]}
              hint="Unleased worktrees of this repository. The session holds the lease until it is archived."
            />
          ) : null}
          <details className="code-budgets">
            <summary>Budgets (optional)</summary>
            <p className="nv-field-hint">
              {defaultLine.length
                ? `Without your limits, the defaults from Settings → Code apply: ${defaultLine.join(', ')}.`
                : 'Without limits, the session runs until you stop it. At a limit it stops and asks you to extend it.'}
            </p>
            <div className="code-form-row">
              <TextField
                label="Time limit (minutes)"
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1}
                step={1}
                value={budgetDraft.minutes}
                onChange={(e) => setBudgetDraft((d) => ({ ...d, minutes: e.target.value }))}
              />
              <TextField
                label="Token limit"
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1000}
                step={1000}
                value={budgetDraft.tokens}
                onChange={(e) => setBudgetDraft((d) => ({ ...d, tokens: e.target.value }))}
              />
              <TextField
                label="Cost limit (US dollars)"
                type="number"
                inputMode="decimal"
                className="ws-number"
                min={0.01}
                step={0.01}
                value={budgetDraft.cost}
                onChange={(e) => setBudgetDraft((d) => ({ ...d, cost: e.target.value }))}
              />
            </div>
            {'error' in parsedBudgets ? (
              <p className="nv-field-error" role="alert">
                {parsedBudgets.error}
              </p>
            ) : null}
          </details>
          {error ? (
            <p className="nv-field-error" role="alert">
              {error.text}{' '}
              {error.worktrees ? <AppLink to={WORKTREES_PATH}>Open Worktrees</AppLink> : null}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!canCreate}>
              {busy ? <Spinner /> : null} Start session
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function groupFolders(folders: FolderChoice[]) {
  const groups = new Map<string, { label: string; options: { value: string; label: string }[] }>();
  for (const { folder, project } of folders) {
    const g = groups.get(project.id) ?? { label: project.name, options: [] };
    g.options.push({ value: folder.id, label: folder.path });
    groups.set(project.id, g);
  }
  return [...groups.values()];
}
