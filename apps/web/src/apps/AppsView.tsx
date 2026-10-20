// MCP Apps placement (FR-198, docs/04 §2.9): /apps lists the global entry points and /apps/<id>
// shows one as a page; the Inspector's Apps tab lists the open chat's entry points, each opening
// inline (a picture-in-picture app stays up when another chat opens); file entry points open a
// file in an app registered for its extension (`FileApp`, for the file viewer).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { defineMessages } from '@nova/i18n';
import type { McpServerView, PluginView, UiEntryPointView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { McpAppFrame, type AppOwner } from './McpAppFrame.tsx';
import './apps.css';

/** The Apps page and the Inspector's Apps tab. `{title}` is an app's name (data). */
export const APPS_TEXT = defineMessages('apps', {
  title: 'Apps',
  loadFailed: 'Could not load apps.',
  tryAgain: 'Try again',
  loading: 'Loading apps',
  notFound: 'App not found',
  notFoundHint: 'It may have been removed, or its plugin or MCP server is turned off.',
  allApps: 'All apps',
  none: 'No apps yet',
  noneHint:
    'Apps from your plugins and MCP servers appear here. Apps for a chat are in its Apps panel.',
  open: 'Open',
  opened: 'Opened',
  openApp: 'Open {title}',
  openChat: 'Open a chat to see its apps.',
  noneForChats: 'No apps for chats yet. Plugins and MCP servers can add them.',
  forThisChat: 'Apps for this chat',
});

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
      (err: unknown) => setError(errorMessage(err, APPS_TEXT.loadFailed)),
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
  const S = APPS_TEXT;

  if (error)
    return (
      <div className="apps-view">
        <EmptyState
          title={S.title}
          description={error}
          level={2}
          action={<Button onClick={reload}>{S.tryAgain}</Button>}
        />
      </div>
    );
  if (items === null)
    return (
      <div className="apps-view">
        <Spinner label={S.loading} />
      </div>
    );

  if (entryId) {
    const entry = items.find((e) => e.id === entryId);
    if (!entry)
      return (
        <div className="apps-view">
          <EmptyState
            title={S.notFound}
            description={S.notFoundHint}
            level={2}
            action={<Button onClick={() => navigate('/apps')}>{S.allApps}</Button>}
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
      <h2 className="apps-title">{S.title}</h2>
      {global.length === 0 ? (
        <EmptyState title={S.none} description={S.noneHint} level={2} />
      ) : (
        <ul className="apps-list" aria-label={S.title}>
          {global.map((e) => {
            const owner = owners(e);
            return (
              <li key={e.id}>
                <span dir="auto">
                  {e.title}
                  {owner ? (
                    <span className="muted apps-entry-owner" dir="auto">
                      {owner.name}
                    </span>
                  ) : null}
                </span>
                <Button
                  aria-label={S.openApp({ title: e.title })}
                  onClick={() => navigate(`/apps/${encodeURIComponent(e.id)}`)}
                >
                  {S.open} <Icon name="forward" />
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

// ---- opening a chat's app from elsewhere (the composer's + menu, M8) ----------------------------

/** The registry command that shows the Inspector's Apps tab (the shell registers it). */
export const SHOW_APPS_COMMAND = 'apps.showPanel';

let requested: OpenApp[] = [];
const requestListeners = new Set<() => void>();

function setRequested(next: OpenApp[]): void {
  requested = next;
  for (const fn of [...requestListeners]) fn();
}

function subscribeRequests(fn: () => void): () => void {
  requestListeners.add(fn);
  return () => requestListeners.delete(fn);
}

const currentRequests = () => requested;

/**
 * Open a chat's app in the Inspector's Apps tab from outside it (the composer's + menu). It runs
 * like one opened from the tab, once the tab is shown.
 */
export function requestThreadApp(entry: UiEntryPointView, threadId: string): void {
  setRequested([...requested, { key: instanceKey(), entry, threadId }]);
}

/** The Inspector's Apps tab: the open chat's thread entry points, each opening inline. */
export function ThreadApps({ threadId }: { threadId: string | null }) {
  const { api } = useServices();
  const owners = useAppOwners();
  const { items, error, reload } = useEntryPoints('thread');
  const [started, setOpen] = useState<OpenApp[]>([]);
  // Apps asked for from the composer join the ones opened here.
  const asked = useSyncExternalStore(subscribeRequests, currentRequests);
  const open = [...started, ...asked];
  const here = threadId ? open.filter((o) => o.threadId === threadId) : [];

  const start = (entry: UiEntryPointView, tid: string) =>
    setOpen((list) => [...list, { key: instanceKey(), entry, threadId: tid }]);

  const S = APPS_TEXT;
  let list;
  if (!threadId) list = <p className="muted">{S.openChat}</p>;
  else if (error)
    list = (
      <p className="muted" role="alert">
        {error} <Button onClick={reload}>{S.tryAgain}</Button>
      </p>
    );
  else if (items === null) list = <Spinner label={S.loading} />;
  else if (items.length === 0) list = <p className="muted">{S.noneForChats}</p>;
  else
    list = (
      <ul className="apps-list" aria-label={S.forThisChat}>
        {items.map((e) => {
          const isOpen = here.some((o) => o.entry.id === e.id);
          return (
            <li key={e.id}>
              <span dir="auto">{e.title}</span>
              <Button
                aria-label={S.openApp({ title: e.title })}
                disabled={isOpen}
                onClick={() => start(e, threadId)}
              >
                {isOpen ? S.opened : S.open}
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
          onClose={() => {
            setOpen((cur) => cur.filter((x) => x.key !== o.key));
            if (requested.some((r) => r.key === o.key))
              setRequested(requested.filter((r) => r.key !== o.key));
          }}
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
