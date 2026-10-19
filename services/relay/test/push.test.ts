// Push through the Relay (FR-111, FR-137, docs/13 §6, docs/22 §3.2): registration checks token
// shapes; the Hub's notify route pushes only ids, a redacted title and a deep link, only to its
// own active routes with a registration, at most N per route per minute; a token the service
// calls gone is dropped. The real senders run against local fakes: APNs over HTTP/2 (h2c) with
// an ES256 provider token that verifies with the key, FCM HTTP v1 with a service-account RS256
// assertion that verifies with the account's key. Configuration is off unless set.
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createH2Server, type Http2Server } from 'node:http2';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLog } from '../src/log.ts';
import {
  ApnsSender,
  FcmSender,
  MockPushSender,
  PlatformPushSender,
  buildRelayServer,
  pushSenderFromEnv,
  pushTokenProblem,
  type PushMessage,
  type PushOutcome,
  type PushSender,
  type RelayServer,
  type RelayServerOptions,
} from '../src/index.ts';

const servers: RelayServer[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const c of closers.splice(0)) await c().catch(() => undefined);
});

const APNS_TOKEN = 'ab'.repeat(32);
const FCM_TOKEN = `dZ3x${'A'.repeat(40)}:APA91b${'Q_-z'.repeat(30)}`;
const CODE_HASH = 'h'.repeat(43);

async function start(opts: RelayServerOptions = {}) {
  const relay = await buildRelayServer({ log: silentLog, ...opts });
  servers.push(relay);
  return { relay, base: await relay.app.listen({ host: '127.0.0.1', port: 0 }) };
}

type WireJson = Record<string, unknown>;

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

async function hubAndClient(base: string, n = 1) {
  const hub = (await call(base, 'POST', '/v1/relay/hubs')).json as {
    routeId: string;
    routeToken: string;
  };
  const clients: { routeId: string; routeToken: string }[] = [];
  for (let i = 0; i < n; i++) {
    const id = `pairing-00000000000${i}`;
    await call(
      base,
      'POST',
      '/v1/relay/pairings',
      {
        id,
        codeHash: CODE_HASH,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        offer: 'AAAA',
      },
      hub.routeToken,
    );
    const c = (
      await call(base, 'POST', `/v1/relay/pairings/${id}/claim`, {
        codeHash: CODE_HASH,
        blob: 'QkxPQg==',
      })
    ).json as { routeId: string; routeToken: string };
    await call(base, 'POST', `/v1/relay/pairings/${id}/confirm`, {}, hub.routeToken);
    clients.push(c);
  }
  return { hub, clients };
}

const notice = {
  id: '01920000-0000-7000-8000-000000000001',
  category: 'approval' as const,
  title: 'Approval needed',
  link: 'nova://approval/01920000-0000-7000-8000-000000000001',
};

describe('token shapes', () => {
  it('accepts APNs hex tokens and FCM registration tokens, and nothing else', () => {
    expect(pushTokenProblem('apns', APNS_TOKEN)).toBeNull();
    expect(pushTokenProblem('apns', 'device-token')).toMatch(/hex/);
    expect(pushTokenProblem('apns', 'a'.repeat(63))).not.toBeNull();
    expect(pushTokenProblem('fcm', FCM_TOKEN)).toBeNull();
    expect(pushTokenProblem('fcm', 'short')).not.toBeNull();
    expect(pushTokenProblem('fcm', `${'a'.repeat(40)} <script>`)).not.toBeNull();
  });

  it('refuses a malformed token or a topic on an FCM registration at the register route', async () => {
    const { base } = await start();
    const {
      clients: [c],
    } = await hubAndClient(base);
    const reg = (body: unknown) =>
      call(base, 'POST', '/v1/relay/push/register', body, c!.routeToken);
    expect((await reg({ platform: 'apns', token: 'not-hex' })).status).toBe(400);
    expect((await reg({ platform: 'apns', token: APNS_TOKEN, topic: 'bad topic!' })).status).toBe(
      400,
    );
    expect((await reg({ platform: 'fcm', token: FCM_TOKEN, topic: 'ai.nova' })).status).toBe(400);
    expect((await reg({ platform: 'fcm', token: FCM_TOKEN })).status).toBe(201);
    expect((await reg({ platform: 'apns', token: APNS_TOKEN, topic: 'ai.nova.app' })).status).toBe(
      201,
    );
  });
});

