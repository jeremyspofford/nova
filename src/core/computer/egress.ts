// A workspace's way out (M10a, docs/plans/M10a.md "Egress"). A workspace never has a network of its
// own (`--network none`). One whose declaration lets it reach outside gets a relay inside, on
// 127.0.0.1:3128, which carries each connection over its `docker exec` stdio to the proxy here, in
// Nova. The proxy applies the safe-fetch rules (src/safe-fetch.js, Amendment 2026-10-30-C Part 3):
//  - CONNECT only (HTTPS and other TLS streams); plain HTTP, whose requests could be read and
//    changed on the way, is refused;
//  - the host and port must be declared (`declaredHosts`, the browser's host syntax);
//  - the name is resolved here, every address it resolves to must be public, and names that only
//    mean something on a private network are refused, so a declared name can't be pointed at the
//    console, the mesh, the LAN or the tailnet;
//  - the socket connects to exactly the address that was checked (no second lookup to rebind).
// Every attempt, allowed or refused, is recorded. No Docker network is made and nothing is mounted.
import { lookup as dnsLookup } from 'node:dns';
import { connect, isIP } from 'node:net';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { allowed } from '../browser/plan.ts';
import { privateName, publicAddress } from '../../safe-fetch.js';
import { RELAY_PORT } from './policy.ts';

// The relay, run inside the workspace as `nobody` (so the workspace's own user can't reach into its
// file descriptors). Frames on its stdio: type (1 byte), connection id (4), length (4), payload.
// 0 ready, 1 open, 2 data, 3 end, 4 close.
export const RELAY = `
const net = require('net');
const socks = new Map(); let next = 1;
const send = (t, id, b) => { const h = Buffer.alloc(9); h[0] = t; h.writeUInt32BE(id, 1); h.writeUInt32BE(b ? b.length : 0, 5); process.stdout.write(b ? Buffer.concat([h, b]) : h); };
const srv = net.createServer((s) => {
  const id = next++; socks.set(id, s); send(1, id);
  s.on('data', (d) => { for (let i = 0; i < d.length; i += 65536) send(2, id, d.subarray(i, i + 65536)); });
  s.on('end', () => { if (socks.has(id)) send(3, id); });
  s.on('close', () => { if (socks.delete(id)) send(4, id); });
  s.on('error', () => {});
});
srv.on('error', (e) => { process.stderr.write(String(e.code || e.message)); process.exit(3); });
srv.listen(Number(process.argv[1]), '127.0.0.1', () => send(0, 0));
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 9) {
    const t = buf[0], id = buf.readUInt32BE(1), n = buf.readUInt32BE(5);
    if (buf.length < 9 + n) break;
    const b = buf.subarray(9, 9 + n); buf = buf.subarray(9 + n);
    const s = socks.get(id); if (!s) continue;
    if (t === 2) s.write(b); else if (t === 3) s.end(); else if (t === 4) { socks.delete(id); s.destroy(); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

export const RELAY_USER = '65534:65534';
const MAX_FRAME = 65_536;
const MAX_HEAD = 8192;
const HEAD_MS = 10_000;
const CONNECT_MS = 10_000;

export interface Attempt { at: string; host: string; port: number | null; allowed: boolean; why: string; address?: string }

type Lookup = (host: string, cb: (err: Error | null, addresses: { address: string }[]) => void) => void;
const defaultLookup: Lookup = (host, cb) => dnsLookup(host, { all: true }, (err, a) => cb(err, a ?? []));

export interface ProxyOptions {
  hosts: () => string[];
  record: (a: Attempt) => void;
  // Which addresses may be reached: public ones (safe-fetch's `publicAddress`) unless a test says.
  allow?: (address: string) => boolean;
  lookup?: Lookup;
  now?: () => Date;
}

// What the proxy decides for one CONNECT authority, before any connection: the address to connect
// to, or why not. Pure but for the name lookup.
export async function decide(authority: string, o: Pick<ProxyOptions, 'hosts' | 'allow' | 'lookup'>): Promise<{ ok: true; host: string; port: number; address: string } | { ok: false; host: string; port: number | null; why: string }> {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):(\d{1,5})$/.exec(authority);
  if (!m) return { ok: false, host: authority.slice(0, 200), port: null, why: 'not a host:port' };
  const host = m[1]!.toLowerCase().replace(/\.$/, '');
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return { ok: false, host, port, why: 'not a port' };
  if (!allowed(`https://${host}:${port}/`, o.hosts())) return { ok: false, host, port, why: 'not declared for this workspace' };
  const allow = o.allow ?? publicAddress;
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return allow(bare) ? { ok: true, host, port, address: bare } : { ok: false, host, port, why: 'a private address (this computer, the LAN or the tailnet), never reached' };
  if (allow === publicAddress && privateName(bare)) return { ok: false, host, port, why: 'a name on a private network, never reached' };
  const addresses = await new Promise<{ address: string }[] | Error>((ok) => (o.lookup ?? defaultLookup)(bare, (err, a) => ok(err ?? a)));
  if (addresses instanceof Error) return { ok: false, host, port, why: `the name didn’t resolve (${(addresses as NodeJS.ErrnoException).code ?? addresses.message})` };
  if (!addresses.length || addresses.some((a) => !allow(a.address))) return { ok: false, host, port, why: 'it resolves to a private address, never reached' };
  return { ok: true, host, port, address: addresses[0]!.address };
}

