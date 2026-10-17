// The Hub's endpoints (FR-135, docs/22 §2, §9.7): LAN candidates from fake interfaces, health
// checks with a fake probe (a dead URL is withdrawn and logged, recovery re-adds it), ordered
// fallback LAN → Mesh → Relay with the preferred transport logged, sources and their checks, the
// probe history, and the real hello probe against a loopback server.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { NetworkInterfaceInfo } from 'node:os';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hubIdentityStatementBytes,
  type EndpointCandidate,
  type NetworkTransport,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  CertificateAuthority,
  EndpointRegistry,
  MemoryEventSink,
  hubFingerprint,
  lanCandidates,
  listensOnLoopbackOnly,
  probeHello,
  type EndpointConfig,
  type EndpointSource,
} from '../src/index.ts';
import { FakeProbe, iface, networkDb } from './network-env.ts';

const IFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [iface('127.0.0.1', 8, true), iface('::1', 128, true)],
  eth0: [iface('192.168.1.10', 24), iface('fd00::5', 64), iface('fe80::1', 64)],
  docker0: [iface('172.17.0.1', 16)],
  // A mesh address on an ordinary interface name (as some hosts report it).
  eth1: [iface('100.101.1.2', 32), iface('fd7a:115c:a1e0::1', 128)],
  wlan0: [iface('169.254.3.4', 16)],
};

const listener = { host: '0.0.0.0', port: 7419, protocol: 'http' as const };

describe('LAN candidates', () => {
  it('lists the LAN addresses the listener accepts, without bridges, mesh or link-local', () => {
    const urls = (input: Partial<Parameters<typeof lanCandidates>[0]>) =>
      lanCandidates({
        interfaces: IFACES,
        listener,
        includeLoopback: false,
        includeLinkLocal: false,
        ...input,
      }).map((c) => [c.url, c.priority, c.detail]);
    expect(urls({})).toEqual([['http://192.168.1.10:7419', 10, 'eth0']]);
    // `::` takes IPv6 too (never link-local: a URL cannot carry its zone).
    expect(urls({ listener: { ...listener, host: '::' } })).toEqual([
      ['http://192.168.1.10:7419', 10, 'eth0'],
      ['http://[fd00::5]:7419', 12, 'eth0'],
    ]);
    expect(urls({ includeLoopback: true, includeLinkLocal: true }).map((u) => u[0])).toEqual([
      'http://127.0.0.1:7419',
      'http://192.168.1.10:7419',
      'http://169.254.3.4:7419',
    ]);
    // A specific address: only that one.
    expect(urls({ listener: { ...listener, host: '192.168.1.10' } })).toHaveLength(1);
    // Loopback only: nothing for the LAN unless loopback is asked for.
    expect(urls({ listener: { ...listener, host: '127.0.0.1' } })).toEqual([]);
    expect(
      urls({ listener: { ...listener, host: 'localhost' }, includeLoopback: true }).map(
        (u) => u[0],
      ),
    ).toEqual(['http://127.0.0.1:7419', 'http://[::1]:7419']);
    expect(listensOnLoopbackOnly({ ...listener, host: '127.0.0.1' })).toBe(true);
    expect(listensOnLoopbackOnly(listener)).toBe(false);
  });
});

let db: NovaDatabase;
let events: MemoryEventSink;
let probe: FakeProbe;
let cfg: EndpointConfig;
let clock: { now: number };
let registry: EndpointRegistry;

function source(
  transport: 'mesh' | 'relay',
  list: () => EndpointCandidate[],
  check?: EndpointSource['check'],
): EndpointSource {
  return { transport, list: () => Promise.resolve(list()), ...(check ? { check } : {}) };
}

function candidate(
  transport: NetworkTransport,
  url: string,
  health: EndpointCandidate['health'] = 'unknown',
): EndpointCandidate {
  return { transport, url, priority: 0, health, latencyMs: null, checkedAt: null, detail: null };
}

