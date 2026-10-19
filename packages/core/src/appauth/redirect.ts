// Redirect URIs of third-party apps (FR-222, ADR-097 D6; RFC 8252 for native apps). Only two
// kinds: a loopback http URI on an IP literal (any port matches at request time, §7.3) and a
// private-use scheme in reverse-domain form (§7.1). `localhost` (it can resolve elsewhere, §8.3),
// any other http host, https web redirects and fragments are refused. A loopback URI whose path is
// one of the Hub's own route families is refused too: the owner's browser often runs on the Hub
// machine, and a code delivered to one of the Hub's own callbacks could be forwarded elsewhere
// (the Hub area also refuses the Hub's own ports).

export type RedirectKind = 'loopback' | 'private_scheme';

export type RedirectCheck =
  { ok: true; kind: RedirectKind } | { ok: false; reason: RedirectRefusal };

export type RedirectRefusal =
  | 'invalid_uri'
  | 'fragment'
  | 'credentials'
  | 'non_loopback_http'
  | 'web_redirect'
  | 'scheme_not_reverse_domain'
  | 'hub_path';

/** The first path segments of the Hub's own routes (its API, device, node and boot listeners). */
const HUB_SEGMENTS = new Set(['api', 'node', 'agent', 'boot', 'mcp', '.well-known']);

/**
 * Whether a path is under one of the Hub's own route families. Compared decoded, lower-cased and
 * with repeated slashes collapsed, so no spelling slips past; an undecodable path counts as one.
 */
export function isHubPath(pathname: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const first = p.toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean)[0] ?? '';
  return HUB_SEGMENTS.has(first);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
/** `com.example.app`: at least two labels, lower-case, as RFC 8252 §7.1 asks. */
const PRIVATE_SCHEME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

export function checkRedirectUri(uri: string): RedirectCheck {
  if (uri.length > 500 || /\s/.test(uri)) return { ok: false, reason: 'invalid_uri' };
  // RFC 6749 §3.1.2: the redirection endpoint must not include a fragment.
  if (uri.includes('#')) return { ok: false, reason: 'fragment' };
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { ok: false, reason: 'invalid_uri' };
  }
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  if (u.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(u.hostname)) return { ok: false, reason: 'non_loopback_http' };
    if (isHubPath(u.pathname)) return { ok: false, reason: 'hub_path' };
    return { ok: true, kind: 'loopback' };
  }
  if (u.protocol === 'https:') return { ok: false, reason: 'web_redirect' };
  const scheme = u.protocol.slice(0, -1);
  // The URL parser lower-cases the scheme; the registered text must already be lower-case.
  if (!PRIVATE_SCHEME.test(scheme) || !uri.startsWith(`${scheme}:`))
    return { ok: false, reason: 'scheme_not_reverse_domain' };
  return { ok: true, kind: 'private_scheme' };
}

/**
 * The registered URI a request's `redirect_uri` matches, or null. Exact string comparison, except
 * that a loopback URI matches on any port (the app picks a free one per sign-in).
 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function matchRedirectUri(registered: readonly string[], requested: string): string | null {
  if (registered.includes(requested)) return requested;
  const req = checkRedirectUri(requested);
  if (!req.ok || req.kind !== 'loopback') return null;
  const r = new URL(requested);
  for (const candidate of registered) {
    const c = checkRedirectUri(candidate);
    if (!c.ok || c.kind !== 'loopback') continue;
    const u = new URL(candidate);
    if (u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search)
      return candidate;
  }
  return null;
}

/** The redirect URI with these query parameters added (the code or the error, state, iss). */
export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
