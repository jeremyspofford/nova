// MCP Apps placement (FR-198, docs/04 §2.9): /apps lists the global entry points and /apps/<id>
// shows one as a page; the Inspector's Apps tab lists the open chat's entry points, each opening
// inline (a picture-in-picture app stays up when another chat opens); file entry points open a
// file in an app registered for its extension (`FileApp`, for the file viewer).
import { useCallback, useEffect, useState } from 'react';
import type { McpServerView, PluginView, UiEntryPointView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { McpAppFrame, type AppOwner } from './McpAppFrame.tsx';
import './apps.css';

/** The plugin or server behind each entry point, for the frame's header. */
export function useAppOwners(): (entry: UiEntryPointView) => AppOwner | null {
  const { api } = useServices();
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [servers, setServers] = useState<McpServerView[]>([]);
  useEffect(() => {
    let alive = true;
    api.listPlugins().then(
      ({ items }) => {
        if (alive) setPlugins(items);
      },
      () => undefined,
    );
    api.listMcpServers().then(
      ({ items }) => {
        if (alive) setServers(items);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return useCallback(
    (entry: UiEntryPointView) => {
      if (entry.pluginId) {
        const p = plugins.find((x) => x.id === entry.pluginId);
        return p ? { name: p.name, verified: p.verified } : null;
      }
      const s = servers.find((x) => x.id === entry.serverId);
      return s ? { name: s.name, verified: s.bundle?.signature === 'verified' } : null;
    },
    [plugins, servers],
  );
}

function useEntryPoints(kind?: UiEntryPointView['kind']) {
  const { api } = useServices();
  const [items, setItems] = useState<UiEntryPointView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.uiEntryPoints(kind).then(
      ({ items: list }) => {
        setItems(list);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err, 'Could not load apps.')),
    );
  }, [api, kind]);
  useEffect(() => {
    // The list arrives asynchronously; nothing is set synchronously here.
    load();
  }, [load]);
  return { items, error, reload: load };
}

/**
 * Put an app's text in the open chat's composer the way typing does (React reads the input
 * event), so the user reviews it and sends it, or not (docs/08 §3.1: an app's message is never
 * user-typed authorization). False when no composer is open.
 */
export function fillComposer(text: string): boolean {
  const el = document.getElementById('composer-input');
  if (!(el instanceof HTMLTextAreaElement) || el.disabled) return false;
  const before = el.value.replace(/\s+$/, '');
  const next = before ? `${before}\n\n${text}` : text;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  return true;
}

let openSeq = 0;
const instanceKey = () => `app-${Date.now().toString(36)}-${(++openSeq).toString(36)}`;

export function AppsView({ entryId }: { entryId: string | null }) {
  const owners = useAppOwners();
  const { items, error, reload } = useEntryPoints();

  if (error)
    return (
      <div className="apps-view">
        <EmptyState
          title="Apps"
          description={error}
          level={2}
          action={<Button onClick={reload}>Try again</Button>}
        />
      </div>
    );
  if (items === null)
    return (
      <div className="apps-view">
        <Spinner label="Loading apps" />
      </div>
    );

  if (entryId) {
    const entry = items.find((e) => e.id === entryId);
    if (!entry)
      return (
        <div className="apps-view">
          <EmptyState
            title="App not found"
            description="It may have been removed, or its plugin or MCP server is turned off."
            level={2}
            action={<Button onClick={() => navigate('/apps')}>All apps</Button>}
          />
        </div>
      );
    return (
      <div className="apps-view" data-page="">
        <McpAppFrame
          key={entry.id}
          entry={entry}
          threadId={null}
          placement="page"
          owner={owners(entry)}
          onClose={() => navigate('/apps')}
        />
      </div>
    );
  }

  const global = items.filter((e) => e.kind === 'global');
  return (
    <div className="apps-view">
      <h2 className="apps-title">Apps</h2>
      {global.length === 0 ? (
        <EmptyState
          title="No apps yet"
          description="Apps from your plugins and MCP servers appear here. Apps for a chat are in its Apps panel."
          level={2}
        />
      ) : (
        <ul className="apps-list" aria-label="Apps">
          {global.map((e) => {
            const owner = owners(e);
            return (
              <li key={e.id}>
                <span>
                  {e.title}
                  {owner ? <span className="muted apps-entry-owner">{owner.name}</span> : null}
                </span>
                <Button
                  aria-label={`Open ${e.title}`}
                  onClick={() => navigate(`/apps/${encodeURIComponent(e.id)}`)}
                >
                  Open <Icon name="forward" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface OpenApp {
  key: string;
  entry: UiEntryPointView;
  threadId: string;
}

/** The Inspector's Apps tab: the open chat's thread entry points, each opening inline. */
export function ThreadApps({ threadId }: { threadId: string | null }) {
  const { api } = useServices();
  const owners = useAppOwners();
  const { items, error, reload } = useEntryPoints('thread');
  const [open, setOpen] = useState<OpenApp[]>([]);
  const here = threadId ? open.filter((o) => o.threadId === threadId) : [];

  const start = (entry: UiEntryPointView, tid: string) =>
    setOpen((list) => [...list, { key: instanceKey(), entry, threadId: tid }]);

  let list;
  if (!threadId) list = <p className="muted">Open a chat to see its apps.</p>;
  else if (error)
    list = (
      <p className="muted" role="alert">
        {error} <Button onClick={reload}>Try again</Button>
      </p>
    );
  else if (items === null) list = <Spinner label="Loading apps" />;
  else if (items.length === 0)
    list = <p className="muted">No apps for chats yet. Plugins and MCP servers can add them.</p>;
  else
    list = (
      <ul className="apps-list" aria-label="Apps for this chat">
        {items.map((e) => {
          const isOpen = here.some((o) => o.entry.id === e.id);
          return (
            <li key={e.id}>
              <span>{e.title}</span>
              <Button
                aria-label={`Open ${e.title}`}
                disabled={isOpen}
                onClick={() => start(e, threadId)}
              >
                {isOpen ? 'Opened' : 'Open'}
              </Button>
            </li>
          );
        })}
      </ul>
    );

  return (
    <div className="thread-apps">
      {list}
      {open.map((o) => (
        <McpAppFrame
          key={o.key}
          entry={o.entry}
          threadId={o.threadId}
          owner={owners(o.entry)}
          inactive={o.threadId !== threadId}
          onMessage={(text) => o.threadId === threadId && fillComposer(text)}
          onModelContext={(text) => {
            void api
              .setUiContext({
                threadId: o.threadId,
                entryId: o.entry.id,
                instanceId: o.key,
                text,
              })
              .catch(() => undefined);
          }}
          onClose={() => setOpen((cur) => cur.filter((x) => x.key !== o.key))}
        />
      ))}
    </div>
  );
}

/** The extension of a path, lowercase with its dot (`.csv`), or '' without one. */
export function fileExtension(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** File entry points registered for a path's extension (for "Open with…"). */
export function fileAppsFor(
  entries: readonly UiEntryPointView[],
  path: string,
): UiEntryPointView[] {
  const ext = fileExtension(path);
  if (!ext) return [];
  return entries.filter(
    (e) => e.kind === 'file' && e.extensions.some((x) => x.toLowerCase() === ext),
  );
}

/** The file apps for a path; null while loading (and on failure, an empty list). */
export function useFileApps(path: string | null): UiEntryPointView[] | null {
  const { items, error } = useEntryPoints('file');
  if (!path) return [];
  if (error) return [];
  return items ? fileAppsFor(items, path) : null;
}

/** A file opened in a file entry point: the app gets the file in its host context. */
export function FileApp({
  entry,
  root,
  path,
  threadId = null,
  onClose,
}: {
  entry: UiEntryPointView;
  root: string;
  path: string;
  threadId?: string | null;
  onClose?: () => void;
}) {
  const owners = useAppOwners();
  return (
    <McpAppFrame
      key={`${entry.id}:${root}:${path}`}
      entry={entry}
      threadId={threadId}
      owner={owners(entry)}
      file={{ root, path }}
      {...(onClose ? { onClose } : {})}
    />
  );
}
