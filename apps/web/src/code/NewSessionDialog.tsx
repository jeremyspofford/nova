// New Code session (FR-061, FR-062, FR-063, FR-073; docs/04 §2.4, docs/09 §2): a folder (a
// project folder, or a path typed for the Hub or for the chosen machine), the environment with
// its health (This Hub by default; saved container, SSH, WSL, device and cloud environments), the model,
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
import { defineMessages, fmt } from '@nova/i18n';
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

export const NEW_SESSION_TEXT = defineMessages('code.newSession', {
  minutesRange: 'Set the time limit in whole minutes, from {min} to {max}.',
  tokensRange: 'Set the token limit from {min} to {max}.',
  costRange: 'Set the cost limit from {min} to {max} US dollars.',
  loadFailed: 'Could not load folders and environments.',
  worktreeCap:
    'This repository already has 15 worktrees, the most it can hold. Remove one, or start without a new worktree.',
  leased: 'That worktree was just leased to another session. Pick another one.',
  worktreeRepo: 'That worktree belongs to another repository than the folder.',
  worktreeUnavailable: 'Worktrees are only available for folders on the Hub.',
  startFailed: 'Could not start the session.',
  tokens: '{amount} tokens',
  title: 'New Code session',
  description: 'Choose where the agent works and how much it may do without asking.',
  loading: 'Loading folders',
  loadingDots: 'Loading folders and environments…',
  environment: 'Environment',
  envState: '{status}.',
  envStateDetail: '{status}: {detail}.',
  manage: 'Manage environments',
  onHub: 'The session runs on the Hub.',
  folder: 'Folder',
  typed: 'A folder on the Hub…',
  folderHint: 'A project folder, or any folder on the Hub you type below.',
  noFolders: 'No project folders yet. Type a folder on the Hub, or add one to a project.',
  pathOn: 'Folder path on {machine}',
  thatMachine: 'that machine',
  pathOnHub: 'Folder path on the Hub',
  cloudPath: '/workspace/app',
  remotePath: '/home/me/src/app',
  hubPath: '/home/me/projects/app',
  cloudHint:
    'Cloud environments keep their repositories under /workspace. The session keeps running there while your devices are off.',
  model: 'Model',
  defaultModel: 'Default model',
  sessionTitle: 'Title (optional)',
  newWorktree: 'Work in a new Git worktree',
  existingPicked: 'The session works in the existing worktree you picked below.',
  ownBranch: 'The agent works on its own branch, nova/…, so your checkout stays as it is.',
  existing: 'Or work in an existing worktree',
  none: 'None',
  dirtyBranch: '{branch} (uncommitted changes)',
  existingHint:
    'Unleased worktrees of this repository. The session holds the lease until it is archived.',
  budgets: 'Budgets (optional)',
  defaults: 'Without your limits, the defaults from Settings → Code apply: {limits}.',
  noLimits:
    'Without limits, the session runs until you stop it. At a limit it stops and asks you to extend it.',
  minutes: 'Time limit (minutes)',
  tokenLimit: 'Token limit',
  costLimit: 'Cost limit (US dollars)',
  openWorktrees: 'Open Worktrees',
  cancel: 'Cancel',
  start: 'Start session',
});

