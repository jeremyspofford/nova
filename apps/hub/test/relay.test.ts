// Relay area routes and connector (FR-137; docs/22 §3; contracts/hub-api.md §1): sessions on every
// route, settings with validation and managed locks, registration (the route token and X25519 key in
// the vault, only references in the database), reachability test, pairing through a real Relay
// service with a stub Add Device seam (claim, approve, deny), the paired-client list and revoke
// (audited, evented, cascading to the device), dropped-and-logged envelopes from revoked clients,
// and the endpoint source.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RELAY_HOSTED_URL, httpStatusFor, isNovaError } from '@nova/shared';
import { pairingCodeHash, pairingConfirmation, type RelayPairingSeam } from '@nova/core';
import {
  RelayClient,
  generateEd25519,
  keyFingerprint,
  pairWithRelay,
  type PairWithRelayResult,
} from '@nova/relay';
import type { NovaDatabase } from '@nova/storage';
import type { RelayServer } from '@nova/relay-service';
import {
  injectDispatch,
  setupRelay,
  tunnelUrl,
  type RelayArea,
  type RelayDeps,
} from '../src/relay.ts';
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

const AUTH = { 'x-account': ACCOUNT };
const ITER = 1_000;

class StubPairing implements RelayPairingSeam {
  claims: Parameters<RelayPairingSeam['requestFromRelay']>[0][] = [];
  listeners = new Set<Parameters<RelayPairingSeam['onDecided']>[0]>();
  refuse: string | null = null;
  requestFromRelay(claim: Parameters<RelayPairingSeam['requestFromRelay']>[0]) {
    if (this.refuse) return Promise.reject(new Error(this.refuse));
    this.claims.push(claim);
    return Promise.resolve({
      requestId: `req-${this.claims.length}`,
      confirmation: pairingConfirmation({
        hubFingerprint: '',
        pairingId: claim.pairingId,
        publicKey: claim.publicKey,
        code: claim.code ?? '',
      }),
    });
  }
  onDecided(listener: Parameters<RelayPairingSeam['onDecided']>[0]) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async decide(i: number, decision: 'approved' | 'denied' | 'expired', deviceId: string | null) {
    const c = this.claims[i]!;
    for (const fn of this.listeners)
      await fn({
        accountId: ACCOUNT,
        requestId: `req-${i + 1}`,
        decision,
        deviceId,
        relayClientId: c.relayClientId,
      });
  }
}

let db: NovaDatabase;
let env: AreaCtx;
let app: FastifyInstance;
let area: RelayArea;
let relay: RelayServer;
let relayUrl: string;
let stub: StubPairing;
const clients: RelayClient[] = [];

async function build(deps: Partial<RelayDeps> = {}) {
  area = await setupRelay(env.ctx, {
    audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
    kdfIterations: ITER,
    backoff: { initialMs: 50, maxMs: 200, jitter: 0 },
    ...deps,
  });
  stub = new StubPairing();
  area.usePairing(stub);
  app = Fastify({ logger: false });
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  // A protected route standing in for the Hub API: the tunnel's inner token must authenticate.
  app.get('/api/v1/echo', (req, reply) => {
    if (req.headers.authorization !== 'Bearer good')
      return reply.status(401).send({ error: { code: 'token_required' } });
    return { ok: true, host: req.headers.host, ip: req.ip, origin: req.headers.origin ?? null };
  });
  area.useInject(app);
  await app.ready();
}

const api = async (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  headers = AUTH,
) => {
  const r = await app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, json: r.json<WireJson>() };
};

async function enable() {
  const r = await api('PATCH', '/api/v1/relay', { enabled: true, url: relayUrl });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await until(() => area.status().state === 'connected');
}