describe('the notify route', () => {
  it('pushes ids, a redacted title and a link to the Hub own routes with a registration only', async () => {
    const push = new MockPushSender();
    const { base } = await start({ push });
    const { hub, clients } = await hubAndClient(base, 3);
    const [a, b, unregistered] = clients as [
      { routeId: string; routeToken: string },
      { routeId: string; routeToken: string },
      { routeId: string; routeToken: string },
    ];
    await call(
      base,
      'POST',
      '/v1/relay/push/register',
      { platform: 'apns', token: APNS_TOKEN },
      a.routeToken,
    );
    await call(
      base,
      'POST',
      '/v1/relay/push/register',
      { platform: 'fcm', token: FCM_TOKEN },
      b.routeToken,
    );
    const other = await hubAndClient(base, 1);
    const routes = [a.routeId, b.routeId, unregistered.routeId, other.clients[0]!.routeId];
    // A client token or none is refused.
    expect(
      (await call(base, 'POST', '/v1/relay/push/notify', { routes, notification: notice })).status,
    ).toBe(401);
    expect(
      (
        await call(
          base,
          'POST',
          '/v1/relay/push/notify',
          { routes, notification: notice },
          a.routeToken,
        )
      ).status,
    ).toBe(401);
    const res = await call(
      base,
      'POST',
      '/v1/relay/push/notify',
      { routes, notification: notice },
      hub.routeToken,
    );
    expect(res).toEqual({ status: 200, json: { ok: true, sent: 2, skipped: 2, failed: 0 } });
    expect(push.sent).toEqual([
      {
        platform: 'apns',
        token: APNS_TOKEN,
        topic: null,
        kind: 'notify',
        routeId: a.routeId,
        notification: notice,
      },
      {
        platform: 'fcm',
        token: FCM_TOKEN,
        topic: null,
        kind: 'notify',
        routeId: b.routeId,
        notification: notice,
      },
    ]);
  });

  it('takes nothing but the narrow notice: no body, no long title, no web link, no extra field', async () => {
    const { base } = await start();
    const { hub, clients } = await hubAndClient(base);
    const send = (notification: unknown) =>
      call(
        base,
        'POST',
        '/v1/relay/push/notify',
        { routes: [clients[0]!.routeId], notification },
        hub.routeToken,
      );
    expect((await send({ ...notice, body: 'the private text' })).status).toBe(400);
    expect((await send({ ...notice, title: 'x'.repeat(81) })).status).toBe(400);
    expect((await send({ ...notice, link: 'https://evil.example/x' })).status).toBe(400);
    expect((await send({ ...notice, id: '../../x' })).status).toBe(400);
    expect((await send({ ...notice, link: null })).status).toBe(200);
  });

  it('caps notifications per route per minute', async () => {
    const push = new MockPushSender();
    const { base } = await start({ push, limits: { notifyPerRouteMinute: 2 } });
    const { hub, clients } = await hubAndClient(base);
    await call(
      base,
      'POST',
      '/v1/relay/push/register',
      { platform: 'apns', token: APNS_TOKEN },
      clients[0]!.routeToken,
    );
    const outs = [];
    for (let i = 0; i < 3; i++)
      outs.push(
        (
          await call(
            base,
            'POST',
            '/v1/relay/push/notify',
            { routes: [clients[0]!.routeId], notification: notice },
            hub.routeToken,
          )
        ).json,
      );
    expect(outs.map((o) => o.sent)).toEqual([1, 1, 0]);
    expect(push.sent).toHaveLength(2);
  });

  it('drops a registration the push service calls gone, and counts a failure', async () => {
    const results: PushOutcome[] = [
      { ok: false, detail: 'APNs 500' },
      { ok: false, gone: true },
    ];
    const push: PushSender = {
      name: 'scripted',
      send: () => Promise.resolve(results.shift() ?? { ok: true }),
    };
    const { base, relay } = await start({ push });
    const { hub, clients } = await hubAndClient(base);
    const c = clients[0]!;
    await call(
      base,
      'POST',
      '/v1/relay/push/register',
      { platform: 'apns', token: APNS_TOKEN },
      c.routeToken,
    );
    const notify = () =>
      call(
        base,
        'POST',
        '/v1/relay/push/notify',
        { routes: [c.routeId], notification: notice },
        hub.routeToken,
      );
    expect((await notify()).json).toMatchObject({ sent: 0, failed: 1 });
    expect(relay.state.routes.get(c.routeId)?.push).not.toBeNull();
    expect((await notify()).json).toMatchObject({ sent: 0, failed: 1 });
    expect(relay.state.routes.get(c.routeId)?.push).toBeNull();
    expect((await notify()).json).toMatchObject({ sent: 0, skipped: 1 });
  });
});

