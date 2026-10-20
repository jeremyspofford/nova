// A project's folders on the Hub (FR-035): each one is indexed into the project's sources and
// becomes a file root for the project's chats, read-only or writable. While any folder is
// indexing, the list refreshes every 2 s.
import { useEffect, useState } from 'react';
import type { ProjectFolderView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { isAbsolutePath } from '../settings/PermissionsPage.tsx';

export const FOLDER_POLL_MS = 2000;

export const FOLDERS_TEXT = defineMessages('projects.folders', {
  status: {
    indexing: 'Indexing',
    ready: 'Ready',
    error: 'Could not index',
  },
  loadFailed: 'Could not load folders.',
  fullPath: 'Enter the full path of a folder on the Hub, for example /home/me/notes.',
  already: 'That folder is already in this project.',
  added: '{path} added. Indexing it now.',
  addFailed: 'Could not add the folder.',
  removed: '{path} removed from the project.',
  removeFailed: 'Could not remove {path}: {reason}',
  title: 'Folders',
  intro:
    'Folders on the Hub that this project’s chats can search and use. Their files are indexed as sources; nothing is copied.',
  retry: 'Retry',
  loading: 'Loading folders',
  none: 'No folders in this project yet.',
  list: 'Project folders',
  readWrite: 'Read and write',
  readOnly: 'Read only',
  files: '{n, plural, one {# file} other {# files}}',
  filesIndexed: '{n, plural, one {# file} other {# files}} · indexed {when}',
  removeLabel: 'Remove {path}',
  remove: 'Remove',
  folder: 'Folder on the Hub',
  pathExample: '/home/me/notes',
  access: 'Access',
  add: 'Add folder',
  removeTitle: 'Remove this folder from the project?',
  removeBody: '{path} stays on the Hub; only its index and access from this project are removed.',
  cancel: 'Cancel',
});

const STATUS_TONE: Record<ProjectFolderView['status'], string> = {
  indexing: 'running',
  ready: 'ready',
  error: 'blocked',
};

export function ProjectFolders({
  projectId,
  onChanged,
}: {
  projectId: string;
  /** Called after a folder is added or removed (the project's sources change with it). */
  onChanged?: () => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [folders, setFolders] = useState<ProjectFolderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [path, setPath] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectFolderView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listProjectFolders(projectId).then(
      ({ items }) => {
        if (!alive) return;
        setFolders(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, FOLDERS_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, projectId, version]);

  const busy = folders?.some((f) => f.status === 'indexing') ?? false;
  useInterval(() => setVersion((v) => v + 1), FOLDER_POLL_MS, busy);

  const add = async () => {
    const p = path.trim();
    if (!isAbsolutePath(p)) {
      setFormError(FOLDERS_TEXT.fullPath);
      return;
    }
    if (folders?.some((f) => f.path === p)) {
      setFormError(FOLDERS_TEXT.already);
      return;
    }
    setFormError(null);
    setAdding(true);
    try {
      const f = await api.addProjectFolder(projectId, { path: p, access });
      setFolders((list) => [...(list ?? []), f]);
      setPath('');
      toast.show(FOLDERS_TEXT.added({ path: p }), { tone: 'success' });
      onChanged?.();
    } catch (err) {
      setFormError(errorMessage(err, FOLDERS_TEXT.addFailed));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (f: ProjectFolderView) => {
    setRemoving(null);
    try {
      await api.removeProjectFolder(projectId, f.id);
      setFolders((list) => list?.filter((x) => x.id !== f.id) ?? null);
      toast.show(FOLDERS_TEXT.removed({ path: f.path }), { tone: 'success' });
      onChanged?.();
    } catch (err) {
      toast.show(FOLDERS_TEXT.removeFailed({ path: f.path, reason: errorMessage(err) }), {
        tone: 'error',
      });
    }
  };

  return (
    <section className="ws-section" aria-labelledby="project-folders">
      <h2 id="project-folders">{FOLDERS_TEXT.title}</h2>
      <p className="muted">{FOLDERS_TEXT.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{FOLDERS_TEXT.retry}</Button>
        </div>
      ) : null}
      {folders === null && !error ? <Spinner label={FOLDERS_TEXT.loading} /> : null}
      {folders?.length === 0 ? <p className="muted">{FOLDERS_TEXT.none}</p> : null}
      {folders?.length ? (
        <ul className="ws-list" aria-label={FOLDERS_TEXT.list}>
          {folders.map((f) => {
            return (
              <li key={f.id} className="ws-list-row" aria-label={f.path}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <code className="ws-code-inline" dir="ltr">
                      {f.path}
                    </code>
                    <span className="ws-badge">
                      {f.access === 'write' ? FOLDERS_TEXT.readWrite : FOLDERS_TEXT.readOnly}
                    </span>
                    <span className="nv-chip" data-status={STATUS_TONE[f.status]}>
                      {f.status === 'indexing' ? (
                        <Spinner />
                      ) : (
                        <Icon name={f.status === 'ready' ? 'check' : 'alert'} />
                      )}
                      <span>{FOLDERS_TEXT.status[f.status]}</span>
                    </span>
                  </span>
                  <span className="muted">
                    {f.indexedAt
                      ? FOLDERS_TEXT.filesIndexed({
                          n: f.fileCount,
                          when: formatWhen(f.indexedAt),
                        })
                      : FOLDERS_TEXT.files({ n: f.fileCount })}
                  </span>
                  {f.error ? <span className="ws-source-error">{f.error}</span> : null}
                </div>
                <Button
                  variant="ghost"
                  aria-label={FOLDERS_TEXT.removeLabel({ path: f.path })}
                  onClick={() => setRemoving(f)}
                >
                  {FOLDERS_TEXT.remove}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form
        className="ws-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField
          label={FOLDERS_TEXT.folder}
          value={path}
          spellCheck={false}
          dir="ltr"
          placeholder={FOLDERS_TEXT.pathExample}
          error={formError ?? undefined}
          onChange={(e) => setPath(e.target.value)}
        />
        <SelectField
          label={FOLDERS_TEXT.access}
          value={access}
          onChange={(v) => setAccess(v as 'read' | 'write')}
          options={[
            { value: 'read', label: FOLDERS_TEXT.readOnly },
            { value: 'write', label: FOLDERS_TEXT.readWrite },
          ]}
        />
        <Button type="submit" disabled={adding}>
          {adding ? <Spinner /> : <Icon name="plus" />} {FOLDERS_TEXT.add}
        </Button>
      </form>
      <Dialog
        open={removing !== null}
        title={FOLDERS_TEXT.removeTitle}
        description={removing ? FOLDERS_TEXT.removeBody({ path: removing.path }) : undefined}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{FOLDERS_TEXT.cancel}</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              {FOLDERS_TEXT.remove}
            </Button>
          </>
        }
      />
    </section>
  );
}