async function pairClient(
  code = 'ABCD-EFGH',
  pin?: string,
): Promise<PairWithRelayResult & { device: Awaited<ReturnType<typeof generateEd25519>> }> {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const slot = await area.openPairing({
    accountId: ACCOUNT,
    pairingId: `add-${stub.claims.length + 1}`,
    expiresAt,
    code,
  });
  expect(slot.relayUrl).toBe(relayUrl);
  const device = await generateEd25519();
  const out = await pairWithRelay({
    relayUrl: slot.relayUrl,
    relayPairingId: slot.relayPairingId,
    code: code.toLowerCase(),
    device,
    name: 'Phone',
    platform: 'ios',
    kdfIterations: ITER,
    ...(pin ? { pin } : {}),
  });
  return { ...out, device };
}

function client(paired: PairWithRelayResult['paired']): RelayClient {
  const c = new RelayClient({
    paired,
    backoff: { initialMs: 50, maxMs: 200, jitter: 0 },
    retransmitMs: 300,
  });
  clients.push(c);
  c.start();
  return c;
}

beforeEach(async () => {
  db = await relayDb();
  env = areaCtx(db);
  ({ relay, url: relayUrl } = await startRelay());
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await app?.close();
  await area?.close();
  await relay.close();
  db.close();
});

