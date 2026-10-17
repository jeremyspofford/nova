// New Code session (FR-061, FR-062, FR-063, FR-073; docs/04 §2.4): a folder (a project folder,
// or a path typed for the Hub), the environment, the model, the permission mode and an optional
// Git worktree. The mode starts as the one last used in that folder, else the default from
// Settings → Code; unavailable modes are listed with the reason.
import { useEffect, useId, useState } from 'react';
import type {
  CodeSessionView,
  EnvironmentView,
  PermissionMode,
  ProjectFolderView,
  ProjectView,
} from '@nova/shared';
import { Button, Dialog, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { environmentLabel } from './labels.ts';
import { ModeSelect, useModeContext } from './ModeSelect.tsx';
import { initialMode, modeUnavailable } from './modes.ts';

/** The folder select's value for "type a path on the Hub". */
const TYPED = '__typed';

interface FolderChoice {
  folder: ProjectFolderView;
  project: ProjectView;
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
  const settings = useSettings();
  const { models } = useModels();
  const formId = `ns${useId()}`;
  const [folders, setFolders] = useState<FolderChoice[] | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folderChoice, setFolderChoice] = useState<string | null>(null);
  const [typedPath, setTypedPath] = useState('');
  const [envChoice, setEnvChoice] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [chosenMode, setChosenMode] = useState<PermissionMode | null>(null);
  const [title, setTitle] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    return () => {
      alive = false;
    };
  }, [api]);

  // Defaults until the user picks: the first project folder, and a working local environment.
  const folderValue = folderChoice ?? (folders?.[0] ? folders[0].folder.id : TYPED);
  const picked = folders?.find((f) => f.folder.id === folderValue) ?? null;
  const path = picked ? picked.folder.path : typedPath.trim();
  const usable = (environments ?? []).filter((e) => e.status !== 'down');
  const envValue =
    envChoice ?? (usable.find((e) => e.kind === 'local') ?? usable[0] ?? null)?.id ?? '';
  const environment = environments?.find((e) => e.id === envValue) ?? null;
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

  const loading = folders === null || environments === null;
  const canCreate = !loading && !busy && !!path;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.createCodeSession({
        folder: path,
        permissionMode: mode,
        ...(picked ? { projectId: picked.project.id } : {}),
        ...(envValue ? { environmentId: envValue } : {}),
        ...(model ? { model } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(worktree ? { worktree: true } : {}),
      });
      onCreated(s);
    } catch (err) {
      setError(errorMessage(err, 'Could not start the session.'));
      setBusy(false);
    }
  };

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
          {picked ? null : (
            <TextField
              label="Folder path on the Hub"
              value={typedPath}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="/home/me/projects/app"
              onChange={(e) => setTypedPath(e.target.value)}
            />
          )}
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
            />
          ) : (
            <p className="muted">The session runs on the Hub.</p>
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
              checked={worktree}
              aria-describedby={`${formId}-wt`}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            Work in a new Git worktree
          </label>
          <span id={`${formId}-wt`} className="nv-field-hint">
            The agent works on its own branch, nova/…, so your checkout stays as it is.
          </span>
          {error ? (
            <p className="nv-field-error" role="alert">
              {error}
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
