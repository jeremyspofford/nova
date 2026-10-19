// The Relay's resource limits (FR-137, security review of M6.5): the delivery queue bounded per
// Hub and in total (oldest first), client routes per Hub and in total, Hubs and connections in
// total, unused and abandoned Hubs forgotten, debounced asynchronous state writes, and per-address
// limits that a client cannot dodge with X-Forwarded-For behind a trusted proxy.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_SUBPROTOCOL } from '@nova/relay';
import { MemoryLog, silentLog } from '../src/log.ts';
import {
  RelayState,
  buildRelayServer,
  parseTrustProxy,
  type RelayServer,
  type RelayServerOptions,
} from '../src/index.ts';

const servers: RelayServer[] = [];
const sockets: WebSocket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(opts: RelayServerOptions = {}) {
  const relay = await buildRelayServer({
    log: silentLog,
    ...opts,
  });
  servers.push(relay);
  const base = await relay.app.listen({ host: '127.0.0.1', port: 0 });
  return { relay, base };
}

async function j(base: string, method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const CODE_HASH = 'A'.repeat(43);

/** A Hub with `n` confirmed client routes, all minted by one party (the review's probe). */
async function mint(base: string, n: number) {
  const hub = (await j(base, 'POST', '/v1/relay/hubs')).json as {
    routeId: string;
    routeToken: string;
  };
  const routes: { routeId: string; clientId: string; status: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = await j(
      base,
      'POST',
      '/v1/relay/pairings',
      {
        codeHash: CODE_HASH,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        offer: 'AAAA',
      },
      hub.routeToken,
    );
    const c = await j(base, 'POST', `/v1/relay/pairings/${String(p.json.pairingId)}/claim`, {
      codeHash: CODE_HASH,
      blob: 'AAAA',
    });
    if (c.status === 201)
      await j(
        base,
        'POST',
        `/v1/relay/pairings/${String(p.json.pairingId)}/confirm`,
        {},
        hub.routeToken,
      );
    routes.push({
      routeId: String(c.json.routeId),
      clientId: String(c.json.clientId),
      status: c.status,
    });
  }
  return { hub, routes };
}

async function open(base: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/relay/connect`, [
    RELAY_SUBPROTOCOL,
    `bearer.${token}`,
  ]);
  sockets.push(ws);
  await new Promise((r, x) => {
    ws.onopen = r;
    ws.onclose = x;
  });
  return ws;
}

const CT = 'A'.repeat(10_000);
const frame = (to: string, from: string, client: string, seq: number) =>
  JSON.stringify({ v: 1, kind: 'data', to, from, client, stream: 'h1', seq, ct: CT });
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('the delivery queue', () => {
  it('bounds what one Hub can park across its routes', async () => {
    const { relay, base } = await start({ limits: { hubQueueMaxBytes: 300_000 } });
    const { hub, routes } = await mint(base, 6);
    const ws = await open(base, hub.routeToken);
    for (const r of routes)
      for (let k = 1; k <= 10; k++) ws.send(frame(r.routeId, hub.routeId, r.clientId, k));
    await settle();
    // Without the per-Hub bound this is ~612 KB (6 routes × 10 frames × 10 KB).
    expect(relay.stats().queuedBytes).toBeLessThanOrEqual(300_000);
    expect(relay.stats().evicted).toBeGreaterThan(0);
    // The oldest went first: the first route lost its frames, the last kept them.
    expect(relay.queued(routes[0]!.routeId)).toBe(0);
    expect(relay.queued(routes[5]!.routeId)).toBe(10);
  });

  it('bounds the total across Hubs, oldest first', async () => {
    const { relay, base } = await start({ limits: { queueMaxTotalBytes: 500_000 } });
    const a = await mint(base, 3);
    const b = await mint(base, 3);
    const wa = await open(base, a.hub.routeToken);
    for (const r of a.routes)
      for (let k = 1; k <= 10; k++) wa.send(frame(r.routeId, a.hub.routeId, r.clientId, k));
    await settle();
    const wb = await open(base, b.hub.routeToken);
    for (const r of b.routes)
      for (let k = 1; k <= 10; k++) wb.send(frame(r.routeId, b.hub.routeId, r.clientId, k));
    await settle();
    expect(relay.stats().queuedBytes).toBeLessThanOrEqual(500_000);
    expect(relay.queued(a.routes[0]!.routeId)).toBe(0);
    expect(relay.queued(b.routes[2]!.routeId)).toBe(10);
  });

  it('forgets a revoked route’s frames and expires old ones', async () => {
    let t = Date.now();
    const { relay, base } = await start({ now: () => t, limits: { queueMaxAgeMs: 10_000 } });
    const { hub, routes } = await mint(base, 2);
    const ws = await open(base, hub.routeToken);
    for (const r of routes) ws.send(frame(r.routeId, hub.routeId, r.clientId, 1));
    await settle();
    await j(base, 'DELETE', `/v1/relay/routes/${routes[0]!.routeId}`, undefined, hub.routeToken);
    expect(relay.queued(routes[0]!.routeId)).toBe(0);
    expect(relay.queued(routes[1]!.routeId)).toBe(1);
    t += 10_001;
    relay.sweep();
    expect(relay.stats().queuedBytes).toBe(0);
  });
});

describe('registration limits', () => {
  it('caps client routes per Hub and in total', async () => {
    const { base } = await start({ limits: { maxRoutesPerHub: 3, maxRoutes: 4 } });
    const a = await mint(base, 4);
    expect(a.routes.map((r) => r.status)).toEqual([201, 201, 201, 429]);
    const b = await mint(base, 2);
    expect(b.routes.map((r) => r.status)).toEqual([201, 503]);
  });

  it('caps Hubs and connections in total', async () => {
    const { base } = await start({ limits: { maxHubs: 2, maxConnections: 1 } });
    const h1 = await j(base, 'POST', '/v1/relay/hubs');
    await j(base, 'POST', '/v1/relay/hubs');
    const full = await j(base, 'POST', '/v1/relay/hubs');
    expect(full.status).toBe(503);
    expect(full.json.error).toMatchObject({ code: 'relay_full' });
    const token = String(h1.json.routeToken);
    const first = await open(base, token);
    const second = new WebSocket(`${base.replace('http', 'ws')}/v1/relay/connect`, [
      RELAY_SUBPROTOCOL,
      `bearer.${token}`,
    ]);
    sockets.push(second);
    const closed = await new Promise<number>((r) =>
      second.addEventListener('close', (e) => r(e.code)),
    );
    expect(closed).toBe(1013);
    expect(first.readyState).toBe(1);
  });

  it('forgets unused and abandoned Hubs, never a connected one', async () => {
    let t = Date.now();
    const { relay, base } = await start({
      now: () => t,
      limits: { hubUnusedTtlMs: 60_000, hubIdleTtlMs: 600_000 },
    });
    const unused = (await j(base, 'POST', '/v1/relay/hubs')).json;
    const withClients = await mint(base, 1);
    const live = (await j(base, 'POST', '/v1/relay/hubs')).json;
    await open(base, String(live.routeToken));
    t += 60_001;
    relay.sweep();
    expect(relay.state.hubs.has(String(unused.routeId))).toBe(false);
    expect(
      (await j(base, 'GET', '/v1/relay/routes', undefined, String(unused.routeToken))).status,
    ).toBe(401);
    // A Hub with clients waits longer, then goes with its routes.
    expect(relay.state.hubs.has(withClients.hub.routeId)).toBe(true);
    t += 600_000;
    relay.sweep();
    expect(relay.state.hubs.has(withClients.hub.routeId)).toBe(false);
    expect(relay.state.routes.has(withClients.routes[0]!.routeId)).toBe(false);
    expect(relay.state.hubs.has(String(live.routeId))).toBe(true);
  });
});

describe('state writes', () => {
  it('are debounced and asynchronous, and flushed on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-relay-w-'));
    dirs.push(dir);
    const file = join(dir, 'relay-state.json');
    const { relay, base } = await start({ dataDir: dir, saveDebounceMs: 100 });
    for (let i = 0; i < 3; i++) await j(base, 'POST', '/v1/relay/hubs');
    // Nothing written yet: the changes share one later write.
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect((JSON.parse(readFileSync(file, 'utf8')) as { hubs: unknown[] }).hubs).toHaveLength(3);
    await j(base, 'POST', '/v1/relay/hubs');
    await relay.close();
    servers.splice(servers.indexOf(relay), 1);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { hubs: unknown[] }).hubs).toHaveLength(4);
  });

  it('report a failed write and retry it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-relay-e-'));
    dirs.push(dir);
    const state = new RelayState({ dataDir: dir, saveDebounceMs: 10 });
    const errors: unknown[] = [];
    state.onWriteError = (err) => errors.push(err);
    // A directory where the temporary file goes makes the write fail.
    mkdirSync(join(dir, 'relay-state.json.tmp'));
    state.addHub({
      routeId: 'HUBROUTE00000000',
      tokenHash: 'x',
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    });
    await state.flush();
    expect(errors).toHaveLength(1);
    rmSync(join(dir, 'relay-state.json.tmp'), { recursive: true });
    await state.flush();
    expect(new RelayState({ dataDir: dir }).hubs.size).toBe(1);
  });
});

describe('per-address limits behind a proxy', () => {
  async function registrations(trustProxy: RelayServerOptions['trustProxy']) {
    const logs = new MemoryLog();
    const relay = await buildRelayServer({
      log: logs,
      trustProxy,
    });
    servers.push(relay);
    let created = 0;
    for (let i = 0; i < 30; i++) {
      // The proxy (10.0.0.1) appends the real peer; the client wrote its own entry first.
      const res = await relay.app.inject({
        method: 'POST',
        url: '/v1/relay/hubs',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.7` },
      });
      if (res.statusCode === 201) created++;
    }
    return created;
  }

  it('keys on the address the trusted proxy saw, not one the client wrote', async () => {
    expect(await registrations(false)).toBe(20);
    expect(await registrations(1)).toBe(20);
    expect(await registrations(['10.0.0.1'])).toBe(20);
    expect(await registrations('10.0.0.0/8')).toBe(20);
  });

  it('refuses `true` and malformed settings', async () => {
    expect(() => parseTrustProxy(true)).toThrow('not true');
    await expect(buildRelayServer({ trustProxy: true as unknown as false })).rejects.toThrow(
      'not true',
    );
    expect(() => parseTrustProxy(0)).toThrow('1..10');
    expect(() => parseTrustProxy('10.0.0.1/33')).toThrow('CIDR');
    expect(() => parseTrustProxy('proxy.local')).toThrow('CIDR');
    expect(() => parseTrustProxy('')).toThrow('at least one');
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.1, ::1/128')).toEqual(['10.0.0.1', '::1/128']);
    expect(parseTrustProxy(undefined)).toBe(false);
  });
});
