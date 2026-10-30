// Who is asking (M4 plan §0). Every request, on either listener, is one of:
//  - console: it came in on the console listener from this machine, addressed to this machine, and
//    through no proxy. The console is Nova as it has always been: it can do everything.
//  - device: it carries a session (cookie or bearer token) of a trusted device. What it may do
//    depends on its kind: a person's browser or phone gets what the console gets except approving
//    new devices (unless the person allowed it); a computer gets the device routes; a standby gets
//    the sync routes.
//  - public: anything else. It reaches only enrollment, the pairing page and the hub's hello.
// A reverse proxy pointed at the console port is therefore not the console: forwarding headers
// take console rights away, and what comes through it must pair like any other device.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Device, Devices } from './devices.ts';

export type Listener = 'console' | 'mesh';
// What a route needs. `person` is the default for everything a person uses.
export type Scope = 'public' | 'person' | 'approver' | 'device' | 'sync' | 'mesh';
export type Principal = { kind: 'console' } | { kind: 'device'; device: Device } | { kind: 'public' };
export type Verdict = 'ok' | 'unauthenticated' | 'forbidden';

export const SESSION_COOKIE = 'nova_session';

// Outside /api/v1 (whose routes carry their own scope), these paths are public: the pairing page and
// what it loads, and the device agent's installer (M4b).
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/pair', '/js/pair.js', '/js/device-key.js', '/styles/base.css', '/styles/components.css', '/styles/pair.css',
  '/design-system.css', '/icon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png',
  '/join.sh', '/device-agent.tar',
]);

const FORWARDING = /^(forwarded|x-forwarded-.+|tailscale-.+|x-real-ip)$/i;

const bare = (a: string) => a.replace(/^::ffff:/i, '');

export function loopbackAddress(addr: string | undefined): boolean {
  const a = bare(String(addr ?? ''));
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function loopbackHost(host: string | undefined): boolean {
  const name = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || loopbackAddress(name);
}

export function forwarded(headers: IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((h) => FORWARDING.test(h));
}

export function isConsole(listener: Listener, req: IncomingMessage): boolean {
  return listener === 'console' && loopbackAddress(req.socket.remoteAddress) && loopbackHost(req.headers.host) && !forwarded(req.headers);
}

export function allows(scope: Scope, p: Principal): Verdict {
  if (scope === 'public' || p.kind === 'console') return 'ok';
  if (p.kind === 'public') return 'unauthenticated';
  const d = p.device;
  const client = d.kind === 'browser' || d.kind === 'phone';
  switch (scope) {
    case 'mesh': return 'ok';
    case 'person': return client ? 'ok' : 'forbidden';
    case 'approver': return client && d.can_approve ? 'ok' : 'forbidden';
    case 'device': return d.kind === 'computer' ? 'ok' : 'forbidden';
    case 'sync': return d.kind === 'standby' ? 'ok' : 'forbidden';
  }
}

export const REFUSAL: Record<Exclude<Verdict, 'ok'>, string> = {
  unauthenticated: 'This device isn’t paired with Nova, or its session ended. Open /pair on it to pair it or sign in again.',
  forbidden: 'This device can’t use this part of Nova.',
};
export const APPROVER_ONLY = 'Only the hub’s own screen, or a device you’ve allowed to approve, can do this.';

function cookie(header: string | undefined, name: string): string | null {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// The session cookie: HttpOnly, SameSite=Strict, Secure whenever devices reach Nova over HTTPS.
export function sessionCookie(token: string, o: { secure: boolean; maxAgeS: number }): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${o.maxAgeS}; HttpOnly; SameSite=Strict${o.secure ? '; Secure' : ''}`;
}

export interface MeshListenerInfo { publicUrl: string; transport: 'tls' | 'proxy' | 'network' }

export class Access {
  #devices: Devices;
  #mesh: MeshListenerInfo | null;
  // Each device's requests in flight, event streams included, so revoking it can cut them off.
  #open = new Map<string, Set<ServerResponse>>();

  constructor(o: { devices: Devices; mesh: MeshListenerInfo | null }) {
    this.#devices = o.devices;
    this.#mesh = o.mesh;
    o.devices.on('revoked', (d: Device) => this.close(d.id));
  }

  identify(req: IncomingMessage, listener: Listener): Principal {
    if (isConsole(listener, req)) return { kind: 'console' };
    const auth = String(req.headers.authorization ?? '');
    const token = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : cookie(req.headers.cookie, SESSION_COOKIE);
    const device = token ? this.#devices.sessionDevice(token) : null;
    if (!device) return { kind: 'public' };
    this.#devices.touch(device.id);
    return { kind: 'device', device };
  }

  // The client's address, for rate limits. Behind a stated TLS proxy every request comes from the
  // proxy, so the address the proxy saw (the last x-forwarded-for entry, which the proxy itself
  // appends) is used instead; it is trusted only then.
  address(req: IncomingMessage, listener: Listener): string {
    const peer = bare(String(req.socket.remoteAddress ?? 'unknown'));
    const xff = req.headers['x-forwarded-for'];
    if (listener === 'mesh' && this.#mesh?.transport === 'proxy' && loopbackAddress(peer) && xff) {
      const last = String(Array.isArray(xff) ? xff.at(-1) : xff).split(',').at(-1)?.trim();
      if (last) return bare(last);
    }
    return peer;
  }

  track(p: Principal, res: ServerResponse): void {
    if (p.kind !== 'device') return;
    const id = p.device.id;
    let set = this.#open.get(id);
    if (!set) this.#open.set(id, (set = new Set()));
    set.add(res);
    res.on('close', () => {
      set.delete(res);
      if (!set.size && this.#open.get(id) === set) this.#open.delete(id);
    });
  }

  // Whether a device has something open right now (an event stream, usually).
  isLive(id: string): boolean {
    return (this.#open.get(id)?.size ?? 0) > 0;
  }

  // Cuts a device off: every stream and request it has open ends now. A response already
  // finished (the revoke call itself, when a device revokes itself) is left to flush.
  close(id: string): void {
    for (const res of this.#open.get(id) ?? []) if (!res.writableEnded) res.destroy();
    this.#open.delete(id);
  }

  // For everything outside /api/v1: who is asking, or the refusal already sent (null). The core's
  // own routes are checked against their scopes by the API itself.
  gate(req: IncomingMessage, res: ServerResponse, url: URL, listener: Listener): Principal | null {
    const p = this.identify(req, listener);
    this.track(p, res);
    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) return p;
    const verdict = allows(PUBLIC_PATHS.has(url.pathname) ? 'public' : 'person', p);
    if (verdict === 'ok') return p;
    const navigation = (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')
      && (req.headers['sec-fetch-mode'] === 'navigate' || String(req.headers.accept ?? '').includes('text/html'));
    if (verdict === 'unauthenticated' && navigation) {
      res.writeHead(303, { location: '/pair', 'cache-control': 'no-store' });
      res.end();
    } else if (url.pathname.startsWith('/api/')) {
      res.writeHead(verdict === 'unauthenticated' ? 401 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: REFUSAL[verdict] }));
    } else {
      res.writeHead(verdict === 'unauthenticated' ? 401 : 403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(REFUSAL[verdict]);
    }
    return null;
  }
}
