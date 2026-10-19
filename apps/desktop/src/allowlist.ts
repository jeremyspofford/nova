// The navigation allowlist of the shell's Hub windows (docs/12, ADR-031): a window shows only the
// Hub's own origin. Links elsewhere open in the system browser; anything that is not a web link
// (a file, a custom scheme, a script URL) goes nowhere. The window's network requests are limited
// to the Hub too, so no remote content outside the Hub loads in a Nova window.

export type NavigationDecision = 'allow' | 'external' | 'deny';

const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);

function parse(raw: string): URL | null {
  if (raw.length > 8000) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Where a navigation or a new-window request of a Hub window may go. */
export function navigationDecision(target: string, hubOrigin: string): NavigationDecision {
  const u = parse(target);
  if (!u) return 'deny';
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === hubOrigin) {
    return u.username || u.password ? 'deny' : 'allow';
  }
  return externalUrl(target) ? 'external' : 'deny';
}

/**
 * The URL to hand the system browser, or null when it is not a plain web or mail link. A mail
 * link keeps only its addresses: some mail programs honour `?attach=<file>` and would attach a
 * local file to the draft.
 */
export function externalUrl(target: string): string | null {
  const u = parse(target);
  if (!u || !EXTERNAL.has(u.protocol)) return null;
  if (u.protocol === 'mailto:') return u.pathname ? `mailto:${u.pathname}` : null;
  if (u.username || u.password || !u.hostname) return null;
  return u.toString();
}

/**
 * At most `limit` events per `windowMs`: the system browser and new windows are opened on a
 * page's request, so a page that asks in a loop is stopped rather than obeyed.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #times: number[] = [];

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  take(): boolean {
    const t = this.#now();
    this.#times = this.#times.filter((x) => t - x < this.#windowMs);
    if (this.#times.length >= this.#limit) return false;
    this.#times.push(t);
    return true;
  }
}

/**
 * Whether a Hub window may make this request: the Hub's own origin over HTTP(S) and its
 * WebSockets, and the in-page `data:` and `blob:` URLs the web UI makes itself. DevTools is
 * allowed for development. Everything else is cancelled.
 */
export function requestAllowed(target: string, hubOrigin: string): boolean {
  const u = parse(target);
  if (!u) return false;
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'devtools:') return true;
  const hub = parse(hubOrigin);
  if (!hub) return false;
  const wsScheme = hub.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.protocol !== hub.protocol && u.protocol !== wsScheme) return false;
  return u.host === hub.host && !u.username && !u.password;
}

/**
 * Whether a request of the shell's own pages (connect, quick chat, attach preview) may load:
 * only their own files and the in-page `data:` URLs. Hub calls go through the main process.
 */
export function localRequestAllowed(target: string, rendererDirUrl: string): boolean {
  const u = parse(target);
  if (!u) return false;
  if (u.protocol === 'data:' || u.protocol === 'devtools:') return true;
  const base = rendererDirUrl.endsWith('/') ? rendererDirUrl : `${rendererDirUrl}/`;
  return u.protocol === 'file:' && u.href.startsWith(base) && !u.href.includes('/../');
}

const PAGE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

/**
 * Whether the Hub's page may use a permission: only its top frame, by its real origin, and only
 * the clipboard, full screen and the microphone (dictation and voice, FR-216, FR-031): never the
 * camera, the screen or notifications (the shell raises those itself).
 */
export function permissionAllowed(req: {
  permission: string;
  isMainFrame: boolean;
  frameOrigin: string;
  hubOrigin: string | null;
  mediaTypes: readonly string[];
}): boolean {
  if (!req.isMainFrame || !req.hubOrigin || req.frameOrigin === 'null') return false;
  if (req.frameOrigin !== req.hubOrigin) return false;
  if (req.permission === 'media')
    return req.mediaTypes.length > 0 && req.mediaTypes.every((t) => t === 'audio');
  return PAGE_PERMISSIONS.has(req.permission);
}
