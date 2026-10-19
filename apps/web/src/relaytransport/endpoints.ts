// Which ways this browser can reach its Hub (docs/22 §2, FR-135): the address the app was loaded
// from, and the Relay when this browser is paired through one. The Hub advertises its endpoints in
// `POST /api/v1/hello` (best first); a browser can only call its own origin (the Hub sends no CORS
// headers, and the session cookie belongs to that origin), so an advertised endpoint at another
// address only tells which transport the page's own address is. Names the path in use for people:
// LAN, Mesh, Relay or Direct.
import { TRANSPORT_PRIORITY, type EndpointCandidate, type NetworkTransport } from '@nova/shared';

export const TRANSPORT_LABEL: Record<NetworkTransport, string> = {
  lan: 'LAN',
  mesh: 'Mesh',
  relay: 'Relay',
  direct: 'Direct',
};

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/**
 * The transport an address belongs to when the Hub has not said (docs/22 §2): loopback, private
 * IPv4, IPv6 unique-local and link-local, and `.local` names are LAN; the CGNAT range
 * `100.64.0.0/10`, Tailscale's IPv6 range and `*.ts.net` are Mesh; anything else is Direct.
 */
export function guessTransport(url: string): NetworkTransport {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return 'direct';
  }
  if (host.endsWith('.ts.net') || host.startsWith('fd7a:115c:a1e0:')) return 'mesh';
  const v4 = ipv4(host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (a === 100 && b >= 64 && b <= 127) return 'mesh';
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
      return 'lan';
    if (a === 169 && b === 254) return 'lan';
    return 'direct';
  }
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return 'lan';
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return 'lan';
  return 'direct';
}

/** The page's own origin as a candidate: as the Hub advertises it, else by its address. */
export function originCandidate(
  origin: string,
  advertised: readonly EndpointCandidate[],
): EndpointCandidate {
  const same = advertised
    .filter((e) => e.transport !== 'relay' && originOf(e.url) === origin)
    .sort((a, b) => a.priority - b.priority)[0];
  if (same) return { ...same, url: origin };
  const transport = guessTransport(origin);
  return {
    transport,
    url: origin,
    priority: TRANSPORT_PRIORITY[transport],
    health: 'unknown',
    latencyMs: null,
    checkedAt: null,
    detail: 'this page',
  };
}

/** The Relay as a candidate (its advertised priority when the Hub lists it). */
export function relayCandidate(
  relayUrl: string,
  advertised: readonly EndpointCandidate[],
): EndpointCandidate {
  const listed = advertised.find((e) => e.transport === 'relay');
  return {
    transport: 'relay',
    url: relayUrl,
    priority: listed?.priority ?? TRANSPORT_PRIORITY.relay,
    health: 'unknown',
    latencyMs: null,
    checkedAt: null,
    detail: 'paired',
  };
}

/** Only well-formed candidates from a Hub answer (it is data from the network). */
export function cleanEndpoints(raw: unknown): EndpointCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: EndpointCandidate[] = [];
  for (const v of raw.slice(0, 20)) {
    if (typeof v !== 'object' || v === null) continue;
    const e = v as Partial<EndpointCandidate>;
    if (
      (e.transport === 'lan' ||
        e.transport === 'mesh' ||
        e.transport === 'relay' ||
        e.transport === 'direct') &&
      typeof e.url === 'string' &&
      e.url.length <= 500 &&
      typeof e.priority === 'number'
    )
      out.push({
        transport: e.transport,
        url: e.url,
        priority: e.priority,
        health: e.health === 'ok' || e.health === 'failing' ? e.health : 'unknown',
        latencyMs: typeof e.latencyMs === 'number' ? e.latencyMs : null,
        checkedAt: typeof e.checkedAt === 'string' ? e.checkedAt : null,
        detail: typeof e.detail === 'string' ? e.detail.slice(0, 200) : null,
      });
  }
  return out;
}