// ---- APNs against a local HTTP/2 server -----------------------------------------------------

interface H2Request {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

async function fakeApns(answer: (r: H2Request, n: number) => { status: number; body?: unknown }) {
  const seen: H2Request[] = [];
  const server: Http2Server = createH2Server();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      const req: H2Request = {
        headers: Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
        ),
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      };
      seen.push(req);
      const a = answer(req, seen.length);
      stream.respond({ ':status': a.status, 'content-type': 'application/json' });
      stream.end(a.body ? JSON.stringify(a.body) : '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function jwtParts(token: string) {
  const [h, c, s] = token.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>,
    signed: Buffer.from(`${h}.${c}`),
    sig: Buffer.from(s, 'base64url'),
  };
}

function apnsKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

const wake = (over: Partial<PushMessage> = {}): PushMessage => ({
  platform: 'apns',
  token: APNS_TOKEN,
  topic: null,
  kind: 'wake',
  routeId: 'route-0000000000000001',
  ...over,
});

describe('APNs', () => {
  it('sends a background wake and an alert with an ES256 provider token the key verifies', async () => {
    const key = apnsKey();
    const apns = await fakeApns(() => ({ status: 200 }));
    let now = Date.parse('2026-10-17T12:00:00Z');
    const sender = new ApnsSender({
      keyPem: key.pem,
      keyId: 'ABC123DEFG',
      teamId: 'TEAM123456',
      topics: ['ai.nova.app'],
      origin: apns.origin,
      now: () => now,
    });
    closers.push(() => Promise.resolve(sender.close()));
    expect(await sender.send(wake())).toEqual({ ok: true });
    expect(
      await sender.send(wake({ kind: 'notify', notification: notice, topic: 'ai.nova.app' })),
    ).toEqual({ ok: true });
    const [w, n] = apns.seen as [H2Request, H2Request];
    expect(w.headers[':path']).toBe(`/3/device/${APNS_TOKEN}`);
    expect(w.headers).toMatchObject({
      'apns-topic': 'ai.nova.app',
      'apns-push-type': 'background',
      'apns-priority': '5',
    });
    expect(w.body).toEqual({
      aps: { 'content-available': 1 },
      nova: { kind: 'wake', route: 'route-0000000000000001' },
    });
    expect(n.headers).toMatchObject({
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': notice.id,
    });
    expect(n.body).toEqual({
      aps: {
        alert: { title: 'Approval needed' },
        sound: 'default',
        'thread-id': 'approval',
        'mutable-content': 1,
      },
      nova: {
        kind: 'notify',
        id: notice.id,
        category: 'approval',
        link: notice.link,
        route: 'route-0000000000000001',
      },
    });
    const token = w.headers.authorization!.replace(/^bearer /, '');
    const jwt = jwtParts(token);
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(jwt.claims).toEqual({ iss: 'TEAM123456', iat: Math.floor(now / 1000) });
    expect(
      verify('sha256', jwt.signed, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.sig),
    ).toBe(true);
    // Reused within 40 minutes, replaced after.
    expect(n.headers.authorization).toBe(w.headers.authorization);
    now += 41 * 60_000;
    expect(sender.providerToken()).not.toBe(token);
  });

  it('reports gone tokens, retries an expired provider token once, and refuses other topics', async () => {
    const key = apnsKey();
    const apns = await fakeApns((r, n) =>
      n === 1
        ? { status: 403, body: { reason: 'ExpiredProviderToken' } }
        : r.headers[':path']!.endsWith('dead')
          ? { status: 410, body: { reason: 'Unregistered' } }
          : r.headers[':path']!.endsWith('bad0')
            ? { status: 400, body: { reason: 'BadDeviceToken' } }
            : { status: 200 },
    );
    const sender = new ApnsSender({
      keyPem: key.pem,
      keyId: 'ABC123DEFG',
      teamId: 'TEAM123456',
      topics: ['ai.nova.app'],
      origin: apns.origin,
    });
    closers.push(() => Promise.resolve(sender.close()));
    expect(await sender.send(wake())).toEqual({ ok: true });
    expect(apns.seen).toHaveLength(2);
    expect(await sender.send(wake({ token: `${'ab'.repeat(30)}dead` }))).toMatchObject({
      ok: false,
      gone: true,
    });
    expect(await sender.send(wake({ token: `${'ab'.repeat(30)}bad0` }))).toMatchObject({
      ok: false,
      gone: true,
    });
    expect(await sender.send(wake({ topic: 'com.other.app' }))).toEqual({
      ok: false,
      detail: 'topic not allowed',
    });
    expect(await sender.send(wake({ platform: 'fcm' }))).toMatchObject({ ok: false });
  });

  it('refuses a configuration without ids or topics, or with a key that is not EC', () => {
    const key = apnsKey();
    expect(
      () => new ApnsSender({ keyPem: key.pem, keyId: 'x', teamId: 'TEAM123456', topics: ['a.b'] }),
    ).toThrow();
    expect(
      () =>
        new ApnsSender({ keyPem: key.pem, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topics: [] }),
    ).toThrow();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(
      () =>
        new ApnsSender({ keyPem: rsa, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topics: ['a.b'] }),
    ).toThrow(/EC/);
  });

  it('answers unreachable when there is no server', async () => {
    const key = apnsKey();
    const sender = new ApnsSender({
      keyPem: key.pem,
      keyId: 'ABC123DEFG',
      teamId: 'TEAM123456',
      topics: ['ai.nova.app'],
      origin: 'http://127.0.0.1:1',
      timeoutMs: 2_000,
    });
    expect(await sender.send(wake())).toMatchObject({ ok: false });
    sender.close();
  });
});