function transportEvents(): {
  kind: string;
  transport: string | null;
  from: string | null;
  url: string | null;
  detail: string | null;
}[] {
  return (
    db.raw
      .prepare(
        'SELECT kind, transport, from_transport AS "from", url, detail FROM network_transport_event ORDER BY created_at, rowid',
      )
      .all() as {
      kind: string;
      transport: string | null;
      from: string | null;
      url: string | null;
      detail: string | null;
    }[]
  ).map((r) => ({ ...r }));
}

beforeEach(async () => {
  db = await networkDb();
  events = new MemoryEventSink();
  probe = new FakeProbe();
  clock = { now: Date.parse('2026-10-17T10:00:00.000Z') };
  cfg = {
    enabled: { lan: true, mesh: true, relay: true, direct: false },
    includeLoopback: false,
    includeLinkLocal: false,
    mdnsHost: null,
    directPublicUrl: null,
  };
  registry = new EndpointRegistry({
    db,
    events,
    config: () => Promise.resolve(cfg),
    interfaces: () => IFACES,
    probe: probe.probe,
    now: () => new Date(clock.now),
    fingerprint: () => Promise.resolve('fp-hub'),
  });
});

afterEach(() => {
  registry.stop();
  db.close();
});

describe('health checks', () => {
  it('needs the listener first, then advertises only what passes its test', async () => {
    const before = await registry.check();
    expect(before.advertised).toEqual([]);
    expect(before.transports.find((t) => t.transport === 'lan')?.detail).toMatch(/not reported/);
    registry.setListener(listener);
    probe.set('http://192.168.1.10:7419', true, 4);
    const r = await registry.check();
    expect(r.advertised.map((c) => [c.transport, c.url, c.health, c.latencyMs])).toEqual([
      ['lan', 'http://192.168.1.10:7419', 'ok', 4],
    ]);
    expect(r.primary).toBe('lan');
    // The probe was asked to confirm it is this Hub.
    expect(probe.calls[0]?.opts.expectFingerprint).toBe('fp-hub');
    expect(registry.advertised()).toEqual(r.advertised);
    expect(registry.checkedAt()).toBe(r.checkedAt);
    expect(transportEvents().map((e) => [e.kind, e.transport, e.url])).toEqual([
      ['advertised', 'lan', 'http://192.168.1.10:7419'],
      ['up', 'lan', null],
      ['primary', 'lan', 'http://192.168.1.10:7419'],
    ]);
    expect(events.names()).toEqual(['network.endpoints.changed', 'network.transport.changed']);
    const changed = events.events.find((e) => e.name === 'network.endpoints.changed');
    expect(changed?.payload).toMatchObject({ added: ['http://192.168.1.10:7419'], removed: [] });
  });

  it('withdraws a dead endpoint, logs it, and re-adds it when it recovers', async () => {
    registry.setListener(listener);
    const seen: string[][] = [];
    registry.onChange((list) => seen.push(list.map((c) => c.url)));
    probe.set('http://192.168.1.10:7419', true);
    await registry.check();
    probe.set('http://192.168.1.10:7419', false, 0, 'connection refused');
    const dead = await registry.check();
    expect(dead.advertised).toEqual([]);
    expect(dead.primary).toBeNull();
    const lan = dead.transports.find((t) => t.transport === 'lan')!;
    expect(lan.status).toBe('down');
    expect(lan.endpoints[0]).toMatchObject({ health: 'failing', detail: 'connection refused' });
    expect(transportEvents().slice(3)).toEqual([
      {
        kind: 'withdrawn',
        transport: 'lan',
        from: null,
        url: 'http://192.168.1.10:7419',
        detail: 'connection refused',
      },
      { kind: 'down', transport: 'lan', from: null, url: null, detail: 'connection refused' },
      {
        kind: 'primary',
        transport: null,
        from: 'lan',
        url: null,
        detail: 'nothing passes its reachability test',
      },
    ]);
    probe.set('http://192.168.1.10:7419', true);
    clock.now += 60_000;
    const back = await registry.check();
    expect(back.advertised.map((c) => c.url)).toEqual(['http://192.168.1.10:7419']);
    expect(transportEvents().at(-1)).toMatchObject({
      kind: 'primary',
      transport: 'lan',
      from: null,
    });
    expect(seen).toEqual([['http://192.168.1.10:7419'], [], ['http://192.168.1.10:7419']]);
    // Nothing changed: no new events.
    const n = events.events.length;
    await registry.check();
    expect(events.events.length).toBe(n);
    // Every probe is in the history, and the 24-hour uptime counts them.
    expect(registry.uptime24h().get('http://192.168.1.10:7419')).toEqual({ checks: 4, ok: 3 });
    // History older than 7 days is pruned.
    clock.now += 8 * 86_400_000;
    await registry.check();
    expect(registry.uptime24h().get('http://192.168.1.10:7419')).toEqual({ checks: 1, ok: 1 });
    const rows = db.raw.prepare('SELECT count(*) AS n FROM network_endpoint_check').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('falls back LAN → Mesh → Relay and logs each change of the preferred transport', async () => {
    registry.setListener(listener);
    probe.set('http://192.168.1.10:7419', true, 2);
    probe.set('http://100.101.1.2:7419', true, 20);
    let relayHealth: EndpointCandidate['health'] = 'ok';
    registry.useSource(source('mesh', () => [candidate('mesh', 'http://100.101.1.2:7419')]));
    registry.useSource(
      source('relay', () => [candidate('relay', 'wss://relay.example/v1/hub', relayHealth)]),
    );
    const all = await registry.check();
    expect(all.advertised.map((c) => [c.transport, c.priority])).toEqual([
      ['lan', 10],
      ['mesh', 20],
      ['relay', 30],
    ]);
    probe.set('http://192.168.1.10:7419', false);
    expect((await registry.check()).primary).toBe('mesh');
    probe.set('http://100.101.1.2:7419', false);
    expect((await registry.check()).primary).toBe('relay');
    relayHealth = 'failing';
    expect((await registry.check()).primary).toBeNull();
    const primaries = transportEvents()
      .filter((e) => e.kind === 'primary')
      .map((e) => [e.from, e.transport]);
    expect(primaries).toEqual([
      [null, 'lan'],
      ['lan', 'mesh'],
      ['mesh', 'relay'],
      ['relay', null],
    ]);
    const changes = events.events.filter((e) => e.name === 'network.transport.changed');
    expect(changes.at(1)?.payload).toMatchObject({
      primary: 'mesh',
      previousPrimary: 'lan',
      changed: ['lan'],
      transports: { lan: 'down', mesh: 'up', relay: 'up', direct: 'off' },
    });
  });

  it('never advertises a disabled transport', async () => {
    registry.setListener(listener);
    probe.set('http://192.168.1.10:7419', true);
    await registry.check();
    cfg.enabled.lan = false;
    const r = await registry.check();
    expect(r.advertised).toEqual([]);
    const lan = r.transports.find((t) => t.transport === 'lan')!;
    expect(lan).toMatchObject({ status: 'off', endpoints: [], enabled: false });
    expect(transportEvents().find((e) => e.kind === 'withdrawn')?.detail).toBe(
      'transport disabled',
    );
    // Turned off is its own event, not a failure (the log must not say the LAN failed).
    expect(transportEvents().filter((e) => e.transport === 'lan' && e.url === null)).toEqual([
      expect.objectContaining({ kind: 'up' }),
      { kind: 'off', transport: 'lan', from: null, url: null, detail: null },
    ]);
    // Disabled transports are not probed.
    const calls = probe.calls.length;
    await registry.check();
    expect(probe.calls.length).toBe(calls);
  });

  it('probes the mDNS name through a LAN address, and the direct public URL last', async () => {
    registry.setListener(listener);
    cfg.mdnsHost = 'hub.local';
    cfg.enabled.direct = true;
    const noUrl = await registry.check();
    expect(noUrl.transports.find((t) => t.transport === 'direct')?.detail).toBe(
      'no public URL is set',
    );
    cfg.directPublicUrl = 'https://hub.example.com/';
    probe.set('http://192.168.1.10:7419', true, 3);
    probe.set('http://hub.local:7419', true, 3);
    probe.set('https://hub.example.com', true, 40);
    const r = await registry.check();
    expect(r.advertised.map((c) => [c.url, c.priority, c.detail])).toEqual([
      ['http://192.168.1.10:7419', 10, 'eth0'],
      ['http://hub.local:7419', 11, 'mdns'],
      ['https://hub.example.com', 40, null],
    ]);
    expect(probe.calls.find((c) => c.url === 'http://hub.local:7419')?.opts.connectAddress).toBe(
      '192.168.1.10',
    );
  });

  it('uses a source’s own check, skips malformed candidates and reports a failing source', async () => {
    registry.setListener(listener);
    const checked: string[] = [];
    registry.useSource(
      source(
        'mesh',
        () => [
          candidate('mesh', 'http://hub.tailnet.example:7419'),
          { transport: 'mesh', url: '' } as unknown as EndpointCandidate,
        ],
        (c) => {
          checked.push(c.url);
          return Promise.resolve({ ok: true, latencyMs: 12 });
        },
      ),
    );
    registry.useSource({ transport: 'relay', list: () => Promise.reject(new Error('relay down')) });
    const r = await registry.check();
    expect(checked).toEqual(['http://hub.tailnet.example:7419']);
    const mesh = r.transports.find((t) => t.transport === 'mesh')!;
    expect(mesh.endpoints.map((c) => [c.url, c.health, c.latencyMs])).toEqual([
      ['http://hub.tailnet.example:7419', 'ok', 12],
    ]);
    expect(r.transports.find((t) => t.transport === 'relay')).toMatchObject({
      status: 'none',
      detail: 'relay down',
    });
    // A failing check is a failing endpoint, not an error.
    const off = registry.useSource(
      source(
        'mesh',
        () => [candidate('mesh', 'http://other:1')],
        () => Promise.reject(new Error('boom')),
      ),
    );
    const r2 = await registry.check();
    expect(r2.transports.find((t) => t.transport === 'mesh')?.endpoints[1]).toMatchObject({
      health: 'failing',
      detail: 'boom',
      priority: 21,
    });
    off();
    const r3 = await registry.check();
    expect(r3.transports.find((t) => t.transport === 'mesh')?.endpoints).toHaveLength(1);
  });

  it('runs on a schedule, one check at a time, and classifies request hosts', async () => {
    const timer: { tick: (() => void) | null } = { tick: null };
    const timed = new EndpointRegistry({
      db,
      config: () => Promise.resolve(cfg),
      interfaces: () => IFACES,
      probe: probe.probe,
      timers: {
        setInterval: (fn) => {
          timer.tick = fn;
          return 1;
        },
        clearInterval: () => {
          timer.tick = null;
        },
      },
    });
    timed.setListener(listener);
    probe.set('http://192.168.1.10:7419', true);
    timed.start(60_000);
    expect(timer.tick).not.toBeNull();
    timer.tick?.();
    timer.tick?.(); // a tick while a check runs is skipped
    await timed.check();
    expect(probe.calls.length).toBe(2);
    expect(timed.classify('192.168.1.10:7419')).toBe('lan');
    expect(timed.classify('localhost:7419')).toBeNull();
    expect(timed.classify('elsewhere:1')).toBeNull();
    expect(timed.classify('bad host')).toBeNull();
    timed.stop();
    expect(timer.tick).toBeNull();
  });
});

// ---- the real probe against a loopback server ---------------------------------------------------

let server: Server;
let base: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

// The Hub identity key the test server proves (trust area, FR-134).
const hubKey = generateKeyPairSync('ed25519');
const HUB_PUB = (hubKey.publicKey.export({ format: 'jwk' }) as { x: string }).x;
const HUB_FP = hubFingerprint(Buffer.from(HUB_PUB, 'base64url'));

function statement(nonce: string, key: KeyObject = hubKey.privateKey, pub = HUB_PUB) {
  const unsigned = {
    v: 1 as const,
    nonce,
    hubFingerprint: HUB_FP,
    hubPublicKey: pub,
    pinning: 'required' as const,
    certificates: [],
    issuedAt: new Date().toISOString(),
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(hubIdentityStatementBytes(unsigned)), key).toString(
      'base64url',
    ),
  };
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** This Hub: hello with its fingerprint, and a signed statement for the nonce it is sent. */
function hub(stmt: (nonce: string) => unknown = statement) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/api/v1/trust/identity') json(res, stmt(u.searchParams.get('nonce') ?? ''));
    else json(res, { name: 'nova-hub', hubFingerprint: HUB_FP });
  };
}

