// The web UI's routes (docs/04 §5, apps/web/src/router.ts) that a shell window may open (FR-009).
// A path from the web UI, a notification or a deep link is rebuilt from validated parts, so it
// can never leave the Hub's origin, smuggle a scheme or carry a parameter the route does not take.
import { SHELL_ID } from '@nova/shared';

const ONE = /^1$/;
const SLUG = /^[a-z][a-z0-9-]{0,40}$/;
// Theme link data (FR-011): base64, at most 44,000 characters (docs/04 §5.1).
const THEME_DATA = /^[A-Za-z0-9_\-+/=]{1,44000}$/;

/** Settings sections, as the web router knows them; anything else opens General. */
export const SETTINGS_SECTIONS = [
  'general',
  'account',
  'members',
  'profile',
  'accounts',
  'models',
  'memory',
  'tools',
  'code',
  'cloud',
  'plugins',
  'clients',
  'permissions',
  'computer-use',
  'agents',
  'notifications',
  'channels',
  'triggers',
  'devices',
  'network',
  'sync',
  'browser',
  'appearance',
  'keyboard',
  'import',
  'experimental',
  'diagnostics',
] as const;

interface RouteSpec {
  /** Patterns of the optional path segments after the head, in order. */
  args: RegExp[];
  /** At least this many segments. */
  minArgs?: number;
  query?: Record<string, RegExp>;
}

const ROUTES: Record<string, RouteSpec> = {
  chat: {
    args: [SHELL_ID],
    query: { m: SHELL_ID, compare: SHELL_ID, approval: SHELL_ID, temporary: ONE },
  },
  // `/work/scheduled` is matched by the id pattern too.
  work: { args: [SHELL_ID], query: { new: ONE, fromRun: SHELL_ID } },
  code: { args: [SHELL_ID], query: { new: ONE } },
  agents: { args: [SHELL_ID], query: { tab: SLUG } },
  projects: { args: [SHELL_ID] },
  library: { args: [] },
  spaces: { args: [SHELL_ID, SHELL_ID] },
  sites: { args: [SHELL_ID] },
  apps: { args: [SHELL_ID] },
  devices: {
    args: [SHELL_ID],
    query: { tab: SLUG, request: SHELL_ID, role: SLUG, method: SLUG },
  },
  network: { args: [SLUG], query: { run: SHELL_ID } },
  computers: { args: [SHELL_ID] },
  // /approvals lists every pending approval; /approvals/<id> opens one in its chat (M7).
  approvals: { args: [SHELL_ID] },
  // /team, /team/<section>, /team/<section>/<id>: shared chats and team agents (FR-217, FR-091).
  team: { args: [SLUG, SHELL_ID] },
  settings: { args: [], query: { theme: THEME_DATA, oauth: /^(ok|error)$/ } },
};

/** Pages a window may show that are not routes to open on request (the join page, a link). */
const PAGES_ONLY = new Set(['add-device', 'onboarding', 'open', 'sign-in']);

const BASE = 'http://app.invalid';

/**
 * The normalized app path (`/chat/<id>?m=<id>`) for `raw`, or null when it is not a route a
 * window may open. Unknown query parameters are dropped; an unknown settings section becomes
 * General, as in the web UI. `/` (the app's home) is kept as is.
 */
export function appPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  // Only an absolute path: never `//host`, `/\host` or a scheme, and no control characters.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const parts: string[] = [];
  for (const seg of url.pathname.split('/')) {
    if (seg === '') continue;
    try {
      parts.push(decodeURIComponent(seg));
    } catch {
      return null;
    }
  }
  if (parts.length === 0) return '/';
  const [head = '', ...args] = parts;
  // The web UI sends a person whose identity link failed here; the Account page explains it.
  if (head === 'sign-in' && args.length === 0) return '/settings/account';
  if (head === 'settings') {
    if (args.length > 1) return null;
    const section = (SETTINGS_SECTIONS as readonly string[]).includes(args[0] ?? '')
      ? (args[0] as string)
      : 'general';
    return withQuery(`/settings/${section}`, url.searchParams, ROUTES.settings?.query);
  }
  const spec = Object.hasOwn(ROUTES, head) ? ROUTES[head] : undefined;
  if (!spec) return null;
  if (args.length > spec.args.length || args.length < (spec.minArgs ?? 0)) return null;
  for (const [i, arg] of args.entries()) if (!spec.args[i]?.test(arg)) return null;
  const path = `/${[head, ...args].map(encodeURIComponent).join('/')}`;
  return withQuery(path, url.searchParams, spec.query);
}

function withQuery(
  path: string,
  params: URLSearchParams,
  allowed: Record<string, RegExp> | undefined,
): string {
  if (!allowed) return path;
  const out = new URLSearchParams();
  for (const [key, pattern] of Object.entries(allowed)) {
    const value = params.get(key);
    if (value !== null && pattern.test(value)) out.set(key, value);
  }
  const q = out.toString();
  return q ? `${path}?${q}` : path;
}

/** The chat a path shows (`/chat/<id>`), else null. */
export function threadIdOf(path: string): string | null {
  const m = /^\/chat\/([A-Za-z0-9_-]{1,100})(?:[?#]|$)/.exec(path);
  return m?.[1] ?? null;
}

/** The path part a window is "at" for routing: the path without its query. */
export function pathKey(path: string): string {
  const q = path.search(/[?#]/);
  return q < 0 ? path : path.slice(0, q);
}

/**
 * Whether a Hub window may navigate (top level) to this path: an app route, or one of the pages
 * the web UI moves to itself (the join page, onboarding, a link to open). Never the API: its
 * previews and app UIs are untrusted documents that must not run where `window.novaShell` lives.
 */
export function windowMayShow(path: string): boolean {
  if (appPath(path) !== null) return true;
  const head = /^\/([a-z-]+)(?:[/?#]|$)/.exec(path)?.[1];
  return head !== undefined && PAGES_ONLY.has(head);
}
