// The Hub and a real Relay service on loopback (FR-137, FR-132; docs/22 §3, §4, §9). Part one runs
// the real Add Device service: the owner starts a Relay pairing, a client claims it with the code
// from the QR payload, both screens show the same confirmation, the owner approves, the client
// polls its status through the tunnel (signed with its device key) and gets its device session,
// then calls the Hub API with it; without a valid token the tunneled request gets 401 like a direct
// one; revoking the client revokes the device. Part two runs the fully wired Hub (app.ts), paired
// through its own Add Device: tunneled API calls, the event stream through the tunnel, and a Relay
// killed and restarted with both sides reconnecting and the interrupted request resuming.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { httpStatusFor, isNovaError } from '@nova/shared';
import { NodeService } from '@nova/core';
import { MockProvider } from '@nova/providers';
import {
  RelayClient,
  generateEd25519,
  pairWithRelay,
  toBase64Url,
  type PairedClient,
} from '@nova/relay';
import type { RelayServer } from '@nova/relay-service';
import { MemorySecretStore } from '@nova/secrets';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, requireAuth, type Hub } from '../src/app.ts';
import { setupAddDevice, type AddDeviceArea } from '../src/add-device.ts';
import { AuthService } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupRelay, type RelayArea } from '../src/relay.ts';
import { ACCOUNT, dbSettings, relayDb, startRelay, until, type WireJson } from './relay-env.ts';

