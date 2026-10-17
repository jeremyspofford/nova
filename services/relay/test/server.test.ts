// The Relay service over real sockets on 127.0.0.1 (FR-137, contracts/rest-api.md §3): Hub
// registration, pairing open/claim/confirm (wrong code, expired, reused), connecting with a route
// token (a bad one refused), routing between connections, unknown routes, too-large frames,
// revocation (closes with `revoked`, refuses reconnects), queue bounds, push wake-ups, idle and
// per-route limits, persistence of registrations only, and health.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_SUBPROTOCOL, parseEnvelope, type RelayEnvelope } from '@nova/relay';
import { Logger } from '@nova/telemetry';
import {
  MockPushSender,
  RelayState,
  buildRelayServer,
  type RelayServer,
  type RelayServerOptions,
} from '../src/index.ts';

const servers: RelayServer[] = [];
const dirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quiet = () => new Logger({ module: 'relay', sinks: [] });
const CODE_HASH = 'h'.repeat(43);
const OFFER = 'AAAA';
const BLOB = 'QkxPQg==';

async function start(opts: RelayServerOptions = {}) {
  const relay = await buildRelayServer({ log: quiet(), ...opts });
  servers.push(relay);
  const address = await relay.app.listen({ host: '127.0.0.1', port: 0 });
  return { relay, base: address };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON
type WireJson = Record<string, any>;

async function call(base: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as WireJson };
}

interface Sock {
  ws: WebSocket;
  frames: RelayEnvelope[];
  opened: Promise<boolean>;
  closed: Promise<{ code: number; reason: string }>;
  next(pred?: (e: RelayEnvelope) => boolean, ms?: number): Promise<RelayEnvelope>;
  send(env: unknown): void;
}

function connect(base: string, token: string, how: 'protocol' | 'none' = 'protocol'): Sock {
  const url = `${base.replace(/^http/, 'ws')}/v1/relay/connect`;
  const ws = new WebSocket(
    url,
    how === 'protocol' ? [RELAY_SUBPROTOCOL, `bearer.${token}`] : [RELAY_SUBPROTOCOL],
  );
  sockets.push(ws);
  const frames: RelayEnvelope[] = [];
  const waiters: { pred: (e: RelayEnvelope) => boolean; resolve: (e: RelayEnvelope) => void }[] =
    [];
  ws.onmessage = (ev) => {
    const c = parseEnvelope(String(ev.data));
    if (!c.ok) return;
    frames.push(c.envelope);
    for (const w of [...waiters]) {
      if (w.pred(c.envelope)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(c.envelope);
      }
    }
  };
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('close', () => resolve(false));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })),
  );
  return {
    ws,
    frames,
    opened,
    closed,
    next(pred = () => true, ms = 3_000) {
      const have = frames.find(pred);
      if (have) {
        frames.splice(frames.indexOf(have), 1);
        return Promise.resolve(have);
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no frame')), ms);
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(t);
            frames.splice(frames.indexOf(e), 1);
            resolve(e);
          },
        });
      });
    },
    send(env) {
      ws.send(typeof env === 'string' ? env : JSON.stringify(env));
    },
  };
}

async function registerHub(base: string) {
  const r = await call(base, 'POST', '/v1/relay/hubs');
  expect(r.status).toBe(201);
  return r.json as { routeId: string; routeToken: string };
}

async function pairClient(base: string, hub: { routeToken: string }, id = 'pairing-000000000001') {
  const opened = await call(
    base,
    'POST',
    '/v1/relay/pairings',
    {
      id,
      codeHash: CODE_HASH,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      offer: OFFER,
    },
    hub.routeToken,
  );
  expect(opened.status).toBe(201);
  const claim = await call(base, 'POST', `/v1/relay/pairings/${id}/claim`, {
    codeHash: CODE_HASH,
    blob: BLOB,
  });
  expect(claim.status).toBe(201);
  return claim.json as {
    clientId: string;
    routeId: string;
    routeToken: string;
    hubRouteId: string;
    offer: string;
  };
}

