// Push area routes and the push path end to end (FR-111, docs/13 §6, docs/22 §3.2): sessions on
// every route; the VAPID key; browser subscriptions tied to the device session that made them,
// without endpoints in views; a test push decrypted as the browser would; and the OS leg reaching
// native apps through a real Relay, which receives only ids, a redacted title and the deep link
// and pushes to the client routes of this Hub that registered a token.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { httpStatusFor, isNovaError, uuidv7 } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { MockPushSender, type RelayServer } from '@nova/relay-service';
import { setupPush, type PushArea } from '../src/push.ts';
import { setupRelay, type RelayArea } from '../src/relay.ts';
import {
  ACCOUNT,
  areaCtx,
  putSetting,
  relayDb,
  startRelay,
  until,
  type AreaCtx,
  type WireJson,
} from './relay-env.ts';
import {
  fakeBrowser,
  type FakeBrowser,
} from '../../../packages/core/test/fixtures/channels/webpush-browser.ts';

const AUTH = { 'x-account': ACCOUNT };

let db: NovaDatabase;
let env: AreaCtx;
let app: FastifyInstance;
let push: PushArea;
let sent: { url: string; body: Buffer }[];

beforeEach(async () => {
  db = await relayDb();
  env = areaCtx(db);
  sent = [];
  push = await setupPush(env.ctx, {
    audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
    fetch: (url, init) => {
      sent.push({ url: String(url), body: init?.body as Buffer });
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });
  app = Fastify({ logger: false });
  // A device session (Add Device) carries its device id on the request's principal.
  app.addHook('onRequest', (req, _reply, done) => {
    const device = req.headers['x-device'];
    if (typeof device === 'string')
      (req as unknown as { principal: unknown }).principal = { deviceId: device, scopes: [] };
    done();
  });
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  push.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await push.close();
  db.close();
});

async function api(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = AUTH,
) {
  const r = await app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, json: (r.body ? JSON.parse(r.body) : null) as WireJson };
}

describe('routes', () => {
  it('needs a session everywhere', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/push/vapid-key'],
      ['GET', '/api/v1/push/subscriptions'],
      ['POST', '/api/v1/push/subscriptions'],
      ['DELETE', `/api/v1/push/subscriptions/${uuidv7()}`],
      ['POST', '/api/v1/push/test'],
    ] as const)
      expect((await api(method, url, method === 'POST' ? {} : undefined, {})).status, url).toBe(
        401,
      );
  });

  it('subscribes a browser for its device, pushes a test it can decrypt, and unsubscribes', async () => {
    const key = (await api('GET', '/api/v1/push/vapid-key')).json.publicKey as string;
    expect(key).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    const browser: FakeBrowser = fakeBrowser('https://fcm.googleapis.com/fcm/send/xyz');
    expect(
      (await api('POST', '/api/v1/push/subscriptions', { endpoint: browser.endpoint })).status,
    ).toBe(400);
    const elsewhere = await api('POST', '/api/v1/push/subscriptions', {
      endpoint: 'https://collector.example/x',
      keys: browser.keys,
    });
    expect(elsewhere).toMatchObject({
      status: 400,
      json: { error: { details: { field: 'endpoint' } } },
    });
    const created = await api(
      'POST',
      '/api/v1/push/subscriptions',
      { endpoint: browser.endpoint, keys: browser.keys, expirationTime: null, label: 'Pixel' },
      { ...AUTH, 'x-device': 'device-1' },
    );
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      deviceId: 'device-1',
      label: 'Pixel',
      endpointOrigin: 'https://fcm.googleapis.com',
    });
    expect(JSON.stringify((await api('GET', '/api/v1/push/subscriptions')).json)).not.toContain(
      'xyz',
    );
    const test = await api('POST', '/api/v1/push/test', {});
    expect(test.json).toMatchObject({ sent: 1, failed: 0 });
    expect(JSON.parse(browser.decrypt(sent[0]!.body).toString())).toMatchObject({
      title: 'Test notification from Nova',
      category: 'system',
    });
    expect(
      (await api('DELETE', `/api/v1/push/subscriptions/${created.json.id as string}`)).json,
    ).toEqual({ ok: true });
    expect((await api('GET', '/api/v1/push/subscriptions')).json.items).toEqual([]);
    expect(await env.ctx.diagnostics.collect()).toMatchObject({ push: { subscriptions: 0 } });
  });
});