describe('routes', () => {
  it('needs a session on every route', async () => {
    await build();
    for (const [method, url] of [
      ['GET', '/api/v1/relay'],
      ['PATCH', '/api/v1/relay'],
      ['POST', '/api/v1/relay/test'],
      ['GET', '/api/v1/relay/clients'],
      ['POST', '/api/v1/relay/clients/x/revoke'],
    ] as const) {
      const r = await api(method, url, method === 'GET' ? undefined : {}, {} as typeof AUTH);
      expect(r.status, `${method} ${url}`).toBe(401);
    }
  });

  it('starts off, validates changes and honours managed policy', async () => {
    await build();
    const r = await api('GET', '/api/v1/relay');
    expect(r.json).toMatchObject({
      enabled: false,
      url: '',
      selfHosted: true,
      effectiveUrl: '',
      status: { state: 'disabled' },
      clients: { active: 0, pending: 0 },
    });
    for (const bad of [
      { url: 'ftp://relay.example' },
      { url: 'http://relay.example' },
      { url: 'ws://192.168.1.5:7430' },
      { url: 'https://user:pw@relay.example' },
      { url: 'https://relay.example/?token=x' },
      { enabled: 'yes' },
      { other: 1 },
    ])
      expect((await api('PATCH', '/api/v1/relay', bad)).status, JSON.stringify(bad)).toBe(400);
    const hosted = await api('PATCH', '/api/v1/relay', { selfHosted: false });
    expect(hosted.json.effectiveUrl).toBe(RELAY_HOSTED_URL);
    // Nothing contacts the hosted Relay while the Relay is off.
    expect(hosted.json.status.state).toBe('disabled');
    env.managed['relay.enabled'] = false;
    const locked = await api('PATCH', '/api/v1/relay', { enabled: true });
    expect(locked.status).toBe(403);
    expect(locked.json.error.code).toBe('policy_denied');
    expect((await api('GET', '/api/v1/relay')).json.enabled).toBe(false);
    expect(env.audit.map((a) => a.action)).toEqual(['relay.change']);
  });

  it('registers and connects when enabled, keeping secrets in the vault', async () => {
    await build();
    const statuses: unknown[] = [];
    env.events.bus.subscribe('relay.status.changed', (e) => statuses.push(e.payload.state));
    await enable();
    expect(relay.state.hubs.size).toBe(1);
    const reg = db.raw.prepare('SELECT * FROM relay_registration').get() as {
      token_ref: string;
      x25519_key_ref: string;
      route_id: string;
    };
    expect(reg.token_ref).toMatch(/^secret:\/\/relay\/.+\/route-token$/);
    expect(reg.x25519_key_ref).toMatch(/^secret:\/\/relay\/.+\/x25519$/);
    const token = await env.secrets.get(reg.token_ref);
    expect(token).toMatch(/^nvr_/);
    expect(JSON.stringify(reg)).not.toContain(token!);
    expect(statuses).toEqual(['registering', 'connecting', 'connected']);
    const audit = env.audit.find((a) => a.action === 'relay.change')!;
    expect(audit).toMatchObject({
      kind: 'network',
      detail: { changed: { enabled: { from: false, to: true } } },
    });
    const view = await api('GET', '/api/v1/relay');
    expect(view.json.status).toMatchObject({
      state: 'connected',
      url: relayUrl,
      routeId: reg.route_id,
    });
    expect(await env.ctx.diagnostics.collect()).toMatchObject({ relay: { state: 'connected' } });
    // The endpoint source reports the Relay with the connector's health.
    expect(await area.endpointSource.list()).toEqual([
      expect.objectContaining({ transport: 'relay', url: relayUrl, health: 'ok' }),
    ]);
    // Turning it off disconnects; the registration stays for next time.
    await api('PATCH', '/api/v1/relay', { enabled: false });
    expect(area.status().state).toBe('disabled');
    await until(() => relay.stats().connections === 0);
    expect(await area.endpointSource.list()).toEqual([]);
    await api('PATCH', '/api/v1/relay', { enabled: true });
    await until(() => area.status().state === 'connected');
    expect(relay.state.hubs.size).toBe(1);
  });

  it('applies relay settings changed through the generic settings route', async () => {
    await build();
    putSetting(db, 'relay.url', relayUrl);
    putSetting(db, 'relay.enabled', true);
    await env.events.emit({
      name: 'settings.changed',
      payload: { key: 'relay.enabled', scope: 'global' },
    });
    await until(() => area.status().state === 'connected');
  });

  it('registers again at a new URL and retires the old registration', async () => {
    await build();
    await enable();
    const second = await startRelay();
    try {
      await api('PATCH', '/api/v1/relay', { url: second.url });
      await until(() => area.status().state === 'connected' && area.status().url === second.url);
      const rows = db.raw
        .prepare('SELECT url, status FROM relay_registration ORDER BY created_at')
        .all();
      expect(rows).toEqual([
        { url: relayUrl, status: 'retired' },
        { url: second.url, status: 'active' },
      ]);
    } finally {
      await second.relay.close();
    }
  });

  it('reports a Relay that forgot the Hub, and registers again when toggled', async () => {
    await build();
    await enable();
    // With a paired client the owner decides (the client must pair again).
    const out = await pairClient();
    await until(() => stub.claims.length === 1);
    await stub.decide(0, 'approved', 'dev-1');
    void out;
    // A Relay without a data folder loses its registrations on restart.
    const port = Number(new URL(relayUrl).port);
    await relay.close();
    ({ relay } = await startRelay({ port }));
    await until(() => area.status().state === 'error');
    expect(area.status().detail).toContain('no longer knows this Hub');
    await api('PATCH', '/api/v1/relay', { enabled: false });
    await api('PATCH', '/api/v1/relay', { enabled: true });
    await until(() => area.status().state === 'connected');
    expect(relay.state.hubs.size).toBe(1);
  });

  it('says why it cannot register', async () => {
    await relay.close();
    ({ relay, url: relayUrl } = await startRelay({ registrationToken: 'private' }));
    await build();
    await api('PATCH', '/api/v1/relay', { enabled: true, url: relayUrl });
    await until(() => area.status().state === 'error');
    expect(area.status().detail).toContain('registration token');
    await api('PATCH', '/api/v1/relay', { url: '' });
    expect(area.status().state).toBe('unconfigured');
  });

  it('tests reachability', async () => {
    await build();
    expect((await api('POST', '/api/v1/relay/test')).json).toMatchObject({
      ok: false,
      detail: 'no Relay URL is set',
    });
    await enable();
    const ok = await api('POST', '/api/v1/relay/test');
    expect(ok.json).toMatchObject({
      ok: true,
      reachable: true,
      url: relayUrl,
      state: 'connected',
      version: '0.0.0',
    });
    await api('PATCH', '/api/v1/relay', { url: 'http://127.0.0.1:9' });
    const bad = await api('POST', '/api/v1/relay/test');
    expect(bad.json).toMatchObject({ ok: false, reachable: false });
  });
});