// ---- FCM against a local HTTP server ---------------------------------------------------------

async function fakeFcm(
  publicKey: KeyObject,
  answer: (n: number) => { status: number; body?: unknown },
) {
  const seen: { path: string; headers: IncomingMessage['headers']; body: string }[] = [];
  let tokens = 0;
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/token') {
        const form = new URLSearchParams(body);
        const jwt = jwtParts(form.get('assertion') ?? '..');
        const ok =
          form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' &&
          verify('sha256', jwt.signed, publicKey, jwt.sig) &&
          jwt.claims.scope === 'https://www.googleapis.com/auth/firebase.messaging';
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { access_token: `at-${++tokens}`, expires_in: 3600 } : {}));
        return;
      }
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      const a = answer(seen.length);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body ?? { name: 'projects/p/messages/1' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, tokens: () => tokens };
}

describe('FCM', () => {
  const account = () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      publicKey,
      sa: {
        project_id: 'nova-test',
        client_email: 'push@nova-test.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
    };
  };

  it('signs the service-account assertion, sends data and a redacted title, and reuses the token', async () => {
    const { sa, publicKey } = account();
    const fcm = await fakeFcm(publicKey, () => ({ status: 200 }));
    const sender = new FcmSender({
      serviceAccount: sa,
      apiBase: fcm.base,
      tokenUrl: `${fcm.base}/token`,
    });
    expect(await sender.send(wake({ platform: 'fcm', token: FCM_TOKEN }))).toEqual({ ok: true });
    expect(
      await sender.send(
        wake({ platform: 'fcm', token: FCM_TOKEN, kind: 'notify', notification: notice }),
      ),
    ).toEqual({ ok: true });
    expect(fcm.tokens()).toBe(1);
    const [w, n] = fcm.seen as [(typeof fcm.seen)[number], (typeof fcm.seen)[number]];
    expect(w.path).toBe('/v1/projects/nova-test/messages:send');
    expect(w.headers.authorization).toBe('Bearer at-1');
    expect(JSON.parse(w.body)).toEqual({
      message: {
        token: FCM_TOKEN,
        data: { kind: 'wake', route: 'route-0000000000000001' },
        android: { priority: 'high', ttl: '3600s' },
      },
    });
    expect(JSON.parse(n.body)).toEqual({
      message: {
        token: FCM_TOKEN,
        data: {
          kind: 'notify',
          id: notice.id,
          category: 'approval',
          link: notice.link,
          route: 'route-0000000000000001',
        },
        android: { priority: 'high', ttl: '3600s', collapse_key: notice.id },
        notification: { title: 'Approval needed' },
      },
    });
  });

  it('refreshes the token after a 401 and reports an unregistered token as gone', async () => {
    const { sa, publicKey } = account();
    const fcm = await fakeFcm(publicKey, (n) =>
      n === 1
        ? { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }
        : n === 3
          ? { status: 404, body: { error: { status: 'NOT_FOUND' } } }
          : n === 4
            ? { status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } }
            : { status: 200 },
    );
    const sender = new FcmSender({
      serviceAccount: sa,
      apiBase: fcm.base,
      tokenUrl: `${fcm.base}/token`,
    });
    const msg = wake({ platform: 'fcm', token: FCM_TOKEN });
    expect(await sender.send(msg)).toEqual({ ok: true });
    expect(fcm.tokens()).toBe(2);
    expect(await sender.send(msg)).toEqual({ ok: false, gone: true, detail: 'FCM 404 NOT_FOUND' });
    expect(await sender.send(msg)).toEqual({
      ok: false,
      gone: false,
      detail: 'FCM 400 INVALID_ARGUMENT',
    });
    expect(await sender.send(wake())).toMatchObject({ ok: false });
  });

  it('fails a send when the token endpoint refuses, and refuses a non-service-account', async () => {
    const { sa } = account();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const fcm = await fakeFcm(other, () => ({ status: 200 }));
    const sender = new FcmSender({
      serviceAccount: sa,
      apiBase: fcm.base,
      tokenUrl: `${fcm.base}/token`,
    });
    expect(await sender.send(wake({ platform: 'fcm', token: FCM_TOKEN }))).toMatchObject({
      ok: false,
    });
    expect(() => new FcmSender({ serviceAccount: { ...sa, project_id: 'X!' } })).toThrow();
  });
});