describe('review hardening', () => {
  it('drops a device’s subscriptions when the device is revoked anywhere', async () => {
    const phone = fakeBrowser('https://fcm.googleapis.com/fcm/send/phone');
    const laptop = fakeBrowser('https://fcm.googleapis.com/fcm/send/laptop');
    const add = (b: FakeBrowser, device: string) =>
      api(
        'POST',
        '/api/v1/push/subscriptions',
        { endpoint: b.endpoint, keys: b.keys },
        { ...AUTH, 'x-device': device },
      );
    const p = await add(phone, 'dev-phone');
    await add(laptop, 'dev-laptop');
    // Another status change is not a revocation.
    await env.events.emit({
      name: 'device.status.changed',
      accountId: ACCOUNT,
      payload: { deviceId: 'dev-phone', from: 'active', status: 'offline' },
    });
    await env.events.emit({
      name: 'device.status.changed',
      accountId: ACCOUNT,
      payload: { deviceId: 'dev-phone', from: 'active', status: 'revoked' },
    });
    await until(
      async () => (await api('GET', '/api/v1/push/subscriptions')).json.items.length === 1,
    );
    const left = (await api('GET', '/api/v1/push/subscriptions')).json.items as {
      deviceId: string;
    }[];
    expect(left.map((s) => s.deviceId)).toEqual(['dev-laptop']);
    expect(await env.secrets.get(`secret://push/${p.json.id as string}/auth`)).toBeNull();
    expect(env.audit.find((a) => a.action === 'push.subscription.gone')).toMatchObject({
      detail: { reason: 'device_revoked', deviceId: 'dev-phone' },
    });
    // After close the area no longer listens.
    await push.close();
    await env.events.emit({
      name: 'device.status.changed',
      accountId: ACCOUNT,
      payload: { deviceId: 'dev-laptop', from: 'active', status: 'revoked' },
    });
    expect((await api('GET', '/api/v1/push/subscriptions')).json.items).toHaveLength(1);
  });

  it('refuses an expirationTime no date can hold, as a validation error', async () => {
    const b = fakeBrowser('https://fcm.googleapis.com/fcm/send/far');
    const r = await api('POST', '/api/v1/push/subscriptions', {
      endpoint: b.endpoint,
      keys: b.keys,
      expirationTime: 1e300,
    });
    expect(r.status).toBe(400);
    expect(await env.secrets.list('secret://push/')).toEqual([]);
  });
});

describe('native apps through the Relay', () => {
  let relayServer: RelayServer;
  let relayUrl: string;
  let relayArea: RelayArea;
  let recorded: MockPushSender;

  beforeEach(async () => {
    recorded = new MockPushSender();
    ({ relay: relayServer, url: relayUrl } = await startRelay({ push: recorded }));
    putSetting(db, 'relay.url', relayUrl);
    putSetting(db, 'relay.enabled', true);
    relayArea = await setupRelay(env.ctx, {
      kdfIterations: 1_000,
      backoff: { initialMs: 50, maxMs: 200, jitter: 0 },
    });
    await relayArea.hub.reconfigure();
    await until(() => relayArea.status().state === 'connected');
  });

  afterEach(async () => {
    await relayArea.close();
    await relayServer.close();
  });

  /** A paired native client of this Hub with an APNs token at the Relay. */
  function nativeClient(status: 'active' | 'revoked' = 'active', withToken = true) {
    const reg = db.raw
      .prepare("SELECT id, route_id FROM relay_registration WHERE status = 'active'")
      .get() as {
      id: string;
      route_id: string;
    };
    const routeId = `route-${uuidv7().replace(/-/g, '')}`.slice(0, 40);
    const now = new Date().toISOString();
    relayServer.state.addRoute({
      routeId,
      clientId: uuidv7(),
      hubRouteId: reg.route_id,
      tokenHash: 'h',
      status: 'active',
      pairingId: null,
      createdAt: now,
      lastSeenAt: null,
      push: withToken
        ? { platform: 'apns', token: 'ab'.repeat(32), topic: null, registeredAt: now }
        : null,
    });
    db.raw
      .prepare(
        `INSERT INTO relay_client (id, account_id, registration_id, route_id, relay_pairing_id, name,
           platform, kind, public_key, x25519_public_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'p', 'Phone', 'ios', 'native', 'k', 'x', ?, ?, ?)`,
      )
      .run(uuidv7(), ACCOUNT, reg.id, routeId, status, now, now);
    return routeId;
  }

  it('asks the Relay to push ids, a redacted title and the deep link only', async () => {
    const routeId = nativeClient();
    nativeClient('revoked');
    nativeClient('active', false);
    push.useRelay(relayArea.hub);
    const notificationId = uuidv7();
    const runId = uuidv7();
    putSetting(db, 'push.detail', 'titles');
    const out = await push.service.notify({
      accountId: ACCOUNT,
      notificationId,
      kind: 'completion',
      title: 'Your report on “layoffs in Q4” is ready',
      href: `/work/${runId}`,
    });
    expect(out.native).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(recorded.sent).toEqual([
      {
        platform: 'apns',
        token: 'ab'.repeat(32),
        topic: null,
        kind: 'notify',
        routeId,
        notification: {
          id: notificationId,
          category: 'completion',
          title: 'A task finished in a Work run',
          link: `nova://run/${runId}`,
        },
      },
    ]);
    expect(JSON.stringify(recorded.sent)).not.toContain('layoffs');
    // The leg the channels area calls is the same path.
    await push.leg.notify({
      accountId: ACCOUNT,
      notificationId: uuidv7(),
      kind: 'approval',
      title: 'x',
      href: null,
    });
    expect(recorded.sent).toHaveLength(2);
    // Off: nothing leaves.
    putSetting(db, 'push.enabled', false);
    await push.leg.notify({
      accountId: ACCOUNT,
      notificationId: uuidv7(),
      kind: 'approval',
      title: 'x',
      href: null,
    });
    expect(recorded.sent).toHaveLength(2);
  });

  it('sends nothing when the account has no native client', async () => {
    push.useRelay(relayArea.hub);
    const out = await push.service.notify({
      accountId: ACCOUNT,
      notificationId: uuidv7(),
      kind: 'approval',
      title: 'x',
      href: null,
    });
    expect(out.native).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(recorded.sent).toEqual([]);
  });
});