describe('pairing and paired clients', () => {
  it('refuses a pairing slot while the Relay is not set up', async () => {
    await build();
    await expect(
      area.openPairing({
        accountId: ACCOUNT,
        pairingId: 'add-1',
        expiresAt: new Date().toISOString(),
        code: 'ABCD-EFGH',
      }),
    ).rejects.toMatchObject({ code: 'capability_missing' });
  });

  it('pairs a client: claim, owner approval, then tunneled requests with the inner token', async () => {
    await build();
    const identity = await generateEd25519();
    area.useHubIdentity(() => ({
      fingerprint: '',
      publicKey: identity.publicKey,
      sign: (b) => identity.sign(b),
    }));
    await enable();
    const pin = await keyFingerprint(identity.publicKey);
    const out = await pairClient('ABCD-EFGH', pin);
    expect(out.hubFingerprint).toBe(pin);
    await until(() => stub.claims.length === 1);
    expect(stub.claims[0]).toEqual({
      pairingId: 'add-1',
      codeHashCheck: pairingCodeHash('add-1', 'ABCDEFGH'),
      code: 'ABCDEFGH',
      publicKey: out.device.publicKey,
      name: 'Phone',
      platform: 'ios',
      relayClientId: out.paired.clientId,
      kind: 'browser',
    });
    // Both screens show the same confirmation (the client's own computation, the Add Device service's).
    expect(out.confirmation).toBe(
      pairingConfirmation({
        hubFingerprint: pin,
        pairingId: 'add-1',
        publicKey: out.device.publicKey,
        code: 'ABCDEFGH',
      }),
    );
    let list = await api('GET', '/api/v1/relay/clients');
    expect(list.json.items).toEqual([
      expect.objectContaining({
        id: out.paired.clientId,
        status: 'pending',
        name: 'Phone',
        platform: 'ios',
        requestId: 'req-1',
      }),
    ]);
    const c = client(out.paired);
    const paired = c.waitForPaired();
    const events: string[] = [];
    env.events.bus.subscribe('relay.client.*', (e) => events.push(e.name));
    await stub.decide(0, 'approved', 'dev-1');
    expect(await paired).toEqual({ requestId: 'req-1', deviceId: 'dev-1' });
    list = await api('GET', '/api/v1/relay/clients');
    expect(list.json.items[0]).toMatchObject({ status: 'active', deviceId: 'dev-1' });
    expect(events).toEqual(['relay.client.paired']);
    expect(env.audit.find((a) => a.action === 'relay.pair')).toMatchObject({
      kind: 'network',
      resource: out.paired.clientId,
      decision: 'approved',
    });
    // The inner Authorization header authenticates, never the route token.
    const ok = await c.fetch('/api/v1/echo', {
      headers: { authorization: 'Bearer good', origin: 'https://evil.example' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      host: 'localhost',
      ip: `relay:${out.paired.clientId}`,
      origin: null,
    });
    expect((await c.fetch('/api/v1/echo')).status).toBe(401);
    expect(
      (
        await c.fetch('/api/v1/echo', {
          headers: { authorization: `Bearer ${out.paired.routeToken}` },
        })
      ).status,
    ).toBe(401);
    // Only the API is reachable through the tunnel.
    expect((await c.fetch('/agent/v1/heartbeat', { method: 'POST' })).status).toBe(404);
    expect((await c.fetch('/api/v1/ws')).status).toBe(400);
    expect((await api('GET', '/api/v1/relay')).json.clients).toEqual({ active: 1, pending: 0 });
  });

  it('drops a client the owner denies, and one Add Device refuses', async () => {
    await build();
    await enable();
    const out = await pairClient();
    const c = client(out.paired);
    await until(() => stub.claims.length === 1);
    await stub.decide(0, 'denied', null);
    await until(() => c.state === 'revoked');
    expect((await api('GET', '/api/v1/relay/clients')).json.items[0].status).toBe('denied');
    expect(env.audit.find((a) => a.action === 'relay.pair')).toMatchObject({ decision: 'denied' });
    expect(relay.state.routes.has(out.paired.clientRoute)).toBe(false);

    stub.refuse = 'this code has expired';
    const second = await pairClient('WXYZ-2345');
    await until(async () => (await api('GET', '/api/v1/relay/clients')).json.items.length === 2);
    await until(() => !relay.state.routes.has(second.paired.clientRoute));
  });

  it('revokes a client: the Relay closes it, the device is revoked, its key stays refused', async () => {
    await build();
    const revokedDevices: string[] = [];
    area.onClientRevoked((_a, deviceId) => {
      revokedDevices.push(deviceId);
    });
    await enable();
    const out = await pairClient();
    const c = client(out.paired);
    await until(() => stub.claims.length === 1);
    await stub.decide(0, 'approved', 'dev-1');
    await c.waitForPaired();
    const events: string[] = [];
    env.events.bus.subscribe('relay.client.*', (e) => events.push(e.name));
    expect((await api('POST', '/api/v1/relay/clients/nope/revoke')).status).toBe(404);
    const r = await api('POST', `/api/v1/relay/clients/${out.paired.clientId}/revoke`);
    expect(r.json).toMatchObject({ ok: true, client: { status: 'revoked' } });
    await until(() => c.state === 'revoked');
    await expect(c.fetch('/api/v1/echo')).rejects.toMatchObject({ code: 'revoked' });
    expect(revokedDevices).toEqual(['dev-1']);
    expect(events).toEqual(['relay.client.revoked']);
    expect(env.audit.find((a) => a.action === 'relay.revoke')).toMatchObject({
      resource: out.paired.clientId,
      detail: { deviceId: 'dev-1', relay: 'removed' },
    });
    // Revoking again is a no-op.
    expect((await api('POST', `/api/v1/relay/clients/${out.paired.clientId}/revoke`)).status).toBe(
      200,
    );
    expect(events).toHaveLength(1);
    // The same device key cannot pair again.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const slot = await area.openPairing({
      accountId: ACCOUNT,
      pairingId: 'add-9',
      expiresAt,
      code: 'QRST-VWXY',
    });
    const again = await pairWithRelay({
      relayUrl: slot.relayUrl,
      relayPairingId: slot.relayPairingId,
      code: 'QRST-VWXY',
      device: out.device,
      name: 'Phone',
      platform: 'ios',
      kdfIterations: ITER,
    });
    await until(() => !relay.state.routes.has(again.paired.clientRoute));
    expect(stub.claims).toHaveLength(1);
  });

  it('drops and logs envelopes from a revoked client the Relay still routes', async () => {
    // The Relay cannot be told (its HTTP calls fail), so it keeps routing the client: the Hub
    // must drop what arrives.
    let failDeletes = false;
    await build({
      fetch: (url, init) =>
        failDeletes && init?.method === 'DELETE'
          ? Promise.reject(new Error('relay unreachable'))
          : fetch(url, init),
    });
    await enable();
    const out = await pairClient();
    const c = client(out.paired);
    await until(() => stub.claims.length === 1);
    await stub.decide(0, 'approved', 'dev-1');
    await c.waitForPaired();
    failDeletes = true;
    const r = await api('POST', `/api/v1/relay/clients/${out.paired.clientId}/revoke`);
    expect(r.json.client.status).toBe('revoked');
    expect(env.audit.find((a) => a.action === 'relay.revoke')?.detail).toMatchObject({
      relay: 'unreachable',
    });
    const pending = c.fetch('/api/v1/echo', { headers: { authorization: 'Bearer good' } });
    pending.catch(() => undefined);
    await until(() =>
      env.logs.records.some(
        (l) => l.msg === 'relay envelope dropped' && l.reason === 'revoked_client',
      ),
    );
    // On the next connection the Hub tells the Relay, which closes the client.
    failDeletes = false;
    await api('PATCH', '/api/v1/relay', { enabled: false });
    await api('PATCH', '/api/v1/relay', { enabled: true });
    await until(() => c.state === 'revoked');
  });

  it('revokes a device’s client when the device is revoked elsewhere', async () => {
    await build();
    const cascade: string[] = [];
    area.onClientRevoked((_a, d) => {
      cascade.push(d);
    });
    await enable();
    const out = await pairClient();
    client(out.paired);
    await until(() => stub.claims.length === 1);
    await stub.decide(0, 'approved', 'dev-7');
    await area.revokeDevice(ACCOUNT, 'dev-7');
    expect((await api('GET', '/api/v1/relay/clients')).json.items[0].status).toBe('revoked');
    // Not handed back to the device revocation it came from.
    expect(cascade).toEqual([]);
    // The event every device revocation emits does the same.
    const second = await pairClient('WXYZ-2345');
    client(second.paired);
    await until(() => stub.claims.length === 2);
    await stub.decide(1, 'approved', 'dev-8');
    await env.events.emit({
      name: 'device.status.changed',
      accountId: ACCOUNT,
      payload: { deviceId: 'dev-8', from: 'active', status: 'revoked' },
    });
    await until(
      async () =>
        (await api('GET', '/api/v1/relay/clients')).json.items.find(
          (c: { id: string }) => c.id === second.paired.clientId,
        )?.status === 'revoked',
    );
  });
});

