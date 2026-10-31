// A workspace's way out (M10a, docs/plans/M10a.md "Egress"). A workspace never has a network of its
// own (`--network none`). One whose declaration lets it reach outside gets a relay inside, on
// 127.0.0.1:3128, for the length of one command, which carries each connection over its
// `docker exec` stdio to the proxy here, in Nova. The proxy applies the safe-fetch rules
// (src/safe-fetch.js, Amendment 2026-10-30-C Part 3):
//  - CONNECT only, and what the tunnel carries must be TLS: a ClientHello whose SNI is the name
//    the tunnel was opened to (none for an address). Plain HTTP, whose requests could be read and
//    changed on the way, is refused, inside a tunnel too;
//  - the host and port must be declared (`declaredHosts`, the browser's host syntax);
//  - the name is resolved here, every address it resolves to must be public, and names that only
//    mean something on a private network are refused, so a declared name can't be pointed at the
//    console, the mesh, the LAN or the tailnet;
//  - the socket connects to exactly the address that was checked (no second lookup to rebind);
//  - each new connection asks again whether the task may still reach outside (`gate`): the person
//    may have gone local-only, or the task may have stopped.
// Memory is bounded: each connection has a window of bytes in flight each way (credit frames), so
// neither side buffers more than that for a reader that doesn't read, a refused connection is
// dropped, and a relay carries at most so many connections at once.
// Every attempt is recorded, with a fixed reason code; the host as asked is kept only in the run's
// own record. No Docker network is made and nothing is mounted.
import { lookup as dnsLookup } from 'node:dns';
import { connect, isIP } from 'node:net';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { allowed } from '../browser/plan.ts';
import { privateName, publicAddress } from '../../safe-fetch.js';
import { RELAY_PORT } from './policy.ts';

// What a tunnel may hold in flight per connection, each way, and how many it carries at once.
export const WINDOW = 131_072;
export const MAX_CONNS = 64;
const MAX_FRAME = 65_536;