// One connection from inside the workspace: its request head is read, judged, and either refused
// with a reason or joined to the one checked address.
export function proxyConnection(client: Duplex, o: ProxyOptions): void {
  const now = o.now ?? (() => new Date());
  let head: Buffer = Buffer.alloc(0);
  let settled = false;
  const refuse = (status: string, why: string, host: string, port: number | null) => {
    o.record({ at: now().toISOString(), host, port, allowed: false, why });
    client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nX-Nova-Refused: ${why.replace(/[^\x20-\x7e]/g, '')}\r\nConnection: close\r\n\r\nNova refused this: ${why}.\n`);
  };
  const timer = setTimeout(() => { if (!settled) { settled = true; client.destroy(); } }, HEAD_MS);
  const onData = (d: Buffer) => {
    if (settled) return;
    head = Buffer.concat([head, d]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      if (head.length > MAX_HEAD) { settled = true; clearTimeout(timer); refuse('431 Request Header Fields Too Large', 'a request head too large', '', null); }
      return;
    }
    settled = true;
    clearTimeout(timer);
    client.off('data', onData);
    client.pause();
    const line = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
    const rest = head.subarray(end + 4);
    const cm = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(line);
    if (!cm) {
      const t = /^[A-Z]+ (?:https?:\/\/)?(\[[^\]]*\]|[^/\s:]+)(?::(\d{1,5}))?/.exec(line);
      refuse('405 Method Not Allowed', 'plain HTTP; the workspace reaches outside over HTTPS (CONNECT) only', (t?.[1] ?? '').slice(0, 200), t?.[2] ? Number(t[2]) : null);
      return;
    }
    void decide(cm[1]!, o).then((d) => {
      if (!d.ok) { refuse('403 Forbidden', d.why, d.host, d.port); return; }
      const up = connect({ host: d.address, port: d.port, timeout: CONNECT_MS });
      let joined = false;
      up.once('connect', () => {
        joined = true;
        up.setTimeout(0);
        o.record({ at: now().toISOString(), host: d.host, port: d.port, allowed: true, why: 'declared, and a public address', address: d.address });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) up.write(rest);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
      const fail = (why: string) => { refuse('502 Bad Gateway', why, d.host, d.port); up.destroy(); };
      up.once('timeout', () => { if (!joined) fail('the host didn’t answer'); });
      up.once('error', (e: NodeJS.ErrnoException) => { if (!joined) fail(`the host couldn’t be reached (${e.code ?? e.message})`); else client.destroy(); });
      client.once('close', () => up.destroy());
      up.once('close', () => { if (joined) client.destroy(); });
    });
  };
  client.on('data', onData);
  client.on('error', () => {});
}

// The Nova side of a relay: frames from its stdout become connections for the proxy; what the proxy
// writes goes back as frames on its stdin. Garbage on the wire ends the tunnel.
export class Tunnel {
  readonly ready: Promise<void>;
  #child: ChildProcess;
  #conns = new Map<number, Duplex>();
  #closed = false;

  constructor(child: ChildProcess, onConnection: (d: Duplex) => void) {
    this.#child = child;
    let ok!: () => void;
    let fail!: (e: Error) => void;
    this.ready = new Promise<void>((a, b) => { ok = a; fail = b; });
    this.ready.catch(() => {});
    const timer = setTimeout(() => fail(new Error('the workspace’s relay didn’t start')), 15_000);
    let buf: Buffer = Buffer.alloc(0);
    let err = '';
    child.stderr?.on('data', (d) => { err = (err + d).slice(-500); });
    child.stdout!.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 9) {
        const t = buf[0]!;
        const id = buf.readUInt32BE(1);
        const n = buf.readUInt32BE(5);
        if (n > MAX_FRAME || t > 4) { this.close(); return; }
        if (buf.length < 9 + n) break;
        const body = Buffer.from(buf.subarray(9, 9 + n));
        buf = buf.subarray(9 + n);
        if (t === 0) { clearTimeout(timer); ok(); continue; }
        if (t === 1) {
          if (this.#conns.has(id)) { this.close(); return; }
          const d = this.#duplex(id);
          this.#conns.set(id, d);
          onConnection(d);
          continue;
        }
        const c = this.#conns.get(id);
        if (!c) continue;
        if (t === 2) c.push(body);
        else if (t === 3) c.push(null);
        else if (t === 4) { this.#conns.delete(id); c.destroy(); }
      }
    });
    child.on('exit', () => { clearTimeout(timer); fail(new Error(`the workspace’s relay stopped${err ? `: ${err.trim()}` : ''}`)); this.#end(); });
    child.on('error', (e) => { clearTimeout(timer); fail(e); this.#end(); });
  }

  get live(): boolean { return !this.#closed && this.#child.exitCode === null; }

  #send(t: number, id: number, body?: Buffer): void {
    if (this.#closed || !this.#child.stdin?.writable) return;
    const h = Buffer.alloc(9);
    h[0] = t;
    h.writeUInt32BE(id, 1);
    h.writeUInt32BE(body ? body.length : 0, 5);
    this.#child.stdin.write(body ? Buffer.concat([h, body]) : h);
  }

  #duplex(id: number): Duplex {
    return new Duplex({
      read() {},
      write: (chunk: Buffer, _enc, cb) => {
        for (let i = 0; i < chunk.length; i += MAX_FRAME) this.#send(2, id, chunk.subarray(i, i + MAX_FRAME));
        cb();
      },
      final: (cb) => { this.#send(3, id); cb(); },
      destroy: (e, cb) => { if (this.#conns.delete(id)) this.#send(4, id); cb(e); },
    });
  }

  #end(): void {
    this.#closed = true;
    for (const c of this.#conns.values()) c.destroy();
    this.#conns.clear();
  }

  close(): void {
    this.#end();
    try { this.#child.stdin?.end(); } catch { /* gone */ }
    this.#child.kill('SIGTERM');
  }
}

export const RELAY_ARGV = ['node', '-e', RELAY, String(RELAY_PORT)];
