// `nova://` deep links in the native shell (FR-007, docs/04 §5.1, ADR-095 decision 7). They map
// onto the web UI's routes like apps/web/src/deeplinks.ts, plus the targets notifications open:
//
//   nova://run[/<id>]      → /work[/<id>] (alias work)
//   nova://approval[/<id>] → /approvals[/<id>] (alias approvals; the list, or one in its chat)
//   nova://code/<id>       → /code/<id>
//   nova://chat/<id>?m=…  → /chat/<id>?m=…      nova://settings/<section> → /settings/<section>
//   nova://add-device?h=<hub>&p=…&fp=…#c=<code> → connect to <hub>, pinned to fp, then /add-device
//
// Anything else is not a Nova link (null); the shell then opens /chat, as docs/04 §5.1 says.
import { SHELL_ID } from '@nova/shared';
import { appPath } from './routes.ts';

const SCHEMES = new Set(['nova', 'web+nova']);
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const PAIR_CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;
const THEME_DATA = /^[A-Za-z0-9_\-+/=]{1,44000}$/;

export type DeepLinkTarget =
  | { kind: 'path'; path: string }
  /**
   * Join a Hub (FR-132): the shell verifies `hubUrl` against `pin` before anything is sent
   * (docs/22 §5), then opens `path`, the Hub's own join page, with the code in its fragment.
   */
  | {
      kind: 'add-device';
      hubUrl: string | null;
      pin: string | null;
      endpoints: string[];
      path: string;
    };

/** An http(s) origin with no credentials, path or query, or null. */
export function hubOriginOf(raw: string | null): string | null {
  if (raw === null || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function relayUrl(raw: string | null): string | null {
  if (raw === null || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    return ['wss:', 'https:', 'ws:', 'http:'].includes(u.protocol) && !u.username && !u.password
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

/** `/add-device` with only the fields that validate; the code stays in the fragment. */
export function joinPath(params: URLSearchParams, fragment: string): string | null {
  const p = params.get('p');
  if (p === null || !SHELL_ID.test(p)) return null;
  const out = new URLSearchParams({ p });
  const fp = params.get('fp');
  if (fp !== null && FINGERPRINT.test(fp)) out.set('fp', fp);
  const r = relayUrl(params.get('r'));
  const rp = params.get('rp');
  if (r !== null && rp !== null && SHELL_ID.test(rp)) {
    out.set('r', r);
    out.set('rp', rp);
  }
  const code = new URLSearchParams(fragment).get('c');
  return `/add-device?${out.toString()}${code !== null && PAIR_CODE.test(code) ? `#c=${code}` : ''}`;
}

/** The pieces of an Add Device link's query, shared by the deep link and the Hub's QR link. */
export function joinTarget(
  hub: string | null,
  params: URLSearchParams,
  fragment: string,
): Extract<DeepLinkTarget, { kind: 'add-device' }> | null {
  const path = joinPath(params, fragment);
  if (!path) return null;
  const fp = params.get('fp');
  const endpoints = params
    .getAll('e')
    .map((e) => hubOriginOf(e))
    .filter((e): e is string => e !== null)
    .slice(0, 4);
  return {
    kind: 'add-device',
    hubUrl: hubOriginOf(hub),
    pin: fp !== null && FINGERPRINT.test(fp) ? fp : null,
    endpoints,
    path,
  };
}

function decodeId(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return SHELL_ID.test(id) ? id : null;
}

const path = (p: string | null): DeepLinkTarget | null => (p ? { kind: 'path', path: p } : null);

/** Where a deep link goes, or null when it is not a link Nova understands. */
export function routeDeepLink(url: string): DeepLinkTarget | null {
  const text = url.trim();
  if (text.length > 50_000) return null;
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  if (!SCHEMES.has(text.slice(0, colon).toLowerCase())) return null;

  let rest = text.slice(colon + 1);
  const hash = rest.indexOf('#');
  const fragment = hash >= 0 ? rest.slice(hash + 1) : '';
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf('?');
  const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '');
  if (q >= 0) rest = rest.slice(0, q);

  // `nova://chat/x`, `nova:chat/x` and `nova:///chat/x` all name the same place.
  const parts = rest.replace(/^\/+/, '').split('/');
  while (parts.length > 0 && parts.at(-1) === '') parts.pop();
  if (parts.length === 0 || parts.length > 2) return null;
  const head = (parts[0] ?? '').toLowerCase();
  const rawArg = parts[1];
  const arg = rawArg === undefined ? null : decodeId(rawArg);
  if (rawArg !== undefined && arg === null) return null;
  const id = arg === null ? '' : `/${encodeURIComponent(arg)}`;

  switch (head) {
    case 'settings':
      return path(appPath(`/settings${id}`));
    case 'chat': {
      const m = params.get('m');
      const query = arg && m !== null && SHELL_ID.test(m) ? `?m=${encodeURIComponent(m)}` : '';
      return path(appPath(`/chat${id}${query}`));
    }
    case 'run':
    case 'work':
      return path(appPath(`/work${id}`));
    case 'code':
      return path(appPath(`/code${id}`));
    case 'approval':
    case 'approvals':
      return path(appPath(`/approvals${id}`));
    case 'agent':
    case 'agents':
      return path(appPath(`/agents${id}`));
    case 'computer':
    case 'computers':
      return path(appPath(`/computers${id}`));
    case 'device':
    case 'devices':
      return path(appPath(`/devices${id}`));
    case 'project':
    case 'projects':
      return path(appPath(`/projects${id}`));
    case 'add-device':
      return rawArg === undefined ? joinTarget(params.get('h'), params, fragment) : null;
    case 'theme': {
      const data = (params.get('data') ?? '').replace(/ /g, '+');
      if (rawArg !== undefined || !THEME_DATA.test(data)) return null;
      return path(`/settings/appearance?theme=${encodeURIComponent(data)}`);
    }
    default:
      return null;
  }
}

/** The first `nova://` link among process arguments (Windows and Linux hand links over argv). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    const lower = a.toLowerCase();
    if (lower.startsWith('nova:') || lower.startsWith('web+nova:')) return a;
  }
  return null;
}