// The relay, run inside the workspace as `nobody` (so the workspace's own user can't reach into its
// file descriptors). Frames on its stdio: type (1 byte), connection id (4), length (4), payload.
// 0 ready, 1 open, 2 data, 3 end, 4 close, 5 credit (4 bytes: how many more bytes may be sent).
// A connection's data is sent only while it has credit; credit is given back once its bytes have
// left (for the relay, written to the socket inside).
export const RELAY = `
const net = require('net');
const W = ${WINDOW}, MAX = ${MAX_CONNS};
const socks = new Map(); let next = 1;
const send = (t, id, b) => { const h = Buffer.alloc(9); h[0] = t; h.writeUInt32BE(id, 1); h.writeUInt32BE(b ? b.length : 0, 5); process.stdout.write(b ? Buffer.concat([h, b]) : h); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const srv = net.createServer((s) => {
  s.on('error', () => {});
  if (socks.size >= MAX) { s.destroy(); return; }
  const id = next++; const c = { s, credit: W }; socks.set(id, c); send(1, id);
  s.on('data', (d) => {
    for (let i = 0; i < d.length; i += 65536) send(2, id, d.subarray(i, i + 65536));
    c.credit -= d.length;
    if (c.credit <= 0) s.pause();
  });
  s.on('end', () => { if (socks.has(id)) send(3, id); });
  s.on('close', () => { if (socks.delete(id)) send(4, id); });
});
srv.on('error', (e) => { process.stderr.write(String(e.code || e.message)); process.exit(3); });
srv.listen(Number(process.argv[1]), '127.0.0.1', () => send(0, 0));
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = buf.length ? Buffer.concat([buf, d]) : d;
  while (buf.length >= 9) {
    const t = buf[0], id = buf.readUInt32BE(1), n = buf.readUInt32BE(5);
    if (buf.length < 9 + n) break;
    const b = buf.subarray(9, 9 + n); buf = buf.subarray(9 + n);
    const c = socks.get(id); if (!c) continue;
    if (t === 2) { const len = b.length; c.s.write(b, () => { if (socks.has(id)) send(5, id, u32(len)); }); }
    else if (t === 3) c.s.end();
    else if (t === 4) { socks.delete(id); c.s.destroy(); }
    else if (t === 5 && n === 4) { c.credit += b.readUInt32BE(0); if (c.credit > 0) c.s.resume(); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

export const RELAY_USER = '65534:65534';
const MAX_HEAD = 8192;
const HEAD_MS = 10_000;
const CONNECT_MS = 10_000;
const HELLO_MS = 10_000;
const MAX_HELLO = 65_536;

// Why an attempt went as it did: a fixed code, and the words for it. Summaries say only these (and
// declared names); the host as a command asked for it is untrusted text, kept in the run's record.
export const REASONS = {
  allowed: 'declared, and a public address',
  'bad-request': 'not a host:port',
  'head-too-large': 'a request head too large',
  'plain-http': 'plain HTTP; the workspace reaches outside over HTTPS (CONNECT) only',
  'not-declared': 'not declared for this workspace',
  'private-address': 'a private address (this computer, the LAN or the tailnet), never reached',
  'private-name': 'a name on a private network, never reached',
  unresolved: 'the name didn’t resolve',
  'resolves-private': 'it resolves to a private address, never reached',
  unreachable: 'the host couldn’t be reached',
  'no-answer': 'the host didn’t answer',
  'not-tls': 'not TLS: a tunnel carries TLS only',
  'sni-mismatch': 'its TLS names another host than the one it asked for',
  'local-only': 'your Nova is local-only now',
  'not-approved': 'its task isn’t running with your OK any more',
  ech: 'it hides the name it asks for (Encrypted ClientHello), so Nova can’t check it',
} as const;
export type Code = keyof typeof REASONS;
// Short words for a summary: "3 not declared, 1 plain HTTP".
export const CODE_WORDS: Record<Code, string> = {
  allowed: 'allowed', 'bad-request': 'not host:port', 'head-too-large': 'too large', 'plain-http': 'plain HTTP', 'not-declared': 'not declared',
  'private-address': 'a private address', 'private-name': 'a private name', unresolved: 'didn’t resolve', 'resolves-private': 'resolves privately',
  unreachable: 'unreachable', 'no-answer': 'no answer', 'not-tls': 'not TLS', 'sni-mismatch': 'TLS for another host', 'local-only': 'local-only', 'not-approved': 'no OK', ech: 'Encrypted ClientHello',
};

export interface Attempt { at: string; host: string; port: number | null; allowed: boolean; code: Code; why: string; address?: string }

// The host as asked, as it may be kept in a record: printable, at most 255 characters.
const asAsked = (h: string) => h.replace(/[^\x21-\x7e]/g, '?').slice(0, 255);

type Lookup = (host: string, cb: (err: Error | null, addresses: { address: string }[]) => void) => void;
const defaultLookup: Lookup = (host, cb) => dnsLookup(host, { all: true }, (err, a) => cb(err, a ?? []));

export interface ProxyOptions {
  hosts: () => string[];
  record: (a: Attempt) => void;
  // Asked on every new connection: null while the task may reach outside, else the code why not.
  gate?: () => 'local-only' | 'not-approved' | null;
  // Which addresses may be reached: public ones (safe-fetch's `publicAddress`) unless a test says.
  allow?: (address: string) => boolean;
  lookup?: Lookup;
  now?: () => Date;
}

type Decision = { ok: true; host: string; port: number; address: string } | { ok: false; host: string; port: number | null; code: Code; why: string };
const no = (host: string, port: number | null, code: Code): Decision => ({ ok: false, host, port, code, why: REASONS[code] });

// What the proxy decides for one CONNECT authority, before any connection: the address to connect
// to, or why not. Pure but for the name lookup.
export async function decide(authority: string, o: Pick<ProxyOptions, 'hosts' | 'allow' | 'lookup'>): Promise<Decision> {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):(\d{1,5})$/.exec(authority);
  if (!m) return no(asAsked(authority), null, 'bad-request');
  const host = m[1]!.toLowerCase().replace(/\.$/, '');
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return no(asAsked(host), port, 'bad-request');
  if (!allowed(`https://${host}:${port}/`, o.hosts())) return no(asAsked(host), port, 'not-declared');
  const allow = o.allow ?? publicAddress;
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return allow(bare) ? { ok: true, host, port, address: bare } : no(host, port, 'private-address');
  if (allow === publicAddress && privateName(bare)) return no(host, port, 'private-name');
  const addresses = await new Promise<{ address: string }[] | Error>((ok) => (o.lookup ?? defaultLookup)(bare, (err, a) => ok(err ?? a)));
  if (addresses instanceof Error) return no(host, port, 'unresolved');
  if (!addresses.length || addresses.some((a) => !allow(a.address))) return no(host, port, 'resolves-private');
  return { ok: true, host, port, address: addresses[0]!.address };
}