/** The budgets to send (only those filled in), or the first problem. */
export function parseBudgets(
  d: BudgetDraft,
): { budgets: NonNullable<CreateBody['budgets']> | null } | { error: string } {
  const out: NonNullable<CreateBody['budgets']> = {};
  if (d.minutes.trim()) {
    const m = Number(d.minutes);
    if (!/^\d+$/.test(d.minutes.trim()) || m < 1 || m > 7 * 24 * 60)
      return { error: NEW_SESSION_TEXT.minutesRange({ min: 1, max: 7 * 24 * 60 }) };
    out.timeSeconds = m * 60;
  }
  if (d.tokens.trim()) {
    const t = Number(d.tokens);
    if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 1_000_000_000)
      return { error: NEW_SESSION_TEXT.tokensRange({ min: 1_000, max: 1_000_000_000 }) };
    out.tokens = t;
  }
  if (d.cost.trim()) {
    const c = Number(d.cost);
    if (!Number.isFinite(c) || c < 0.01 || c > 100_000)
      return { error: NEW_SESSION_TEXT.costRange({ min: 0.01, max: 100_000 }) };
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
        setLoadError(errorMessage(err, NEW_SESSION_TEXT.loadFailed));
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
              text: NEW_SESSION_TEXT.worktreeCap,
              worktrees: true,
            }
          : reason === 'leased'
            ? {
                text: NEW_SESSION_TEXT.leased,
                worktrees: true,
              }
            : reason === 'worktree_repo'
              ? { text: NEW_SESSION_TEXT.worktreeRepo }
              : reason === 'worktree_unavailable'
                ? { text: NEW_SESSION_TEXT.worktreeUnavailable }
                : { text: errorMessage(err, NEW_SESSION_TEXT.startFailed) },
      );
      setBusy(false);
    }
  };

  const defaultLine = [
    defaults.timeSeconds === null ? null : formatSpan(defaults.timeSeconds),
    defaults.tokens === null
      ? null
      : NEW_SESSION_TEXT.tokens({ amount: formatTokens(defaults.tokens) }),
    defaults.costUsd === null ? null : formatCost(defaults.costUsd),
  ].filter((x): x is string => !!x);

  return (
    <Dialog
      open
      title={NEW_SESSION_TEXT.title}
      description={NEW_SESSION_TEXT.description}
      onClose={onClose}
    >
      {loading ? (
        <p className="muted">
          <Spinner label={NEW_SESSION_TEXT.loading} /> {NEW_SESSION_TEXT.loadingDots}
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
              label={NEW_SESSION_TEXT.environment}
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
                    ? `${
                        environment.detail
                          ? NEW_SESSION_TEXT.envStateDetail({
                              status: HEALTH_TEXT[environment.status],
                              detail: environment.detail,
                            })
                          : NEW_SESSION_TEXT.envState({ status: HEALTH_TEXT[environment.status] })
                      } `
                    : null}
                  <AppLink to={ENVIRONMENTS_PATH}>{NEW_SESSION_TEXT.manage}</AppLink>
                </>
              }
            />
          ) : (
            <p className="muted">{NEW_SESSION_TEXT.onHub}</p>
          )}
          {remote ? null : (
            <SelectField
              label={NEW_SESSION_TEXT.folder}
              value={folderValue}
              onChange={setFolderChoice}
              options={[{ value: TYPED, label: NEW_SESSION_TEXT.typed }]}
              groups={groupFolders(folders)}
              hint={folders.length ? NEW_SESSION_TEXT.folderHint : NEW_SESSION_TEXT.noFolders}
            />
          )}
          {picked ? null : (
            <TextField
              label={
                remote
                  ? NEW_SESSION_TEXT.pathOn({
                      machine: environment?.label ?? NEW_SESSION_TEXT.thatMachine,
                    })
                  : NEW_SESSION_TEXT.pathOnHub
              }
              value={typedPath}
              required
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              placeholder={
                environment?.kind === 'cloud'
                  ? NEW_SESSION_TEXT.cloudPath
                  : remote
                    ? NEW_SESSION_TEXT.remotePath
                    : NEW_SESSION_TEXT.hubPath
              }
              hint={environment?.kind === 'cloud' ? NEW_SESSION_TEXT.cloudHint : undefined}
              onChange={(e) => setTypedPath(e.target.value)}
            />
          )}
          <SelectField
            label={NEW_SESSION_TEXT.model}
            value={model}
            onChange={setModel}
            options={[{ value: '', label: NEW_SESSION_TEXT.defaultModel }]}
            groups={modelGroups(models)}
          />
          <ModeSelect value={mode} onChange={setChosenMode} ctx={ctx} />
          <TextField
            label={NEW_SESSION_TEXT.sessionTitle}
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
            {NEW_SESSION_TEXT.newWorktree}
          </label>
          <span id={`${formId}-wt`} className="nv-field-hint">
            {remote
              ? NEW_SESSION_TEXT.worktreeUnavailable
              : existing
                ? NEW_SESSION_TEXT.existingPicked
                : NEW_SESSION_TEXT.ownBranch}
          </span>
          {bindable.length ? (
            <SelectField
              label={NEW_SESSION_TEXT.existing}
              value={existing ? existing.id : NO_WORKTREE}
              onChange={setWorktreeId}
              options={[
                { value: NO_WORKTREE, label: NEW_SESSION_TEXT.none },
                ...bindable.map((w) => ({
                  value: w.id,
                  label: w.dirty ? NEW_SESSION_TEXT.dirtyBranch({ branch: w.branch }) : w.branch,
                })),
              ]}
              hint={NEW_SESSION_TEXT.existingHint}
            />
          ) : null}
          <details className="code-budgets">
            <summary>{NEW_SESSION_TEXT.budgets}</summary>
            <p className="nv-field-hint">
              {defaultLine.length
                ? NEW_SESSION_TEXT.defaults({
                    limits: fmt.list(defaultLine, { type: 'unit', style: 'short' }),
                  })
                : NEW_SESSION_TEXT.noLimits}
            </p>
            <div className="code-form-row">
              <TextField
                label={NEW_SESSION_TEXT.minutes}
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1}
                step={1}
                value={budgetDraft.minutes}
                onChange={(e) => setBudgetDraft((d) => ({ ...d, minutes: e.target.value }))}
              />
              <TextField
                label={NEW_SESSION_TEXT.tokenLimit}
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1000}
                step={1000}
                value={budgetDraft.tokens}
                onChange={(e) => setBudgetDraft((d) => ({ ...d, tokens: e.target.value }))}
              />
              <TextField
                label={NEW_SESSION_TEXT.costLimit}
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
              {error.worktrees ? (
                <AppLink to={WORKTREES_PATH}>{NEW_SESSION_TEXT.openWorktrees}</AppLink>
              ) : null}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{NEW_SESSION_TEXT.cancel}</Button>
            <Button type="submit" variant="primary" disabled={!canCreate}>
              {busy ? <Spinner /> : null} {NEW_SESSION_TEXT.start}
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
