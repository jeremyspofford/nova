// Deep links (FR-007): `nova://…` and `web+nova://…` URLs map onto the web UI's routes. The
// installed PWA registers `web+nova` as a protocol handler that opens /open?url=<link>.
//
//   nova://settings[/<section>]   → /settings/<section> (unknown or missing section: general)
//   nova://chat[/<id>][?m=<msg>]  → /chat, /chat/<id>
//   nova://code[/<id>]            → /code   (sessions arrive in M5)
//   nova://agent[/<id>]           → /agents (agents arrive in M6)
//   nova://projects[/<id>]        → /projects, /projects/<id>
//   nova://theme?data=<base64url> → /settings/appearance?theme=<data> (import prefilled, FR-011)
//
// Anything else is not a Nova link and yields null. The result is always a same-origin path
// built from validated parts, so a link can never navigate off the app or smuggle a scheme.
import { SETTINGS_SECTIONS, chatPath, projectPath, type SettingsSection } from './router.ts';

const SCHEMES = new Set(['nova', 'web+nova']);
// Ids are UUIDv7 in the Hub (docs/06); allow the URL-safe set so test and imported ids work too.
const ID = /^[A-Za-z0-9_-]{1,100}$/;
// Theme link data is base64 (url-safe or standard; a `+` may arrive as a space). The theme itself
// is validated on the Appearance page before anything is kept.
const THEME_DATA = /^[A-Za-z0-9_\-+/=]{1,44000}$/;

function decodeId(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return ID.test(id) ? id : null;
}

/** The app path for a deep link, or null when the link is not one Nova understands. */
export function deepLinkPath(url: string): string | null {
  const text = url.trim();
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  if (!SCHEMES.has(text.slice(0, colon).toLowerCase())) return null;

  let rest = text.slice(colon + 1);
  const hash = rest.indexOf('#');
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

  switch (head) {
    case 'settings': {
      const section = (SETTINGS_SECTIONS as readonly string[]).includes(arg ?? '')
        ? (arg as SettingsSection)
        : 'general';
      return `/settings/${section}`;
    }
    case 'chat': {
      if (!arg) return chatPath(null);
      const m = params.get('m');
      const messageId = m !== null && ID.test(m) ? m : undefined;
      return chatPath(arg, messageId);
    }
    case 'code':
      return '/code';
    case 'agent':
    case 'agents':
      return '/agents';
    case 'project':
    case 'projects':
      return projectPath(arg);
    case 'theme': {
      const data = (params.get('data') ?? '').replace(/ /g, '+');
      if (rawArg !== undefined || !THEME_DATA.test(data)) return null;
      return `/settings/appearance?theme=${encodeURIComponent(data)}`;
    }
    default:
      return null;
  }
}