// The SNI of a TLS ClientHello at the start of `b`, without a handshake. `tls: false` when the bytes
// aren't a TLS handshake at all; `complete: false` when more are needed to tell. `ech: true` when
// it carries Encrypted ClientHello (extension 0xfe0d): then the SNI here is only the outer name,
// and the name the client really asks for is encrypted where Nova can't check it.
export const ECH_EXTENSION = 0xfe0d;
export function clientHelloSni(b: Buffer): { tls: boolean; complete: boolean; sni: string | null; ech?: true } {
  const more = { tls: true, complete: false, sni: null };
  const notTls = { tls: false, complete: true, sni: null };
  if (!b.length) return more;
  if (b[0] !== 0x16) return notTls;
  // The handshake bytes, from as many records as it takes.
  const hs: Buffer[] = [];
  let have = 0;
  let need = -1;
  for (let at = 0; ;) {
    if (b.length < at + 5) return more;
    if (b[at] !== 0x16 || b[at + 1] !== 0x03) return notTls;
    const len = b.readUInt16BE(at + 3);
    if (len === 0 || len > 16_384 + 2048) return notTls;
    const body = b.subarray(at + 5, at + 5 + len);
    hs.push(body);
    have += body.length;
    if (need < 0 && have >= 4) {
      const head = Buffer.concat(hs);
      if (head[0] !== 0x01) return notTls;
      need = 4 + head.readUIntBE(1, 3);
      if (need > MAX_HELLO) return notTls;
    }
    if (need >= 0 && have >= need) break;
    if (body.length < len) return more;
    at += 5 + len;
  }
  const h = Buffer.concat(hs).subarray(4, need);
  try {
    let p = 2 + 32;
    p += 1 + h[p]!;
    p += 2 + h.readUInt16BE(p);
    p += 1 + h[p]!;
    if (p === h.length) return { tls: true, complete: true, sni: null };
    const end = p + 2 + h.readUInt16BE(p);
    if (end > h.length) return notTls;
    p += 2;
    // Every extension is read (not only up to the SNI), so an ECH one after it is seen too.
    let sni: string | null = null;
    let ech = false;
    while (p + 4 <= end) {
      const type = h.readUInt16BE(p);
      const len = h.readUInt16BE(p + 2);
      const data = h.subarray(p + 4, p + 4 + len);
      if (data.length !== len) return notTls;
      if (type === 0) {
        if (sni !== null || data.length < 5 || data[2] !== 0) return notTls;
        const n = data.readUInt16BE(3);
        const name = data.subarray(5, 5 + n).toString('latin1');
        if (name.length !== n || !/^[\x21-\x7e]+$/.test(name)) return notTls;
        sni = name.toLowerCase().replace(/\.$/, '');
      } else if (type === ECH_EXTENSION) ech = true;
      p += 4 + len;
    }
    return { tls: true, complete: true, sni, ...(ech ? { ech: true as const } : {}) };
  } catch { return notTls; }
}

