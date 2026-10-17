// A project's folders on the Hub (FR-035): each one is indexed into the project's sources and
// becomes a file root for the project's chats, read-only or writable. While any folder is
// indexing, the list refreshes every 2 s.
import { useEffect, useState } from 'react';
import type { ProjectFolderView } from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatWhen, plural, useInterval } from '../settings/common.ts';
import { isAbsolutePath } from '../settings/PermissionsPage.tsx';

export const FOLDER_POLL_MS = 2000;

const STATUS: Record<ProjectFolderView['status'], { text: string; tone: string }> = {
  indexing: { text: 'Indexing', tone: 'running' },
  ready: { text: 'Ready', tone: 'ready' },
  error: { text: 'Could not index', tone: 'blocked' },
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load folders.')),
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
      setFormError('Enter the full path of a folder on the Hub, for example /home/me/notes.');
      return;
    }
    if (folders?.some((f) => f.path === p)) {
      setFormError('That folder is already in this project.');
      return;
    }
    setFormError(null);
    setAdding(true);
    try {
      const f = await api.addProjectFolder(projectId, { path: p, access });
      setFolders((list) => [...(list ?? []), f]);
      setPath('');
      toast.show(`${p} added. Indexing it now.`, { tone: 'success' });
      onChanged?.();
    } catch (err) {
      setFormError(errorMessage(err, 'Could not add the folder.'));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (f: ProjectFolderView) => {
    setRemoving(null);
    try {
      await api.removeProjectFolder(projectId, f.id);
      setFolders((list) => list?.filter((x) => x.id !== f.id) ?? null);
      toast.show(`${f.path} removed from the project.`, { tone: 'success' });
      onChanged?.();
    } catch (err) {
      toast.show(`Could not remove ${f.path}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section className="ws-section" aria-labelledby="project-folders">
      <h2 id="project-folders">Folders</h2>
      <p className="muted">
        Folders on the Hub that this project&apos;s chats can search and use. Their files are
        indexed as sources; nothing is copied.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {folders === null && !error ? <Spinner label="Loading folders" /> : null}
      {folders?.length === 0 ? <p className="muted">No folders in this project yet.</p> : null}
      {folders?.length ? (
        <ul className="ws-list" aria-label="Project folders">
          {folders.map((f) => {
            const s = STATUS[f.status];
            return (
              <li key={f.id} className="ws-list-row" aria-label={f.path}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <code className="ws-code-inline">{f.path}</code>
                    <span className="ws-badge">
                      {f.access === 'write' ? 'Read and write' : 'Read only'}
                    </span>
                    <span className="nv-chip" data-status={s.tone}>
                      {f.status === 'indexing' ? (
                        <Spinner />
                      ) : (
                        <Icon name={f.status === 'ready' ? 'check' : 'alert'} />
                      )}
                      <span>{s.text}</span>
                    </span>
                  </span>
                  <span className="muted">
                    {plural(f.fileCount, 'file')}
                    {f.indexedAt ? ` · indexed ${formatWhen(f.indexedAt)}` : ''}
                  </span>
                  {f.error ? <span className="ws-source-error">{f.error}</span> : null}
                </div>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${f.path}`}
                  onClick={() => setRemoving(f)}
                >
                  Remove
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
          label="Folder on the Hub"
          value={path}
          spellCheck={false}
          placeholder="/home/me/notes"
          error={formError ?? undefined}
          onChange={(e) => setPath(e.target.value)}
        />
        <SelectField
          label="Access"
          value={access}
          onChange={(v) => setAccess(v as 'read' | 'write')}
          options={[
            { value: 'read', label: 'Read only' },
            { value: 'write', label: 'Read and write' },
          ]}
        />
        <Button type="submit" disabled={adding}>
          {adding ? <Spinner /> : <Icon name="plus" />} Add folder
        </Button>
      </form>
      <Dialog
        open={removing !== null}
        title="Remove this folder from the project?"
        description={
          removing
            ? `${removing.path} stays on the Hub; only its index and access from this project are removed.`
            : undefined
        }
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              Remove
            </Button>
          </>
        }
      />
    </section>
  );
}