describe('configuration', () => {
  it('is the recording mock unless the operator configures a platform', async () => {
    expect(pushSenderFromEnv({}, () => '').configured).toEqual([]);
    expect(pushSenderFromEnv({}, () => '').sender).toBeInstanceOf(MockPushSender);
    const key = apnsKey();
    const files: Record<string, string> = {
      '/k.p8': key.pem,
      '/sa.json': JSON.stringify({
        project_id: 'nova-test',
        client_email: 'a@b.iam.gserviceaccount.com',
        private_key: generateKeyPairSync('rsa', { modulusLength: 1024 })
          .privateKey.export({ type: 'pkcs8', format: 'pem' })
          .toString(),
      }),
    };
    const both = pushSenderFromEnv(
      {
        NOVA_RELAY_APNS_KEY_FILE: '/k.p8',
        NOVA_RELAY_APNS_KEY_ID: 'ABC123DEFG',
        NOVA_RELAY_APNS_TEAM_ID: 'TEAM123456',
        NOVA_RELAY_APNS_TOPICS: 'ai.nova.app, ai.nova.app.beta',
        NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE: '/sa.json',
      },
      (p) => files[p]!,
    );
    expect(both.configured).toEqual(['apns', 'fcm']);
    expect(both.sender.name).toBe('apns+fcm');
    const apnsOnly = pushSenderFromEnv(
      {
        NOVA_RELAY_APNS_KEY_FILE: '/k.p8',
        NOVA_RELAY_APNS_KEY_ID: 'ABC123DEFG',
        NOVA_RELAY_APNS_TEAM_ID: 'TEAM123456',
        NOVA_RELAY_APNS_TOPICS: 'ai.nova.app',
      },
      (p) => files[p]!,
    );
    // An unconfigured platform goes to the mock, never to the real sender of the other.
    expect(await apnsOnly.sender.send(wake({ platform: 'fcm', token: FCM_TOKEN }))).toEqual({
      ok: true,
    });
  });

  it('dispatches by platform', async () => {
    const a = new MockPushSender();
    const f = new MockPushSender();
    const p = new PlatformPushSender({ apns: a, fcm: f });
    await p.send(wake());
    await p.send(wake({ platform: 'fcm' }));
    expect(a.sent).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    const silent: PushSender = { name: 'void', send: () => Promise.resolve() };
    expect(await new PlatformPushSender({ apns: silent }).send(wake())).toEqual({ ok: true });
  });
});