// One connection from inside the workspace: its request head is read, judged, and either refused
// with a reason (and dropped) or joined to the one checked address, once what it carries is TLS for
// the host it asked for.
export function proxyConnection(client: Duplex, o: ProxyOptions): void {
  const now = o.now ?? (() => new Date());
  let head: Buffer = Buffer.alloc(0);
  let settled = false;
  const record = (host: string, port: number | null, code: Code, address?: string) => o.record({ at: now().toISOString(), host, port, allowed: code === 'allowed', code, why: REASONS[code], ...(address ? { address } : {}) });
  // Refused: the answer, then the connection is dropped, so nothing it sends afterwards is held.
  const refuse = (status: string, code: Code, host: string, port: number | null) => {
    record(host, port, code);
    client.off('data', onData);
    const why = REASONS[code];
    client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nX-Nova-Refused: ${why.replace(/[^\x20-\x7e]/g, '')}\r\nConnection: close\r\n\r\nNova refused this: ${why}.\n`, () => client.destroy());
    setTimeout(() => client.destroy(), 1000).unref();
  };
  const timer = setTimeout(() => { if (!settled) { settled = true; client.destroy(); } }, HEAD_MS);
  const onData = (d: Buffer) => {
    if (settled) return;
    head = Buffer.concat([head, d]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      if (head.length > MAX_HEAD) { settled = true; clearTimeout(timer); refuse('431 Request Header Fields Too Large', 'head-too-large', '', null); }
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
      refuse('405 Method Not Allowed', 'plain-http', asAsked(t?.[1] ?? ''), t?.[2] ? Number(t[2]) : null);
      return;
    }
    const gated = o.gate?.() ?? null;
    if (gated) {
      const a = /^(.*):(\d{1,5})$/.exec(cm[1]!);
      refuse('403 Forbidden', gated, asAsked(a?.[1] ?? cm[1]!), a ? Number(a[2]) : null);
      return;
    }
    void decide(cm[1]!, o).then((d) => {
      if (!d.ok) { refuse('403 Forbidden', d.code, d.host, d.port); return; }
      const up = connect({ host: d.address, port: d.port, timeout: CONNECT_MS });
      let joined = false;
      up.once('connect', () => {
        up.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // What the tunnel carries must be TLS for the host it asked for: its ClientHello is read
        // (up to a cap) before a byte goes on.
        let hello = rest;
        const wantSni = isIP(d.host.replace(/^\[|\]$/g, '')) ? null : d.host;
        const helloTimer = setTimeout(() => drop('not-tls'), HELLO_MS);
        const drop = (code: Code) => { clearTimeout(helloTimer); client.off('data', onHello); record(d.host, d.port, code); up.destroy(); client.destroy(); };
        const judge = () => {
          const s = clientHelloSni(hello);
          if (!s.complete) { if (hello.length > MAX_HELLO) drop('not-tls'); return; }
          if (!s.tls) { drop('not-tls'); return; }
          if (s.ech) { drop('ech'); return; }
          if (s.sni !== wantSni) { drop('sni-mismatch'); return; }
          clearTimeout(helloTimer);
          client.off('data', onHello);
          client.pause();
          joined = true;
          record(d.host, d.port, 'allowed', d.address);
          up.write(hello);
          client.pipe(up);
          up.pipe(client);
          client.resume();
        };
        const onHello = (x: Buffer) => { hello = Buffer.concat([hello, x]); judge(); };
        client.on('data', onHello);
        if (hello.length) judge();
        client.resume();
      });
      const fail = (code: Code) => { refuse('502 Bad Gateway', code, d.host, d.port); up.destroy(); };
      up.once('timeout', () => { if (!joined) fail('no-answer'); });
      up.once('error', () => { if (!joined) fail('unreachable'); else client.destroy(); });
      client.once('close', () => up.destroy());
      up.once('close', () => { if (joined) client.destroy(); });
    });
  };
  client.on('data', onData);
  client.on('error', () => {});
}

interface Conn { d: Duplex; sendCredit: number; pending: { chunk: Buffer; cb: (e?: Error | null) => void } | null; pushed: number; granted: number }

// The Nova side of a relay: frames from its stdout become connections for the proxy; what the proxy
// writes goes back as frames on its stdin, each connection within its window. Garbage on the wire,
// or a relay sending past its credit, ends the tunnel.
export class Tunnel {
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  #child: ChildProcess;
  #conns = new Map<number, Conn>();
  #closed = false;

  constructor(child: ChildProcess, onConnection: (d: Duplex) => void) {
    this.#child = child;
    let ok!: () => void;
    let fail!: (e: Error) => void;
    this.ready = new Promise<void>((a, b) => { ok = a; fail = b; });
    this.ready.catch(() => {});
    let gone!: () => void;
    this.exited = new Promise<void>((a) => { gone = a; });
    const timer = setTimeout(() => fail(new Error('the workspace’s relay didn’t start')), 15_000);
    let buf: Buffer = Buffer.alloc(0);
    let err = '';
    child.stderr?.on('data', (d) => { err = (err + d).slice(-200); });
    child.stdout!.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 9) {
        const t = buf[0]!;
        const id = buf.readUInt32BE(1);
        const n = buf.readUInt32BE(5);
        if (n > MAX_FRAME || t > 5) { this.close(); return; }
        if (buf.length < 9 + n) break;
        const body = Buffer.from(buf.subarray(9, 9 + n));
        buf = buf.subarray(9 + n);
        if (t === 0) { clearTimeout(timer); ok(); continue; }
        if (t === 1) {
          if (this.#conns.has(id)) { this.close(); return; }
          if (this.#conns.size >= MAX_CONNS) { this.#send(4, id); continue; }
          const c = this.#conn(id);
          this.#conns.set(id, c);
          onConnection(c.d);
          continue;
        }
        const c = this.#conns.get(id);
        if (!c) continue;
        if (t === 2) {
          // Past its credit (and one read's worth of slack): the relay isn't Nova's any more.
          if (c.pushed + n > c.granted + MAX_FRAME) { this.close(); return; }
          c.pushed += n;
          c.d.push(body);
          this.#grant(id, c);
        } else if (t === 3) c.d.push(null);
        else if (t === 4) { this.#conns.delete(id); c.d.destroy(); }
        else if (t === 5 && n === 4) { c.sendCredit += body.readUInt32BE(0); this.#flush(id, c); }
      }
    });
    const end = (e?: Error) => { clearTimeout(timer); fail(e ?? new Error(`the workspace’s relay stopped${err ? `: ${err.replace(/[^\x20-\x7e]/g, '').trim()}` : ''}`)); this.#end(); gone(); };
    child.on('exit', () => end());
    child.on('error', (e) => end(e));
  }

  get live(): boolean { return !this.#closed && this.#child.exitCode === null; }

  // What the proxy holds for its connections right now, both ways (the bound is per connection).
  get buffered(): number {
    let n = this.#child.stdin?.writableLength ?? 0;
    for (const c of this.#conns.values()) n += c.d.readableLength + c.d.writableLength + (c.pending?.chunk.length ?? 0);
    return n;
  }

  #send(t: number, id: number, body?: Buffer): void {
    if (this.#closed || !this.#child.stdin?.writable) return;
    const h = Buffer.alloc(9);
    h[0] = t;
    h.writeUInt32BE(id, 1);
    h.writeUInt32BE(body ? body.length : 0, 5);
    this.#child.stdin.write(body ? Buffer.concat([h, body]) : h);
  }

  // Credit back to the relay for what the proxy has taken from this connection, half a window at a
  // time: the relay never has more than a window of it in flight or waiting here.
  #grant(id: number, c: Conn): void {
    const consumed = c.pushed - c.d.readableLength;
    if (c.granted - consumed > WINDOW / 2) return;
    const add = consumed + WINDOW - c.granted;
    c.granted += add;
    const b = Buffer.alloc(4);
    b.writeUInt32BE(add);
    this.#send(5, id, b);
  }

  // Sends what is waiting for this connection while it has credit; the writer waits otherwise.
  #flush(id: number, c: Conn): void {
    while (c.pending && c.sendCredit > 0) {
      const take = Math.min(c.pending.chunk.length, c.sendCredit, MAX_FRAME);
      this.#send(2, id, c.pending.chunk.subarray(0, take));
      c.sendCredit -= take;
      c.pending.chunk = c.pending.chunk.subarray(take);
      if (!c.pending.chunk.length) { const cb = c.pending.cb; c.pending = null; cb(); }
    }
  }

  #conn(id: number): Conn {
    const c: Conn = { d: null as unknown as Duplex, sendCredit: WINDOW, pending: null, pushed: 0, granted: WINDOW };
    c.d = new Duplex({
      readableHighWaterMark: WINDOW,
      read: () => this.#grant(id, c),
      write: (chunk: Buffer, _enc, cb) => {
        if (!this.#conns.has(id)) { cb(new Error('closed')); return; }
        c.pending = { chunk, cb };
        this.#flush(id, c);
      },
      final: (cb) => { this.#send(3, id); cb(); },
      destroy: (e, cb) => {
        if (this.#conns.delete(id)) this.#send(4, id);
        const p = c.pending;
        c.pending = null;
        p?.cb(e ?? new Error('closed'));
        cb(e);
      },
    });
    return c;
  }

  #end(): void {
    this.#closed = true;
    for (const c of this.#conns.values()) c.d.destroy();
    this.#conns.clear();
  }

  // Closes the tunnel: the relay is told (its stdin ends, and it exits), then stopped if it hasn't.
  // Resolves once its process is gone.
  close(): Promise<void> {
    this.#end();
    try { this.#child.stdin?.end(); } catch { /* gone */ }
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      const term = setTimeout(() => this.#child.kill('SIGTERM'), 2000);
      const kill = setTimeout(() => this.#child.kill('SIGKILL'), 4000);
      void this.exited.then(() => { clearTimeout(term); clearTimeout(kill); });
    }
    return this.exited;
  }
}

export const RELAY_ARGV = ['node', '-e', RELAY, String(RELAY_PORT)];