describe('the tunnel path', () => {
  it('reaches only /api/v1 after normalising, whatever the encoding (security review)', async () => {
    const target = Fastify({ logger: false });
    target.get('/api/v1/ok', () => ({ route: 'ok' }));
    target.get('/api/v1/ws', () => ({ route: 'ws' }));
    target.post('/agent/v1/heartbeat', () => ({ route: 'agent' }));
    target.get('/mcp', () => ({ route: 'mcp' }));
    target.get('/', () => ({ route: 'root' }));
    target.get('/api/v1/files', (req) => ({ route: 'files', query: req.query }));
    await target.ready();
    const dispatch = injectDispatch(() => target);
    const client = { id: 'c1', accountId: ACCOUNT, deviceId: null };
    const run = async (method: string, path: string) => {
      const res = await dispatch(
        { method, path, headers: {}, body: null, client },
        new AbortController().signal,
      );
      let text = '';
      if (res.body) for await (const c of res.body) text += Buffer.from(c).toString();
      return { status: res.status, text };
    };
    expect(await run('GET', '/api/v1/ok')).toEqual({ status: 200, text: '{"route":"ok"}' });
    for (const path of [
      '/api/v1/x/%2e%2e/ws',
      '/api/v1/%2e%2e/%2e%2e/mcp',
      '/api/v1/%2E%2E/%2E%2E/agent/v1/heartbeat',
      '/api/v1/%2e%2e/%2e%2e/',
      '/api/v1/x%2fy',
      '/api/v1/x%5c..',
      '/api/v1/../../mcp',
      '/api/v1/x\\..\\..\\mcp',
      '//evil.example/api/v1/ok',
      '/mcp',
      'api/v1/ok',
    ]) {
      const r = await run(path.includes('agent') ? 'POST' : 'GET', path);
      expect([400, 404], path).toContain(r.status);
      expect(r.text, path).not.toContain('"route"');
    }
    expect((await run('GET', '/api/v1/ws')).status).toBe(400);
    expect((await run('GET', '/api/v1/x/../ws')).status).toBe(400);
    // An encoded slash in the query is a value, not a path: it goes through.
    expect(await run('GET', '/api/v1/files?path=%2Fhome%2Fada')).toEqual({
      status: 200,
      text: '{"route":"files","query":{"path":"/home/ada"}}',
    });
    expect(tunnelUrl('/api/v1/a/./b/../c?x=1')?.href).toBe('http://localhost/api/v1/a/c?x=1');
    await target.close();
  });
});
