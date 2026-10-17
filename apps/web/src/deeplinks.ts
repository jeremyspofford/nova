// Deep links (FR-007): `nova://…` and `web+nova://…` URLs map onto the web UI's routes. The
// installed PWA registers `web+nova` as a protocol handler that opens /open?url=<link>.
//
//   nova://settings[/<section>]   → /settings/<section> (unknown or missing section: general)
//   nova://chat[/<id>][?m=<msg>]  → /chat, /chat/<id>
//   nova://code[/<id>]            → /code, /code/<id>
//   nova://agent[/<id>]           → /agents, /agents/<id>
//   nova://computer[/<id>]        → /computers, /computers/<id> (M6)
//   nova://device[/<id>]          → /devices, /devices/<id> (M6)
//   nova://projects[/<id>]        → /projects, /projects/<id>
//   nova://theme?data=<base64url> → /settings/appearance?theme=<data> (import prefilled, FR-011)
//   nova://add-device?p=…&fp=…&r=…&rp=…#c=<code> → /add-device with the same validated fields
//                                    (the joining device's page, FR-132; M6.5)
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
// Add Device (docs/22 §4): the Hub fingerprint (base64url SHA-256), the short code and a Relay URL.
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const PAIR_CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;

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
function addDevicePath(params: URLSearchParams, fragment: string): string | null {
  const p = params.get('p');
  if (p === null || !ID.test(p)) return null;
  const out = new URLSearchParams({ p });
  const fp = params.get('fp');
  if (fp !== null && FINGERPRINT.test(fp)) out.set('fp', fp);
  const r = relayUrl(params.get('r'));
  const rp = params.get('rp');
  if (r !== null && rp !== null && ID.test(rp)) {
    out.set('r', r);
    out.set('rp', rp);
  }
  const code = new URLSearchParams(fragment).get('c');
  return `/add-device?${out.toString()}${code !== null && PAIR_CODE.test(code) ? `#c=${code}` : ''}`;
}

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
      return arg ? `/code/${encodeURIComponent(arg)}` : '/code';
    case 'agent':
    case 'agents':
      return arg ? `/agents/${encodeURIComponent(arg)}` : '/agents';
    case 'computer':
    case 'computers':
      return arg ? `/computers/${encodeURIComponent(arg)}` : '/computers';
    case 'device':
    case 'devices':
      return arg ? `/devices/${encodeURIComponent(arg)}` : '/devices';
    case 'project':
    case 'projects':
      return projectPath(arg);
    case 'add-device':
      return rawArg === undefined ? addDevicePath(params, fragment) : null;
    case 'theme': {
      const data = (params.get('data') ?? '').replace(/ /g, '+');
      if (rawArg !== undefined || !THEME_DATA.test(data)) return null;
      return `/settings/appearance?theme=${encodeURIComponent(data)}`;
    }
    default:
      return null;
  }
}