describe('the hello probe', () => {
  beforeEach(async () => {
    handler = hub();
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('requires the fingerprint once the Hub knows its own (review finding 14)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'nova-hub' }));
    };
    expect(await probeHello(base, { timeoutMs: 2_000, expectFingerprint: HUB_FP })).toMatchObject({
      ok: false,
      detail: 'the answer carries no Hub fingerprint',
    });
    // Without a known fingerprint (no trust area yet) a Nova Hub answer is enough.
    expect((await probeHello(base, { timeoutMs: 2_000 })).ok).toBe(true);
  });

  it('proves this Hub with a statement signed for a fresh nonce (review finding 14)', async () => {
    const ok = await probeHello(base, { timeoutMs: 2_000, expectFingerprint: HUB_FP });
    expect(ok).toMatchObject({ ok: true, detail: null });
    // An impostor echoing the public fingerprint: no identity route.
    handler = (req, res) => {
      if (req.url?.startsWith('/api/v1/trust/identity')) json(res, { error: 'nope' }, 404);
      else json(res, { name: 'nova-hub', hubFingerprint: HUB_FP });
    };
    expect((await probeHello(base, { timeoutMs: 2_000, expectFingerprint: HUB_FP })).detail).toBe(
      'the Hub identity could not be proven (HTTP 404)',
    );
    // A recorded statement replayed for another nonce.
    const old = statement('an-old-nonce-from-before');
    handler = hub(() => old);
    expect((await probeHello(base, { timeoutMs: 2_000, expectFingerprint: HUB_FP })).detail).toBe(
      'the identity statement is not for this request',
    );
    // Our nonce, signed by another key while claiming this Hub's public key.
    const other = generateKeyPairSync('ed25519').privateKey;
    handler = hub((nonce) => statement(nonce, other));
    expect((await probeHello(base, { timeoutMs: 2_000, expectFingerprint: HUB_FP })).detail).toBe(
      'the identity signature does not verify',
    );
    // Our nonce, signed correctly by another Hub's key.
    const otherHub = generateKeyPairSync('ed25519');
    const otherPub = (otherHub.publicKey.export({ format: 'jwk' }) as { x: string }).x;
    handler = hub((nonce) => statement(nonce, otherHub.privateKey, otherPub));
    expect((await probeHello(base, { timeoutMs: 2_000, expectFingerprint: HUB_FP })).detail).toBe(
      'another Hub answered',
    );
    handler = hub(() => ({ not: 'a statement' }));
    expect((await probeHello(base, { timeoutMs: 2_000, expectFingerprint: HUB_FP })).detail).toBe(
      'no signed identity statement',
    );
  });

  it('verifies HTTPS against the default roots plus the Hub CA (review finding 11)', async () => {
    const made = (): CertificateAuthority => {
      const c = CertificateAuthority.create();
      return new CertificateAuthority(c.certPem, c.keyPem);
    };
    // A stand-in for a public root (in the default store) and the Hub's own local CA.
    const publicRoot = made();
    const hubCa = made();
    const before = getCACertificates('default');
    setDefaultCACertificates([...before, publicRoot.certPem]);
    const https = async (ca: CertificateAuthority) => {
      const leaf = ca.leaf('localhost');
      const s = createHttpsServer(
        { SNICallback: (_name, cb) => cb(null, leaf.context) },
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name: 'nova-hub' }));
        },
      );
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      return { s, url: `https://localhost:${(s.address() as { port: number }).port}` };
    };
    const pub = await https(publicRoot);
    const own = await https(hubCa);
    try {
      // A publicly issued certificate still verifies once the Hub CA is passed.
      expect(await probeHello(pub.url, { timeoutMs: 2_000, ca: hubCa.certPem })).toMatchObject({
        ok: true,
      });
      expect(await probeHello(own.url, { timeoutMs: 2_000, ca: hubCa.certPem })).toMatchObject({
        ok: true,
      });
      // The Hub's own leaf is not trusted without its CA.
      expect((await probeHello(own.url, { timeoutMs: 2_000 })).detail).toMatch(/certificate/);
    } finally {
      setDefaultCACertificates(before);
      for (const x of [pub.s, own.s]) {
        x.closeAllConnections();
        await new Promise<void>((r) => x.close(() => r()));
      }
    }
  });

  it('passes for this Hub and measures the latency', async () => {
    const r = await probeHello(`${base}/`, { timeoutMs: 2_000, expectFingerprint: HUB_FP });
    expect(r).toMatchObject({ ok: true, detail: null });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('fails for another Hub, a refused host name, something else, a dead port and silence', async () => {
    expect(
      await probeHello(base, { timeoutMs: 2_000, expectFingerprint: 'fp-other' }),
    ).toMatchObject({
      ok: false,
      detail: 'another Hub answered',
    });
    handler = (_req, res) => {
      res.writeHead(403);
      res.end('{}');
    };
    expect((await probeHello(base, { timeoutMs: 2_000 })).detail).toMatch(/refused this host name/);
    handler = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    expect((await probeHello(base, { timeoutMs: 2_000 })).detail).toBe('HTTP 500');
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('<html>');
    };
    expect((await probeHello(base, { timeoutMs: 2_000 })).detail).toBe('not a Nova Hub');
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ name: 'something' }));
    };
    expect((await probeHello(base, { timeoutMs: 2_000 })).detail).toBe('not a Nova Hub');
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(70_000));
    };
    expect((await probeHello(base, { timeoutMs: 2_000 })).detail).toBe('the answer is too large');
    handler = () => undefined; // never answers
    expect(await probeHello(base, { timeoutMs: 100 })).toMatchObject({
      ok: false,
      detail: 'timed out',
    });
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    // Refused, or reset on hosts that answer a closed loopback port that way.
    expect((await probeHello(`http://127.0.0.1:${port}`, { timeoutMs: 2_000 })).detail).toMatch(
      /^(connection refused|the connection was reset)$/,
    );
    expect((await probeHello('not a url', {})).detail).toBe('not a URL');
    expect((await probeHello('ftp://x', {})).detail).toBe('not an http(s) URL');
  });

  it('connects to a given address and keeps the name as Host (an mDNS name)', async () => {
    let host = '';
    handler = (req, res) => {
      host = req.headers.host ?? '';
      res.writeHead(200);
      res.end(JSON.stringify({ name: 'nova-hub' }));
    };
    const port = (server.address() as { port: number }).port;
    const r = await probeHello(`http://nova-test.local:${port}`, {
      timeoutMs: 2_000,
      connectAddress: '127.0.0.1',
    });
    expect(r.ok).toBe(true);
    expect(host).toBe(`nova-test.local:${port}`);
  });

  it('lets the registry advertise a real loopback listener when loopback is included', async () => {
    const port = (server.address() as { port: number }).port;
    const real = new EndpointRegistry({
      db,
      config: () => Promise.resolve({ ...cfg, includeLoopback: true }),
      interfaces: () => ({ lo: [iface('127.0.0.1', 8, true)] }),
      probeTimeoutMs: 2_000,
      fingerprint: () => Promise.resolve(HUB_FP),
    });
    real.setListener({ host: '127.0.0.1', port, protocol: 'http' });
    const r = await real.check();
    expect(r.advertised.map((c) => [c.url, c.health])).toEqual([[`${base}`, 'ok']]);
    expect((await real.probe(base)).ok).toBe(true);
  });
});
