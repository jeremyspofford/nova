// File browser (FR-039): the folders the open chat's tools can reach plus its project's folders
// (GET /files/roots), as a keyboard-navigable tree that loads a folder when it opens. Enter or a
// click opens a text file in the editor and anything else in the preview.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileEntryView } from '@nova/shared';
import { Button, Icon, IconButton, SelectField, Spinner, Tree, type TreeNode } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { formatBytes } from '../chat/attachments.ts';
import type { FileRef } from '../layout/model.ts';
import { useServices } from '../services.tsx';
import { opensIn } from './types.ts';

export interface FileRoot {
  path: string;
  label: string;
  access: 'read' | 'write';
}

export interface FileBrowserProps {
  threadId: string | null;
  projectId: string | null;
  onOpen: (file: FileRef, where: 'editor' | 'preview') => void;
}

interface Folder {
  items: FileEntryView[] | null;
  error: string | null;
}

export function FileBrowser({ threadId, projectId, onOpen }: FileBrowserProps) {
  const { api } = useServices();
  const [roots, setRoots] = useState<FileRoot[] | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .fileRoots({
        ...(threadId ? { threadId } : {}),
        ...(projectId ? { projectId } : {}),
      })
      .then(
        ({ items }) => {
          if (!alive) return;
          setRoots(items);
          setRootsError(null);
        },
        (err: unknown) => {
          if (alive) setRootsError(errorMessage(err, 'Could not load the folders.'));
        },
      );
    return () => {
      alive = false;
    };
  }, [api, threadId, projectId, attempt]);

  const root = roots?.find((r) => r.path === picked) ?? roots?.[0] ?? null;
  const rootPath = root?.path ?? null;

  // A folder keeps its last listing while it reloads; state changes only when the Hub answers.
  const load = useCallback(
    (dir: string) => {
      if (!rootPath) return;
      api.listFiles(rootPath, dir).then(
        ({ items }) =>
          setFolders((f) => ({ ...f, [dir]: { items: sortEntries(items), error: null } })),
        (err: unknown) =>
          setFolders((f) => ({
            ...f,
            [dir]: { items: f[dir]?.items ?? null, error: errorMessage(err, 'Could not load.') },
          })),
      );
    },
    [api, rootPath],
  );

  // A new root starts closed, with its top folder listed.
  const [shownRoot, setShownRoot] = useState<string | null>(null);
  if (rootPath !== shownRoot) {
    setShownRoot(rootPath);
    setFolders({});
    setExpanded(new Set());
  }
  useEffect(() => {
    if (rootPath) load('');
  }, [rootPath, load]);

  const entries = useMemo(() => {
    const byPath = new Map<string, FileEntryView>();
    for (const f of Object.values(folders)) for (const e of f.items ?? []) byPath.set(e.path, e);
    return byPath;
  }, [folders]);

  const nodes = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (dir: string, parentId: string | null) => {
      for (const e of folders[dir]?.items ?? []) {
        const folder = folders[e.path];
        out.push({
          id: e.path,
          parentId,
          expandable: e.kind === 'dir',
          label: (
            <>
              <Icon name={e.kind === 'dir' ? 'folder' : 'file'} /> {e.name}
            </>
          ),
          detail:
            e.kind === 'dir'
              ? folder?.error
                ? 'Could not load'
                : expanded.has(e.path) && !folder?.items
                  ? 'Loading…'
                  : undefined
              : e.size !== null
                ? formatBytes(e.size)
                : undefined,
        });
        if (e.kind === 'dir' && expanded.has(e.path)) walk(e.path, e.path);
      }
    };
    walk('', null);
    return out;
  }, [folders, expanded]);

  const toggle = (id: string, open: boolean) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    if (open && !folders[id]?.items) load(id);
  };

  const activate = (id: string) => {
    const e = entries.get(id);
    if (!e || !rootPath) return;
    if (e.kind === 'dir') toggle(id, !expanded.has(id));
    else onOpen({ root: rootPath, path: e.path }, opensIn(e.mime, e.path));
  };

  if (rootsError)
    return (
      <div className="files-error" role="alert">
        <p>{rootsError}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (!roots)
    return (
      <p className="muted">
        <Spinner label="Loading folders" /> Loading…
      </p>
    );
  if (!root) return <p className="muted">No folders are available here.</p>;
  const top = folders[''];

  return (
    <section className="file-browser" aria-label="Files">
      <div className="file-browser-bar">
        {roots.length > 1 ? (
          <SelectField
            className="file-root"
            label="Folder"
            hideLabel
            value={root.path}
            onChange={setPicked}
            options={roots.map((r) => ({ value: r.path, label: r.label, title: r.path }))}
          />
        ) : (
          <span className="file-root-label" title={root.path}>
            <Icon name="folder" /> {root.label}
          </span>
        )}
        {root.access === 'read' ? <span className="muted file-access">Read-only</span> : null}
        <IconButton
          label="Refresh files"
          icon={<Icon name="refresh" />}
          variant="ghost"
          onClick={() => {
            load('');
            for (const dir of expanded) load(dir);
          }}
        />
      </div>
      {top?.error ? (
        <div className="files-error" role="alert">
          <p>{top.error}</p>
          <Button onClick={() => load('')}>Retry</Button>
        </div>
      ) : !top?.items ? (
        <p className="muted">
          <Spinner label="Loading files" /> Loading…
        </p>
      ) : top.items.length === 0 ? (
        <p className="muted">This folder is empty.</p>
      ) : (
        <Tree
          label={`Files in ${root.label}`}
          nodes={nodes}
          onActivate={activate}
          expanded={expanded}
          onExpandedChange={toggle}
          className="file-tree"
        />
      )}
    </section>
  );
}

function sortEntries(items: FileEntryView[]): FileEntryView[] {
  return [...items].sort(
    (a, b) =>
      Number(b.kind === 'dir') - Number(a.kind === 'dir') ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}
