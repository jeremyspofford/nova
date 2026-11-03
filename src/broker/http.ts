// The one place the broker reaches the network (§3 "No network surface"): outbound, inside a `use`,
// to that use's bound origin only. Nothing here listens.
//  - The address is resolved once; a public name that resolves to a private or loopback address is
//    refused unless the binding says LAN (and a LAN binding has a pinned certificate). A loopback
//    binding must resolve to loopback.
//  - TLS is verified against the system's roots, or against the pinned certificate's SHA-256 alone
//    when the binding pins one. The check happens on the TLS socket before a byte of the request is
//    written.
//  - Redirects aren't followed: a 3xx comes back as an outcome. No proxy settings are honoured (the
//    broker starts with an empty environment, and this code never reads one).
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { addressClass, isLoopbackHost } from './origin.ts';
import { RESPONSE_HEADERS } from './protocol.ts';

export interface Outbound { origin: string; method: string; path: string; headers: Record<string, string>; body: Buffer | null; lan: boolean; pin: string | null; timeoutMs?: number; maxBytes?: number }
export interface Response { status: number; headers: Record<string, string>; body: string; truncated: boolean }
export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export class EgressError extends Error {
  readonly cls: string;
  constructor(cls: string, message: string) { super(message); this.cls = cls; }
}

const normalPin = (p: string) => p.replace(/:/g, '').toLowerCase();

export async function send(o: Outbound, resolve: Resolver = systemResolver): Promise<Response> {
  const u = new URL(o.origin);
  const host = u.hostname;
  const bare = host.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const addrs = isIP(bare) ? [bare] : await resolve(host).catch(() => { throw new EgressError('dns', `couldn’t resolve ${host}`); });
  if (!addrs.length) throw new EgressError('dns', `${host} has no address`);
  const classes = addrs.map(addressClass);
  if (isLoopbackHost(host)) {
    if (classes.some((c) => c !== 'loopback')) throw new EgressError('address', `${host} didn’t resolve to this device`);
  } else if (classes.some((c) => c !== 'public') && !(o.lan && o.pin)) {
    throw new EgressError('address', `${host} resolves to a private or loopback address, and its binding isn’t a pinned LAN device`);
  }
  const address = addrs[0]!;
  const timeout = o.timeoutMs ?? 30_000;
  const socket: Socket = await new Promise((ok, fail) => {
    const timer = setTimeout(() => { s.destroy(); fail(new EgressError('timeout', 'the connection timed out')); }, timeout);
    const done = (e?: Error) => { clearTimeout(timer); if (e) { s.destroy(); fail(e); } else ok(s); };
    let s: Socket;
    if (u.protocol === 'https:') {
      const t: TLSSocket = tlsConnect({ host: address, port, servername: isIP(bare) ? undefined : host, rejectUnauthorized: !o.pin, ALPNProtocols: ['http/1.1'] });
      s = t;
      t.once('secureConnect', () => {
        if (o.pin) {
          const fp = t.getPeerCertificate()?.fingerprint256 ?? '';
          if (normalPin(fp) !== normalPin(o.pin)) return done(new EgressError('tls', 'the certificate isn’t the one this binding pins'));
        } else if (!t.authorized) return done(new EgressError('tls', `the certificate didn’t verify (${String(t.authorizationError)})`));
        done();
      });
    } else {
      s = netConnect({ host: address, port });
      s.once('connect', () => done());
    }
    s.once('error', (e) => done(new EgressError('connect', e.message)));
  });
  return new Promise((ok, fail) => {
    const req = httpRequest({
      createConnection: () => socket, method: o.method, path: o.path,
      headers: { ...o.headers, host: u.host, connection: 'close', ...(o.body ? { 'content-length': String(o.body.length) } : {}) },
      timeout,
    }, (res: IncomingMessage) => {
      const max = o.maxBytes ?? 4 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let n = 0;
      let truncated = false;
      res.on('data', (c: Buffer) => {
        if (n + c.length > max) { truncated = true; chunks.push(c.subarray(0, max - n)); n = max; res.destroy(); return; }
        chunks.push(c); n += c.length;
      });
      const finish = () => {
        const headers: Record<string, string> = {};
        for (const h of RESPONSE_HEADERS) { const v = res.headers[h]; if (typeof v === 'string') headers[h] = v; }
        ok({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
      };
      res.on('end', finish);
      res.on('close', () => { if (truncated) finish(); });
      res.on('error', (e) => { if (!truncated) fail(new EgressError('read', e.message)); });
    });
    req.on('timeout', () => req.destroy(new EgressError('timeout', 'the request timed out')));
    req.on('error', (e) => fail(e instanceof EgressError ? e : new EgressError('request', e.message)));
    if (o.body) req.write(o.body);
    req.end();
  });
}