async function activeClient(base: string, hub: { routeToken: string }, id?: string) {
  const c = await pairClient(base, hub, id);
  const pid = id ?? 'pairing-000000000001';
  expect(
    (await call(base, 'POST', `/v1/relay/pairings/${pid}/confirm`, {}, hub.routeToken)).status,
  ).toBe(200);
  return c;
}

const data = (to: string, from: string, client: string, seq = 1): RelayEnvelope => ({
  v: 1,
  kind: 'data',
  to,
  from,
  client,
  stream: 'c1',
  seq,
  seg: { i: 0, n: 1 },
  ct: 'AAAA',
});

describe('registration and health', () => {
  it('answers health and registers Hubs', async () => {
    const { base } = await start({ version: '1.2.3' });
    expect((await call(base, 'GET', '/v1/relay/health')).json).toEqual({
      status: 'ok',
      version: '1.2.3',
    });
    const hub = await registerHub(base);
    expect(hub.routeId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(hub.routeToken).toMatch(/^nvr_/);
  });

  it('needs the registration token when one is set, and rate-limits registrations', async () => {
    const { base } = await start({
      registrationToken: 'admin-secret',
      limits: { registrationsPerHour: 2 },
    });
    expect((await call(base, 'POST', '/v1/relay/hubs')).status).toBe(401);
    expect((await call(base, 'POST', '/v1/relay/hubs', undefined, 'admin-secret')).status).toBe(
      201,
    );
    const third = await call(base, 'POST', '/v1/relay/hubs', undefined, 'admin-secret');
    expect(third.status).toBe(429);
    expect(third.json.error).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('answers the channel relay routes with 501 until M7', async () => {
    const { base } = await start();
    const m = await call(base, 'POST', '/v1/relay/messages', {});
    expect(m.status).toBe(501);
    expect(m.json.error.code).toBe('not_implemented');
    expect((await call(base, 'GET', '/v1/relay/outbox?since=1')).status).toBe(501);
  });
});

describe('pairing', () => {
  it('opens, claims and confirms a slot; the claim reaches the Hub', async () => {
    const { base } = await start();
    const hub = await registerHub(base);
    const hubSock = connect(base, hub.routeToken);
    expect(await hubSock.opened).toBe(true);
    const c = await pairClient(base, hub);
    expect(c).toMatchObject({ hubRouteId: hub.routeId, offer: OFFER });
    const claim = await hubSock.next((e) => e.kind === 'data');
    expect(claim).toMatchObject({
      to: hub.routeId,
      from: c.routeId,
      client: c.clientId,
      stream: 'pair.pairing-000000000001',
      seq: 1,
      ct: BLOB,
    });
    let routes = await call(base, 'GET', '/v1/relay/routes', undefined, hub.routeToken);
    expect(routes.json.items).toEqual([
      expect.objectContaining({
        routeId: c.routeId,
        clientId: c.clientId,
        status: 'pending',
        connected: false,
      }),
    ]);
    const conf = await call(
      base,
      'POST',
      '/v1/relay/pairings/pairing-000000000001/confirm',
      {},
      hub.routeToken,
    );
    expect(conf.json).toEqual({ ok: true, clientId: c.clientId, routeId: c.routeId });
    routes = await call(base, 'GET', '/v1/relay/routes', undefined, hub.routeToken);
    expect(routes.json.items[0].status).toBe('active');
  });

  it('refuses a wrong code, burns the slot after 5, and answers expired and reused slots alike', async () => {
    let t = Date.now();
    const { base } = await start({ now: () => t });
    const hub = await registerHub(base);
    const open = (id: string) =>
      call(
        base,
        'POST',
        '/v1/relay/pairings',
        {
          id,
          codeHash: CODE_HASH,
          expiresAt: new Date(t + 10 * 60_000).toISOString(),
          offer: OFFER,
        },
        hub.routeToken,
      );
    expect((await open('pairing-000000000001')).json.expiresAt).toBe(
      new Date(t + 5 * 60_000).toISOString(),
    );
    const wrong = { codeHash: 'w'.repeat(43), blob: BLOB };
    const first = await call(base, 'POST', '/v1/relay/pairings/pairing-000000000001/claim', wrong);
    expect(first.status).toBe(401);
    expect(first.json.error).toMatchObject({ code: 'invalid_code', details: { attemptsLeft: 4 } });
    for (let i = 0; i < 4; i++)
      await call(base, 'POST', '/v1/relay/pairings/pairing-000000000001/claim', wrong);
    const burned = await call(base, 'POST', '/v1/relay/pairings/pairing-000000000001/claim', {
      codeHash: CODE_HASH,
      blob: BLOB,
    });
    expect(burned.status).toBe(410);

    await open('pairing-000000000002');
    t += 5 * 60_000 + 1;
    const expired = await call(base, 'POST', '/v1/relay/pairings/pairing-000000000002/claim', {
      codeHash: CODE_HASH,
      blob: BLOB,
    });
    expect(expired.status).toBe(410);

    await open('pairing-000000000003');
    const good = { codeHash: CODE_HASH, blob: BLOB };
    expect(
      (await call(base, 'POST', '/v1/relay/pairings/pairing-000000000003/claim', good)).status,
    ).toBe(201);
    const reused = await call(base, 'POST', '/v1/relay/pairings/pairing-000000000003/claim', good);
    expect(reused.status).toBe(410);
    expect(reused.json.error.code).toBe('expired');
    const unknown = await call(base, 'POST', '/v1/relay/pairings/pairing-000000000099/claim', good);
    expect(unknown.status).toBe(410);
  });

  it('checks who opens and confirms, and validates bodies', async () => {
    const { base } = await start({ limits: { maxOpenPairingsPerHub: 1 } });
    const hub = await registerHub(base);
    const other = await registerHub(base);
    const body = {
      id: 'pairing-000000000001',
      codeHash: CODE_HASH,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      offer: OFFER,
    };
    expect((await call(base, 'POST', '/v1/relay/pairings', body)).status).toBe(401);
    expect(
      (await call(base, 'POST', '/v1/relay/pairings', { ...body, offer: '!!' }, hub.routeToken))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          base,
          'POST',
          '/v1/relay/pairings',
          { ...body, expiresAt: new Date(0).toISOString() },
          hub.routeToken,
        )
      ).status,
    ).toBe(400);
    expect((await call(base, 'POST', '/v1/relay/pairings', body, hub.routeToken)).status).toBe(201);
    expect((await call(base, 'POST', '/v1/relay/pairings', body, other.routeToken)).status).toBe(
      409,
    );
    expect(
      (
        await call(
          base,
          'POST',
          '/v1/relay/pairings',
          { ...body, id: 'pairing-000000000002' },
          hub.routeToken,
        )
      ).status,
    ).toBe(429);
    const confirm = (token: string) =>
      call(base, 'POST', '/v1/relay/pairings/pairing-000000000001/confirm', {}, token);
    expect((await confirm(other.routeToken)).status).toBe(404);
    expect((await confirm(hub.routeToken)).json.error.details).toEqual({ reason: 'not_claimed' });
    // A generated id when the Hub sends none.
    const other2 = await call(
      base,
      'POST',
      '/v1/relay/pairings',
      { ...body, id: undefined },
      other.routeToken,
    );
    expect(other2.json.pairingId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('re-sends an unconfirmed claim when the Hub reconnects, and expires unconfirmed routes', async () => {
    let t = Date.now();
    const { base, relay } = await start({ now: () => t, sweepIntervalMs: 20 });
    const hub = await registerHub(base);
    const c = await pairClient(base, hub);
    // The Hub was offline: it gets the unconfirmed claim when it connects, and again on the
    // next connect.
    const hubSock = connect(base, hub.routeToken);
    expect((await hubSock.next((e) => e.kind === 'data')).from).toBe(c.routeId);
    hubSock.ws.close();
    await hubSock.closed;
    const again = connect(base, hub.routeToken);
    expect((await again.next((e) => e.kind === 'data')).from).toBe(c.routeId);
    expect(relay.queued(hub.routeId)).toBe(0);
    t += 15 * 60_000;
    await new Promise((r) => setTimeout(r, 60));
    expect(relay.state.routes.has(c.routeId)).toBe(false);
    const conf = await call(
      base,
      'POST',
      '/v1/relay/pairings/pairing-000000000001/confirm',
      {},
      hub.routeToken,
    );
    expect(conf.status).toBe(404);
  });
});

describe('connections and routing', () => {
  it('refuses a bad route token and accepts a good one either way', async () => {
    const { base } = await start();
    const hub = await registerHub(base);
    const bad = connect(base, 'nvr_nope');
    expect(await bad.closed).toEqual({ code: 4001, reason: 'unauthorized' });
    const none = connect(base, '', 'none');
    expect((await none.closed).code).toBe(4001);
    const ok = connect(base, hub.routeToken);
    expect(await ok.opened).toBe(true);
    expect(ok.ws.protocol).toBe(RELAY_SUBPROTOCOL);
  });

  it('routes between a Hub and its confirmed client, both ways, and answers pings', async () => {
    const { base, relay } = await start();
    const hub = await registerHub(base);
    const c = await activeClient(base, hub);
    const h = connect(base, hub.routeToken);
    const cl = connect(base, c.routeToken);
    await Promise.all([h.opened, cl.opened]);
    cl.send(data(hub.routeId, c.routeId, c.clientId));
    expect(await h.next()).toMatchObject({ kind: 'data', from: c.routeId, client: c.clientId });
    h.send({
      v: 1,
      kind: 'ack',
      to: c.routeId,
      from: hub.routeId,
      client: c.clientId,
      stream: 'c1',
      ack: 1,
    });
    expect(await cl.next()).toMatchObject({ kind: 'ack', ack: 1 });
    cl.send({ v: 1, kind: 'ping', to: hub.routeId, from: c.routeId });
    expect(await cl.next()).toEqual({ v: 1, kind: 'pong', to: c.routeId, from: hub.routeId });
    expect(relay.stats().forwarded).toBe(2);
    const routes = await call(base, 'GET', '/v1/relay/routes', undefined, hub.routeToken);
    expect(routes.json.items[0]).toMatchObject({ connected: true });
    expect(routes.json.items[0].lastSeenAt).not.toBeNull();
  });

  it('forwards nothing for a pending client and nothing spoofed', async () => {
    const { base, relay } = await start();
    const hub = await registerHub(base);
    const c = await pairClient(base, hub);
    const h = connect(base, hub.routeToken);
    const cl = connect(base, c.routeToken);
    await Promise.all([h.opened, cl.opened]);
    await h.next((e) => e.kind === 'data'); // the claim
    cl.send(data(hub.routeId, c.routeId, c.clientId));
    h.send(data(c.routeId, hub.routeId, c.clientId));
    // A frame claiming to come from another route is dropped.
    cl.send(data(hub.routeId, 'SOMEONEELSE00000', c.clientId));
    cl.send('{not json');
    cl.ws.send(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.frames).toEqual([]);
    expect(cl.frames).toEqual([]);
    expect(relay.stats().invalid).toBe(3);
  });

  it('answers frames to unknown routes with an unknown_route close frame', async () => {
    const { base } = await start();
    const hub = await registerHub(base);
    const other = await registerHub(base);
    const c = await activeClient(base, hub);
    const h = connect(base, hub.routeToken);
    const cl = connect(base, c.routeToken);
    await Promise.all([h.opened, cl.opened]);
    h.send(data('NOSUCHROUTE00000', hub.routeId, 'x'));
    expect(await h.next()).toEqual({
      v: 1,
      kind: 'close',
      to: hub.routeId,
      from: 'NOSUCHROUTE00000',
      reason: 'unknown_route',
    });
    // The client id must match the route.
    h.send(data(c.routeId, hub.routeId, 'not-the-client'));
    expect((await h.next()).reason).toBe('unknown_route');
    // A client can reach only its own Hub.
    cl.send(data(other.routeId, c.routeId, c.clientId));
    expect(await cl.next()).toMatchObject({
      kind: 'close',
      from: other.routeId,
      reason: 'unknown_route',
    });
    // The connection stays open.
    cl.send(data(hub.routeId, c.routeId, c.clientId));
    expect(await h.next()).toMatchObject({ kind: 'data' });
  });

  it('closes a connection that sends a frame above the size limit', async () => {
    const { base } = await start();
    const hub = await registerHub(base);
    const h = connect(base, hub.routeToken);
    await h.opened;
    h.send('x'.repeat(100 * 1024));
    expect(await h.next()).toMatchObject({ kind: 'close', reason: 'too_large' });
    expect(await h.closed).toEqual({ code: 1009, reason: 'too_large' });
  });

  it('closes idle connections and keeps at most the per-route limit', async () => {
    const { base } = await start({ limits: { idleTimeoutMs: 300, maxConnectionsPerRoute: 2 } });
    const hub = await registerHub(base);
    const a = connect(base, hub.routeToken);
    await a.opened;
    const b = connect(base, hub.routeToken);
    await b.opened;
    const c = connect(base, hub.routeToken);
    await c.opened;
    expect(await a.closed).toEqual({ code: 1000, reason: 'normal' });
    expect(a.frames.at(-1)).toMatchObject({ kind: 'close', reason: 'normal' });
    // Pings keep b alive; c goes idle.
    const keep = setInterval(
      () => b.send({ v: 1, kind: 'ping', to: hub.routeId, from: hub.routeId }),
      100,
    );
    expect(await c.closed).toEqual({ code: 4008, reason: 'idle' });
    expect(c.frames.at(-1)).toMatchObject({ kind: 'close', reason: 'idle' });
    expect(b.ws.readyState).toBe(1);
    clearInterval(keep);
  });
});

describe('revocation', () => {
  it('closes open connections with revoked and refuses reconnects', async () => {
    const { base, relay } = await start();
    const hub = await registerHub(base);
    const other = await registerHub(base);
    const c = await activeClient(base, hub);
    const cl = connect(base, c.routeToken);
    await cl.opened;
    expect(
      (await call(base, 'DELETE', `/v1/relay/routes/${c.routeId}`, undefined, other.routeToken))
        .status,
    ).toBe(404);
    expect(
      (await call(base, 'DELETE', `/v1/relay/routes/${c.routeId}`, undefined, hub.routeToken)).json,
    ).toEqual({
      ok: true,
    });
    expect(await cl.next()).toMatchObject({ kind: 'close', reason: 'revoked' });
    expect(await cl.closed).toEqual({ code: 4003, reason: 'revoked' });
    const again = connect(base, c.routeToken);
    expect(await again.next()).toMatchObject({ kind: 'close', reason: 'revoked', to: c.routeId });
    expect((await again.closed).code).toBe(4003);
    expect(relay.state.routes.has(c.routeId)).toBe(false);
    expect(
      (
        await call(
          base,
          'POST',
          '/v1/relay/push/register',
          { platform: 'fcm', token: 't' },
          c.routeToken,
        )
      ).status,
    ).toBe(401);
    // The Hub's frames to it are now unknown_route.
    const h = connect(base, hub.routeToken);
    await h.opened;
    h.send(data(c.routeId, hub.routeId, c.clientId));
    expect((await h.next()).reason).toBe('unknown_route');
  });

  it('revokes a pending route and its pairing', async () => {
    const { base, relay } = await start();
    const hub = await registerHub(base);
    const c = await pairClient(base, hub);
    expect(
      (await call(base, 'DELETE', `/v1/relay/routes/${c.routeId}`, undefined, hub.routeToken))
        .status,
    ).toBe(200);
    expect(relay.state.pairings.size).toBe(0);
  });
});

describe('the delivery queue', () => {
  it('holds frames for an offline route, bounded in count and age, and delivers them on connect', async () => {
    let t = Date.now();
    const { base, relay } = await start({
      now: () => t,
      limits: { queueMaxFrames: 3, queueMaxAgeMs: 10_000 },
    });
    const hub = await registerHub(base);
    const c = await activeClient(base, hub);
    const h = connect(base, hub.routeToken);
    await h.opened;
    for (let seq = 1; seq <= 5; seq++) h.send(data(c.routeId, hub.routeId, c.clientId, seq));
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.queued(c.routeId)).toBe(3);
    expect(relay.stats().evicted).toBe(2);
    const cl = connect(base, c.routeToken);
    const got = [await cl.next(), await cl.next(), await cl.next()];
    expect(got.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(relay.queued(c.routeId)).toBe(0);
    cl.ws.close();
    await cl.closed;
    h.send(data(c.routeId, hub.routeId, c.clientId, 6));
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.queued(c.routeId)).toBe(1);
    t += 10_001;
    expect(relay.queued(c.routeId)).toBe(0);
  });

  it('bounds the queue in bytes too', async () => {
    const { base, relay } = await start({ limits: { queueMaxBytes: 300 } });
    const hub = await registerHub(base);
    const c = await activeClient(base, hub);
    const h = connect(base, hub.routeToken);
    await h.opened;
    for (let seq = 1; seq <= 5; seq++) h.send(data(c.routeId, hub.routeId, c.clientId, seq));
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.queued(c.routeId)).toBeLessThan(5);
    expect(relay.queued(c.routeId)).toBeGreaterThan(0);
  });

  it('wakes an offline client with a push registration, at most once per interval', async () => {
    const push = new MockPushSender();
    const { base } = await start({ push });
    const hub = await registerHub(base);
    const c = await activeClient(base, hub);
    const reg = await call(
      base,
      'POST',
      '/v1/relay/push/register',
      { platform: 'apns', token: 'device-token', topic: 'ai.nova' },
      c.routeToken,
    );
    expect(reg.status).toBe(201);
    expect(
      (
        await call(
          base,
          'POST',
          '/v1/relay/push/register',
          { platform: 'x', token: 't' },
          c.routeToken,
        )
      ).status,
    ).toBe(400);
    const h = connect(base, hub.routeToken);
    await h.opened;
    h.send(data(c.routeId, hub.routeId, c.clientId, 1));
    h.send(data(c.routeId, hub.routeId, c.clientId, 2));
    await new Promise((r) => setTimeout(r, 100));
    expect(push.sent).toEqual([
      {
        platform: 'apns',
        token: 'device-token',
        topic: 'ai.nova',
        kind: 'wake',
        routeId: c.routeId,
      },
    ]);
  });
});

describe('persistence', () => {
  it('keeps routing registrations across a restart, never pairings or queued frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-relay-'));
    dirs.push(dir);
    const first = await start({ dataDir: dir });
    const hub = await registerHub(first.base);
    const active = await activeClient(first.base, hub, 'pairing-000000000001');
    const revoked = await activeClient(first.base, hub, 'pairing-000000000002');
    await call(
      first.base,
      'DELETE',
      `/v1/relay/routes/${revoked.routeId}`,
      undefined,
      hub.routeToken,
    );
    const pending = await pairClient(first.base, hub, 'pairing-000000000003');
    const h = connect(first.base, hub.routeToken);
    await h.opened;
    h.send(data(active.routeId, hub.routeId, active.clientId, 1));
    await new Promise((r) => setTimeout(r, 50));
    await first.relay.close();
    servers.splice(servers.indexOf(first.relay), 1);

    const file = join(dir, 'relay-state.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(hub.routeToken);
    expect(text).not.toContain('AAAA');
    expect(text).not.toContain(OFFER + '"');

    const second = await start({ dataDir: dir });
    const h2 = connect(second.base, hub.routeToken);
    expect(await h2.opened).toBe(true);
    const a2 = connect(second.base, active.routeToken);
    expect(await a2.opened).toBe(true);
    // The queued frame did not survive.
    await new Promise((r) => setTimeout(r, 50));
    expect(a2.frames).toEqual([]);
    const r2 = connect(second.base, revoked.routeToken);
    expect((await r2.closed).code).toBe(4003);
    const p2 = connect(second.base, pending.routeToken);
    expect((await p2.closed).code).toBe(4001);
    expect(new RelayState({ dataDir: dir }).hubs.size).toBe(1);
  });
});