const ITER = 1_000;
const FAST = { backoff: { initialMs: 50, maxMs: 200, jitter: 0 }, retransmitMs: 300 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function relayClient(paired: PairedClient): RelayClient {
  const c = new RelayClient({ paired, ...FAST, requestTimeoutMs: 20_000 });
  cleanups.push(() => c.stop());
  c.start();
  return c;
}

async function relayService(opts: Parameters<typeof startRelay>[0] = {}) {
  const r = await startRelay(opts);
  const holder: { relay: RelayServer; url: string; port: number } = {
    relay: r.relay,
    url: r.url,
    port: r.port,
  };
  cleanups.push(() => holder.relay.close());
  return holder;
}

async function sign(
  key: Awaited<ReturnType<typeof generateEd25519>>,
  text: string,
): Promise<string> {
  return toBase64Url(await key.sign(new TextEncoder().encode(text)));
}

describe('with the real Add Device service', () => {
  async function composed() {
    const db = await relayDb();
    cleanups.push(() => db.close());
    const secrets = new MemorySecretStore();
    const events = new EventStore(db);
    const log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
    const auth = new AuthService(db);
    const nodes = new NodeService({ db, secrets, events, log });
    const ctx = {
      config: { host: '127.0.0.1', port: 7419, tls: null, allowedOrigins: [] },
      db,
      log,
      events,
      secrets,
      dataDir: '/nonexistent',
      registry: {} as never,
      router: {} as never,
      nodes,
      threads: {} as never,
      setting: dbSettings(db),
      accountOf: (req: FastifyRequest) => {
        const p = requireAuth(req);
        return Promise.resolve(p.accountId ?? ACCOUNT);
      },
      diagnostics: new DiagnosticsRegistry(),
    } as unknown as HubContext;
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    app.decorateRequest('principal', null);
    // The Hub's own authentication (app.ts): a bearer token or the session cookie.
    app.addHook('onRequest', async (req) => {
      const h = req.headers.authorization;
      const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : req.cookies[SESSION_COOKIE];
      req.principal = token ? await auth.verify(token) : null;
    });
    app.setErrorHandler((err, req, reply) => {
      if (isNovaError(err))
        return reply
          .status(httpStatusFor(err.code))
          .send({ error: err.toJSON(), requestId: req.id });
      if (err instanceof z.ZodError)
        return reply.status(400).send({ error: { code: 'validation' } });
      return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
    });
    const addDevice: AddDeviceArea = await setupAddDevice(ctx, { sessionCookie: SESSION_COOKIE });
    const relayArea: RelayArea = await setupRelay(ctx, { app, kdfIterations: ITER, ...FAST });
    // The wiring app.ts gets (reported to the lead).
    addDevice.useRelayPairing((input) => relayArea.openPairing(input));
    relayArea.usePairing(addDevice.service);
    relayArea.onClientRevoked((accountId, deviceId) =>
      addDevice.revoker.revoke(accountId, deviceId),
    );
    addDevice.register(app);
    relayArea.register(app);
    cleanups.push(async () => {
      await app.close();
      await relayArea.close();
      await addDevice.close();
    });
    await app.ready();
    const code = await auth.issueSetupCode();
    const { session } = await auth.redeemSetupCode(code);
    const owner = { authorization: `Bearer ${session}` };
    const api = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
      const r = await app.inject({
        method,
        url,
        headers: owner,
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
      return { status: r.statusCode, json: r.json<WireJson>() };
    };
    return { db, app, api, relayArea, addDevice };
  }

  it('pairs a phone through the Relay end to end and serves it the Hub API', async () => {
    const { relay, url } = await relayService();
    const { api, relayArea } = await composed();
    expect((await api('PATCH', '/api/v1/relay', { enabled: true, url })).status).toBe(200);
    await until(() => relayArea.status().state === 'connected');

    // The owner starts Add Device over the Relay; the QR payload carries the Relay's coordinates.
    const start = await api('POST', '/api/v1/devices/add/start', {
      role: 'client',
      transport: 'relay',
    });
    expect(start.status, JSON.stringify(start.json)).toBe(201);
    expect(start.json.relay).toEqual({ relayUrl: url, relayPairingId: expect.any(String) });
    // The Relay never saw the code.
    const slot = relay.state.pairings.get(start.json.relay.relayPairingId)!;
    expect(JSON.stringify(slot)).not.toContain(start.json.code.replace('-', ''));

    // The phone: its own device key, the code from the QR, the Relay from the payload.
    const device = await generateEd25519();
    const out = await pairWithRelay({
      relayUrl: start.json.relay.relayUrl,
      relayPairingId: start.json.relay.relayPairingId,
      code: start.json.code,
      device,
      name: 'Ada’s phone',
      platform: 'ios',
      kind: 'browser',
      kdfIterations: ITER,
    });
    expect(out.addPairingId).toBe(start.json.pairingId);
    const phone = relayClient(out.paired);

    // The owner sees the request with the same confirmation the phone shows, and approves it.
    const pending = await until(async () => {
      const r = await api('GET', '/api/v1/devices/add/requests');
      return r.json.items?.[0] as { id: string; confirmation: string } | undefined;
    });
    expect(pending.confirmation).toBe(out.confirmation);
    expect((await api('GET', '/api/v1/relay/clients')).json.items[0]).toMatchObject({
      status: 'pending',
    });
    const approved = await api('POST', `/api/v1/devices/add/requests/${pending.id}/approve`, {
      confirmation: out.confirmation,
    });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    const notice = await phone.waitForPaired();
    expect(notice.requestId).toBe(pending.id);
    const client = (await api('GET', '/api/v1/relay/clients')).json.items[0];
    expect(client).toMatchObject({
      status: 'active',
      deviceId: notice.deviceId,
      name: 'Ada’s phone',
    });

    // The phone polls its status through the tunnel, signed with its device key.
    const time = Math.floor(Date.now() / 1000);
    const status = await phone.fetch(`/api/v1/devices/add/status/${pending.id}`, {
      headers: {
        'x-nova-device-time': String(time),
        'x-nova-device-signature': await sign(
          device,
          `nova-add-device-status-v1.${pending.id}.${time}`,
        ),
      },
    });
    expect(status.status).toBe(200);
    expect(status.headers.get('set-cookie')).toBeNull();
    const body = (await status.json()) as {
      status: string;
      grant: { type: string; token: string };
    };
    expect(body).toMatchObject({ status: 'approved', grant: { type: 'session' } });
    const token = body.grant.token;

    // Its device session works through the tunnel exactly like a direct request…
    const devices = await phone.fetch('/api/v1/devices/all', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(devices.status).toBe(200);
    expect(
      ((await devices.json()) as { items: { id: string }[] }).items.map((d) => d.id),
    ).toContain(notice.deviceId);
    // …and without a valid token the tunneled request gets 401 like a direct one.
    const anon = await phone.fetch('/api/v1/devices/all');
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe('token_required');
    const routeToken = await phone.fetch('/api/v1/devices/all', {
      headers: { authorization: `Bearer ${out.paired.routeToken}` },
    });
    expect(routeToken.status).toBe(401);

    // Revoking the paired client revokes the device: its session is gone, its key blocked.
    const r = await api('POST', `/api/v1/relay/clients/${client.id}/revoke`);
    expect(r.json.client.status).toBe('revoked');
    await until(() => phone.state === 'revoked');
    const all = (await api('GET', '/api/v1/devices/all')).json.items as {
      id: string;
      status: string;
    }[];
    expect(all.find((d) => d.id === notice.deviceId)?.status).toBe('revoked');
  });

  it('refuses a claim with a revoked device key and lets the owner deny', async () => {
    const { relay, url } = await relayService();
    const { api, relayArea } = await composed();
    await api('PATCH', '/api/v1/relay', { enabled: true, url });
    await until(() => relayArea.status().state === 'connected');
    const start = await api('POST', '/api/v1/devices/add/start', {
      role: 'client',
      transport: 'relay',
    });
    const device = await generateEd25519();
    const out = await pairWithRelay({
      relayUrl: url,
      relayPairingId: start.json.relay.relayPairingId,
      code: start.json.code,
      device,
      name: 'Tablet',
      platform: 'android',
      kdfIterations: ITER,
    });
    const tablet = relayClient(out.paired);
    const pending = await until(
      async () => (await api('GET', '/api/v1/devices/add/requests')).json.items?.[0],
    );
    expect((await api('POST', `/api/v1/devices/add/requests/${pending.id}/deny`)).status).toBe(200);
    await until(() => tablet.state === 'revoked');
    expect(relay.state.routes.has(out.paired.clientRoute)).toBe(false);
    expect((await api('GET', '/api/v1/relay/clients')).json.items[0].status).toBe('denied');
  });
});

describe('with the fully wired Hub', () => {
  // app.ts wires the Relay to the real Add Device area: pairing over the Relay is the owner's
  // Add Device with `transport: relay`, approved with the code both screens show.
  async function wiredHub() {
    const dir = mkdtempSync(join(tmpdir(), 'nova-hub-relay-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = loadConfig(
      { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
      [],
    );
    const db = await relayDb();
    cleanups.push(() => db.close());
    db.raw.prepare('DELETE FROM account').run();
    const secrets = new MemorySecretStore();
    const log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
    const mock = new MockProvider({ id: 'mock', timing: 'instant' });
    const hub: Hub = await buildHub({
      config,
      db,
      log,
      secrets,
      providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
      chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
      relay: { kdfIterations: ITER, ...FAST },
    });
    cleanups.push(() => hub.app.close());
    const code = await hub.auth.issueSetupCode();
    const setup = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { host: '127.0.0.1:7419' },
      payload: { code, displayName: 'Owner' },
    });
    const session = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const accountId = setup.json<{ accountId: string }>().accountId;
    const headers = { host: '127.0.0.1:7419', authorization: `Bearer ${session}` };
    const api = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
      const r = await hub.app.inject({
        method,
        url,
        headers,
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
      return { status: r.statusCode, json: r.json<WireJson>() };
    };
    return { hub, api, relayArea: hub.relay, accountId };
  }

  async function pairAndApprove(w: Awaited<ReturnType<typeof wiredHub>>, url: string) {
    const start = await w.api('POST', '/api/v1/devices/add/start', {
      role: 'client',
      transport: 'relay',
    });
    expect(start.status, JSON.stringify(start.json)).toBe(201);
    expect(start.json.relay.relayUrl).toBe(url);
    const device = await generateEd25519();
    const out = await pairWithRelay({
      relayUrl: start.json.relay.relayUrl,
      relayPairingId: start.json.relay.relayPairingId,
      code: start.json.code,
      device,
      name: 'Laptop',
      platform: 'linux',
      kind: 'browser',
      kdfIterations: ITER,
    });
    const client = relayClient(out.paired);
    const pending = await until(async () => {
      const r = await w.api('GET', '/api/v1/devices/add/requests');
      return r.json.items?.[0] as { id: string; confirmation: string } | undefined;
    });
    expect(pending.confirmation).toBe(out.confirmation);
    const approved = await w.api('POST', `/api/v1/devices/add/requests/${pending.id}/approve`, {
      confirmation: out.confirmation,
    });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    await client.waitForPaired();
    const time = Math.floor(Date.now() / 1000);
    const status = await client.fetch(`/api/v1/devices/add/status/${pending.id}`, {
      headers: {
        'x-nova-device-time': String(time),
        'x-nova-device-signature': await sign(
          device,
          `nova-add-device-status-v1.${pending.id}.${time}`,
        ),
      },
    });
    const body = (await status.json()) as { grant: { token: string } };
    return { client, token: body.grant.token, out };
  }

  it('serves the Hub API and the event stream through the tunnel', async () => {
    const { url } = await relayService();
    const w = await wiredHub();
    expect((await w.api('PATCH', '/api/v1/relay', { enabled: true, url })).status).toBe(200);
    await until(() => w.relayArea.status().state === 'connected');
    // Connecting re-runs the endpoint checks: the Relay is advertised at once, not at the next
    // scheduled check, and its health is the connector's (an http:// Relay is not probed as a Hub).
    await until(() => w.hub.network.endpoints().some((c) => c.transport === 'relay'));
    const { client, token } = await pairAndApprove(w, url);
    const auth = { authorization: `Bearer ${token}` };

    const session = await client.fetch('/api/v1/session', { headers: auth });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ accountId: w.accountId, kind: 'session' });
    const anon = await client.fetch('/api/v1/session');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: { code: 'token_required' } });
    // A body goes through too: create a thread and read it back.
    const created = await client.fetch('/api/v1/threads', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'From the road' }),
    });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as { id: string };
    const read = await client.fetch(`/api/v1/threads/${thread.id}`, { headers: auth });
    expect(((await read.json()) as { thread: { title: string } }).thread.title).toBe(
      'From the road',
    );

    // The event stream (SSE) flows as events happen.
    const stream = await client.fetch('/api/v1/events/stream', { headers: auth });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain(': connected');
    await w.hub.events.emit({ name: 'relay.test.ping', accountId: w.accountId, payload: { n: 1 } });
    while (!text.includes('relay.test.ping')) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('"n":1');
    await reader.cancel();
  });

  it('reconnects both sides after the Relay restarts and resumes an interrupted request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-relay-data-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const svc = await relayService({ dataDir: dir });
    const w = await wiredHub();
    await w.api('PATCH', '/api/v1/relay', { enabled: true, url: svc.url });
    await until(() => w.relayArea.status().state === 'connected');
    const { client, token } = await pairAndApprove(w, svc.url);
    const auth = { authorization: `Bearer ${token}` };
    expect((await client.fetch('/api/v1/session', { headers: auth })).status).toBe(200);

    // Kill the Relay: both sides lose it.
    await svc.relay.close();
    await until(() => w.relayArea.status().state === 'connecting' && client.state !== 'open');
    // A request made while the Relay is down waits in the client's session…
    const during = client.fetch('/api/v1/session', { headers: auth });
    // …and after the Relay comes back (same address, same registrations) both reconnect and it
    // completes.
    const again = await startRelay({ dataDir: dir, port: svc.port });
    svc.relay = again.relay;
    await until(() => w.relayArea.status().state === 'connected' && client.state === 'open');
    const res = await during;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accountId: w.accountId });
    expect(again.relay.state.hubs.size).toBe(1);
  });
});
