// Client-side routes over the History API. The Hub serves index.html for unknown paths, so every
// route below is a real, shareable URL: /chat, /chat/:id, /work, /code, /agents, /projects,
// /projects/:id, /settings/:section, /onboarding and /open?url=… (deep links, FR-007).
import { useMemo, useSyncExternalStore } from 'react';

export const MODES = ['chat', 'work', 'code', 'agents'] as const;
export type Mode = (typeof MODES)[number];

export const SETTINGS_SECTIONS = [
  'general',
  'accounts',
  'models',
  'memory',
  'tools',
  'permissions',
  'notifications',
  'devices',
  'appearance',
  'keyboard',
  'diagnostics',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { name: 'chat'; threadId: string | null; messageId: string | null }
  | { name: 'mode'; mode: Exclude<Mode, 'chat'> }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'projects'; projectId: string | null }
  | { name: 'open'; target: string }
  | { name: 'onboarding' };

export function parseRoute(pathname: string, search = ''): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [head, arg] = parts;
  if (head === 'work' || head === 'code' || head === 'agents') return { name: 'mode', mode: head };
  if (head === 'settings') {
    const section = (SETTINGS_SECTIONS as readonly string[]).includes(arg ?? '')
      ? (arg as SettingsSection)
      : 'general';
    return { name: 'settings', section };
  }
  if (head === 'onboarding') return { name: 'onboarding' };
  if (head === 'projects') return { name: 'projects', projectId: arg ?? null };
  if (head === 'open')
    return { name: 'open', target: new URLSearchParams(search).get('url') ?? '' };
  const messageId = new URLSearchParams(search).get('m');
  if (head === 'chat' && arg) return { name: 'chat', threadId: arg, messageId };
  return { name: 'chat', threadId: null, messageId: null };
}

export function routeMode(route: Route): Mode | null {
  if (route.name === 'chat') return 'chat';
  if (route.name === 'mode') return route.mode;
  return null;
}

export function chatPath(threadId: string | null, messageId?: string): string {
  if (!threadId) return '/chat';
  const base = `/chat/${encodeURIComponent(threadId)}`;
  return messageId ? `${base}?m=${encodeURIComponent(messageId)}` : base;
}

export function projectPath(projectId: string | null): string {
  return projectId ? `/projects/${encodeURIComponent(projectId)}` : '/projects';
}

const NAV_EVENT = 'nova:navigate';

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const current = window.location.pathname + window.location.search;
  if (path === current) return;
  if (opts.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

function subscribe(fn: () => void): () => void {
  window.addEventListener('popstate', fn);
  window.addEventListener(NAV_EVENT, fn);
  return () => {
    window.removeEventListener('popstate', fn);
    window.removeEventListener(NAV_EVENT, fn);
  };
}

function snapshot(): string {
  return window.location.pathname + window.location.search;
}

/** The current path plus query string; re-renders on navigation and Back/Forward. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useRoute(): Route {
  const loc = useLocation();
  return useMemo(() => {
    const q = loc.indexOf('?');
    return q < 0 ? parseRoute(loc) : parseRoute(loc.slice(0, q), loc.slice(q));
  }, [loc]);
}
