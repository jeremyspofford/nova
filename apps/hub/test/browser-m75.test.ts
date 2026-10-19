/* eslint-disable @typescript-eslint/require-await */
// The browser area's M7.5 routes (FR-209, FR-096; ADR-096 D7, D8): `POST /agent/v1/bridge/events`
// authenticated with the device credential like a heartbeat (none, a wrong one, a revoked device,
// a bad body), the owner's bridge status and per-host grants under `/devices/:id/bridge` ("all
// sites" with its own acknowledgement, the policy switches, another account refused), the
// fallback's consents and sessions, the trace's fallback marks, and the devices wiring (the
// management transport for bridge calls with the device's pinned key, revocation forgetting
// consents and grants).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NovaError, SETTINGS, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import {
  deviceSecretHash,
  managementTokenRef,
  type AuditRecord,
  type DeviceService,
  type BrowserDriver,
  type DeviceTransport,
  type ManagedDevice,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import {
  hubOwnHosts,
  setupBrowser,
  type BrowserArea,
  type BrowserDevices,
} from '../src/browser.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const MEMBER = '01920000-0000-7000-8000-000000000002';
const DEVICE = '01920000-0000-7000-8000-0000000000f1';
// secret-scan: fake
const CREDENTIAL = 'nvc_device_credential_for_bridge_events';
const OWNER = { 'x-account': ACCOUNT };

let dir: string;
let db: NovaDatabase;
let events: EventStore;
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let secrets: MemorySecretStore;
let policy: PolicyAreaFull;
let area: BrowserArea;
let sweeps: (() => void)[];
let app: FastifyInstance;

/** A driver that never starts (the routes here need no browser). */
const driver: BrowserDriver = {
  name: 'fake',
  probe: async () => ({ ok: true, detail: 'fake' }),
  launch: async () => {
    throw new Error('no browser in these tests');
  },
};

function context(): HubContext {
  return {
    config: {},
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets,
    dataDir: join(dir, 'data'),
    registry: {},
    router: {},
    nodes: {},
    threads: {},
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      const who = req.headers['x-account'];
      if (who !== ACCOUNT && who !== MEMBER)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(who);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
}

function insertDevice(id: string, status = 'active', credential: string | null = CREDENTIAL): void {
  const now = new Date().toISOString();
  let tokenId: string | null = null;
  if (credential) {
    tokenId = `tok-${id}`;
    db.raw
      .prepare(
        "INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES (?, 'device', ?, ?, ?)",
      )
      .run(tokenId, deviceSecretHash(credential), ACCOUNT, now);
  }
  db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status,
         credential_token_id, created_at, updated_at)
       VALUES (?, ?, 'Laptop', 'client', ?, 'pinned-key', '["client"]', ?, ?, ?, ?)`,
    )
    .run(id, ACCOUNT, `fp-${id}`, status, tokenId, now, now);
  db.raw
    .prepare(
      'INSERT INTO device_management (device_id, protocol_version, updated_at) VALUES (?, 1, ?)',
    )
    .run(id, now);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-browser-m75-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const [id, at] of [
    [ACCOUNT, now],
    [MEMBER, new Date(Date.now() + 1_000).toISOString()],
  ] as const)
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, at, at);
  insertDevice(DEVICE);
  events = new EventStore(db);
  audit = [];
  settings = {};
  secrets = new MemorySecretStore();
  sweeps = [];
  const ctx = context();
  const sink = { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) };
  policy = await setupPolicy(
    { ...ctx, audit: sink, notifier: { notify: () => Promise.resolve() } },
    { home: join(dir, 'home'), approvalTimeoutMs: () => 60_000 },
  );
  area = await setupBrowser(ctx, {
    gate: policy.gate,
    audit: sink,
    driver,
    requireEgress: false,
    setTimer: (fn) => {
      sweeps.push(fn);
      return () => undefined;
    },
  });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  await policy.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = OWNER,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

const events1 = {
  events: [
    { kind: 'connected', extensionVersion: '0.7.5', browser: 'Chromium' },
    { kind: 'tab.shared', tabId: 3, host: 'github.com', title: 'Nova' },
    { kind: 'host.granted', host: 'github.com' },
  ],
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('POST /agent/v1/bridge/events', () => {
  it('takes the device credential, like a heartbeat', async () => {
    expect((await call('POST', '/agent/v1/bridge/events', events1, {})).body).toMatchObject({
      error: { code: 'token_required' },
    });
    const wrong = await call('POST', '/agent/v1/bridge/events', events1, bearer('nvc_wrong'));
    expect(wrong).toMatchObject({ status: 401, body: { error: { code: 'auth_missing' } } });
    // A session token is not a device credential.
    expect(
      (await call('POST', '/agent/v1/bridge/events', events1, bearer('nvs_session'))).status,
    ).toBe(401);
    const ok = await call('POST', '/agent/v1/bridge/events', events1, bearer(CREDENTIAL));
    expect(ok).toEqual({ status: 200, body: { accepted: 3, refused: 0 } });
    const st = await call('GET', `/api/v1/devices/${DEVICE}/bridge`);
    expect(st.body).toMatchObject({
      deviceId: DEVICE,
      connected: true,
      extensionVersion: '0.7.5',
      enabled: true,
      tabs: [expect.objectContaining({ tabId: 3, host: 'github.com', origin: 'shared' })],
    });
  });

  it('refuses a revoked device and a body it does not know', async () => {
    const bad = await call(
      'POST',
      '/agent/v1/bridge/events',
      { events: [{ kind: 'tab.shared', tabId: 1, host: 'a.example', cookies: 'x' }] },
      bearer(CREDENTIAL),
    );
    // An event the Hub does not know is skipped and counted, never the whole batch (novad
    // would retry it forever); a body that is not a batch is refused.
    expect(bad).toEqual({ status: 200, body: { accepted: 0, refused: 1 } });
    expect(audit.find((a) => a.action === 'browser.bridge.events.refused')).toMatchObject({
      resource: DEVICE,
      detail: { count: 1 },
    });
    const mixed = await call(
      'POST',
      '/agent/v1/bridge/events',
      {
        events: [
          { kind: 'connected', user: 'jeremy', at: '2026-10-19T10:00:00Z' },
          { kind: 'nope' },
        ],
      },
      bearer(CREDENTIAL),
    );
    expect(mixed.body).toEqual({ accepted: 1, refused: 1 });
    expect(
      (await call('POST', '/agent/v1/bridge/events', { events: [] }, bearer(CREDENTIAL))).status,
    ).toBe(400);
    expect(
      (await call('POST', '/agent/v1/bridge/events', { other: 1 }, bearer(CREDENTIAL))).status,
    ).toBe(400);
    db.raw.prepare("UPDATE device SET status = 'revoked' WHERE id = ?").run(DEVICE);
    expect(
      (await call('POST', '/agent/v1/bridge/events', events1, bearer(CREDENTIAL))).status,
    ).toBe(401);
  });
});

describe('the bridge grants (the owner’s)', () => {
  const grants = `/api/v1/devices/${DEVICE}/bridge/grants`;

  it('grants a host, confirms a reported one, revokes, and keeps "all sites" apart', async () => {
    expect((await call('GET', grants, undefined, {})).status).toBe(401);
    const host = await call('POST', grants, { kind: 'host', host: 'gitlab.com', confirm: true });
    expect(host).toMatchObject({
      status: 201,
      body: { host: 'gitlab.com', state: 'active', allSites: false },
    });
    expect((await call('POST', grants, { kind: 'host', host: 'gitlab.com' })).status).toBe(400);
    expect(
      (await call('POST', grants, { kind: 'host', host: '10.0.0.1', confirm: true })).status,
    ).toBe(400);
    // "All sites" needs its own acknowledgement of the elevated risk.
    expect((await call('POST', grants, { kind: 'all_sites', confirm: true })).status).toBe(400);
    settings['browser.extensionBridgeAllSites'] = false;
    expect(
      (
        await call('POST', grants, {
          kind: 'all_sites',
          confirm: true,
          acknowledgeElevatedRisk: true,
        })
      ).status,
    ).toBe(403);
    settings['browser.extensionBridgeAllSites'] = true;
    expect(
      await call('POST', grants, {
        kind: 'all_sites',
        confirm: true,
        acknowledgeElevatedRisk: true,
      }),
    ).toMatchObject({ status: 201, body: { host: '*', allSites: true, state: 'active' } });
    // A host the extension reported is pending until the owner confirms it.
    await call('POST', '/agent/v1/bridge/events', events1, bearer(CREDENTIAL));
    const listed = (await call('GET', grants)).body.items as {
      id: string;
      host: string;
      state: string;
    }[];
    const pending = listed.find((g) => g.host === 'github.com')!;
    expect(pending.state).toBe('pending');
    const confirmed = await call('POST', `${grants}/${pending.id}/confirm`, { confirm: true });
    expect(confirmed.body).toMatchObject({ state: 'active', browserPermission: true });
    expect((await call('DELETE', `${grants}/${pending.id}`)).body).toEqual({ ok: true });
    expect((await call('DELETE', `${grants}/nope`)).status).toBe(404);
    const all = (await call('GET', `${grants}?all=true`)).body.items as { state: string }[];
    expect(all.map((g) => g.state).sort()).toEqual(['active', 'active', 'revoked']);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'browser.bridge.grant.created',
        'browser.bridge.grant.all_sites',
        'browser.bridge.host.reported',
        'browser.bridge.grant.revoked',
      ]),
    );
  });

  it('refuses everything while the managed switch is off, and anyone but the owner', async () => {
    settings['browser.extensionBridge'] = false;
    expect(
      (await call('POST', grants, { kind: 'host', host: 'gitlab.com', confirm: true })).status,
    ).toBe(403);
    expect((await call('GET', `/api/v1/devices/${DEVICE}/bridge`)).body).toMatchObject({
      enabled: false,
    });
    settings['browser.extensionBridge'] = true;
    const member = { 'x-account': MEMBER };
    expect(
      await call('POST', grants, { kind: 'host', host: 'gitlab.com', confirm: true }, member),
    ).toMatchObject({ status: 403, body: { error: { details: { reason: 'owner_only' } } } });
    expect((await call('GET', `/api/v1/devices/unknown/bridge`)).status).toBe(404);
  });
});

describe('the fallback’s consents, sessions and trace marks', () => {
  it('lists and revokes consents, lists sessions, and marks trace rows', async () => {
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO browser_fallback_consent (id, account_id, scope_kind, scope_ref, device_id, site,
           profile, granted_by, created_at) VALUES ('c1', ?, 'agent', 'agent-1', ?, 'shop.example', 'clean', ?, ?)`,
      )
      .run(ACCOUNT, DEVICE, ACCOUNT, now);
    db.raw
      .prepare(
        `INSERT INTO browser_fallback_session (id, account_id, computer_id, device_id, site, profile,
           cause, consent_id, started_at) VALUES ('s1', ?, 'comp-1', ?, 'shop.example', 'clean', 'block_page', 'c1', ?)`,
      )
      .run(ACCOUNT, DEVICE, now);
    for (const id of ['a1', 'a2'])
      db.raw
        .prepare(
          `INSERT INTO browser_action (id, account_id, computer_id, tool, action, result, created_at)
           VALUES (?, ?, 'comp-1', 'browser.navigate', 'navigate', 'ok', ?)`,
        )
        .run(id, ACCOUNT, now);
    db.raw
      .prepare("INSERT INTO browser_fallback_action (action_id, session_id) VALUES ('a2', 's1')")
      .run();
    expect((await call('GET', '/api/v1/browser/fallback/consents')).body.items).toEqual([
      expect.objectContaining({
        id: 'c1',
        deviceName: 'Laptop',
        site: 'shop.example',
        revokedAt: null,
      }),
    ]);
    expect((await call('GET', '/api/v1/browser/fallback/consents?scopeKind=nope')).status).toBe(
      400,
    );
    expect(
      (await call('GET', '/api/v1/browser/fallback/sessions?computerId=comp-1')).body.items,
    ).toEqual([expect.objectContaining({ id: 's1', cause: 'block_page', endedAt: null })]);
    const trace = (await call('GET', '/api/v1/browser/actions')).body.items as {
      id: string;
      localFallback: unknown;
    }[];
    expect(trace.find((a) => a.id === 'a2')?.localFallback).toEqual({
      sessionId: 's1',
      deviceId: DEVICE,
      profile: 'clean',
    });
    expect(trace.find((a) => a.id === 'a1')?.localFallback).toBeNull();
    expect((await call('DELETE', '/api/v1/browser/fallback/consents/c1')).body).toEqual({
      ok: true,
    });
    expect((await call('GET', '/api/v1/browser/fallback/consents')).body.items).toEqual([]);
    expect((await call('GET', '/api/v1/browser/fallback/consents?all=true')).body.items).toEqual([
      expect.objectContaining({ id: 'c1', revokedBy: ACCOUNT }),
    ]);
    expect((await call('DELETE', '/api/v1/browser/fallback/consents/nope')).status).toBe(404);
    expect((await call('GET', '/api/v1/browser/fallback/sessions', undefined, {})).status).toBe(
      401,
    );
  });
});

describe('the devices wiring', () => {
  it('takes the devices area as it is (app.ts: browser.useDevices(devices.service, …))', () => {
    // A compile-time check: DeviceService is a BrowserDevices.
    const fits = (d: DeviceService): BrowserDevices => d;
    expect(typeof fits).toBe('function');
  });

  it('calls novad through the management transport with the pinned key, and forgets revoked devices', async () => {
    await secrets.put(managementTokenRef(DEVICE), 'nvm_token');
    const posts: { url: string; token: string; target: unknown }[] = [];
    const transport: DeviceTransport = {
      post: async (url, token, body, _ms, target) => {
        posts.push({ url, token, target });
        // A session a previous run left on the device (review #7).
        if (url.endsWith('/agent/v1/browser/list'))
          return { status: 200, body: { sessions: [{ sessionId: 'orphan-1' }], max: 2 } };
        if (url.endsWith('/agent/v1/browser/close'))
          return { status: 200, body: { closed: true, egress: { allowed: 0, refused: 0 } } };
        return { status: 200, body: { result: { echo: (body as { method: string }).method } } };
      },
    };
    let revoked: ((accountId: string, deviceId: string) => void | Promise<void>) | null = null;
    const devices: BrowserDevices = {
      device: async () =>
        ({
          row: { id: DEVICE, status: 'active', publicKey: 'pinned-key' },
          endpoint: 'https://192.168.1.20:7420',
          mgmt: {},
          document: {},
        }) as unknown as ManagedDevice,
      activeConnection: async () => null,
      capabilities: async () => [],
      managementTransport: transport,
      onRevoked: (hook) => {
        revoked = hook;
        return () => undefined;
      },
    };
    area.useDevices(devices, async () => null);
    // At once: the sessions the device runs that this Hub does not know are closed.
    await vi.waitFor(() =>
      expect(posts.map((p) => p.url.replace(/^.*\/agent\/v1\//, ''))).toEqual([
        'browser/list',
        'browser/close',
      ]),
    );
    await vi.waitFor(() =>
      expect(audit.find((a) => a.action === 'browser.fallback.orphan_closed')).toMatchObject({
        resource: DEVICE,
        detail: { sessionId: 'orphan-1' },
      }),
    );
    expect(sweeps.length).toBeGreaterThan(0);
    posts.length = 0;
    await call('POST', '/agent/v1/bridge/events', events1, bearer(CREDENTIAL));
    expect(await area.bridge.call(ACCOUNT, DEVICE, 'tabs.list', {})).toEqual({ echo: 'tabs.list' });
    expect(posts).toEqual([
      {
        url: 'https://192.168.1.20:7420/agent/v1/bridge/call',
        token: 'nvm_token',
        target: { deviceId: DEVICE, publicKey: 'pinned-key' },
      },
    ]);
    await call('POST', `/api/v1/devices/${DEVICE}/bridge/grants`, {
      kind: 'host',
      host: 'gitlab.com',
      confirm: true,
    });
    await revoked!(ACCOUNT, DEVICE);
    expect((await call('GET', `/api/v1/devices/${DEVICE}/bridge/grants`)).body.items).toEqual([]);
    // The fallback refuses without a connected computer (the resolver now wired).
    const plan = await area.fallback.begin({
      accountId: ACCOUNT,
      threadId: 't',
      turnId: null,
      callId: 'c',
      computerId: 'comp-1',
      site: 'shop.example',
      url: 'https://shop.example/',
      cause: 'block_page',
      detail: 'x',
      allowHosts: [],
      signal: new AbortController().signal,
    });
    expect(plan).toMatchObject({ ok: false, reason: 'no_connected_computer' });
  });
});

describe('the Hub’s own hosts and the fallback’s life cycle', () => {
  it('never grants the Hub’s own names to the bridge, all sites included', async () => {
    settings['relay.url'] = 'wss://relay.nova.example/connect';
    settings['network.lan.mdnsName'] = 'nova-home';
    // The address channels and MCP event servers reach the Hub at is one of its own names too.
    settings['channels.publicUrl'] = 'https://Hooks.Nova.Example:8443/base';
    const own = await hubOwnHosts(context());
    expect(own).toEqual(
      expect.arrayContaining([
        'localhost',
        hostname().toLowerCase(),
        'nova-home.local',
        'relay.nova.example',
        'hooks.nova.example',
      ]),
    );
    for (const host of ['relay.nova.example', 'nova-home.local', 'hooks.nova.example'])
      expect(
        await call('POST', `/api/v1/devices/${DEVICE}/bridge/grants`, {
          kind: 'host',
          host,
          confirm: true,
        }),
      ).toMatchObject({ status: 403, body: { error: { details: { reason: 'hub_host' } } } });
    await call('POST', `/api/v1/devices/${DEVICE}/bridge/grants`, {
      kind: 'all_sites',
      confirm: true,
      acknowledgeElevatedRisk: true,
    });
    expect(await area.bridge.hostAllowed(ACCOUNT, DEVICE, 'relay.nova.example')).toEqual({
      ok: false,
      reason: 'hub_host',
    });
    expect(await area.bridge.hostAllowed(ACCOUNT, DEVICE, 'example.org')).toMatchObject({
      ok: true,
    });
  });

  it('stops running fallbacks when browser.localFallback is turned off', async () => {
    const stop = vi.spyOn(area.fallback, 'stopAll');
    settings['browser.localFallback'] = false;
    await events.emit({
      name: 'settings.changed',
      accountId: ACCOUNT,
      actor: 'user',
      payload: { key: 'browser.localFallback' },
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('disabled'));
    settings['browser.localFallback'] = true;
    await events.emit({
      name: 'settings.changed',
      accountId: ACCOUNT,
      actor: 'user',
      payload: { key: 'browser.localFallback' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('ends the fallback sessions a previous run left open, at start', async () => {
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO browser_fallback_session (id, account_id, computer_id, device_id, site, profile,
           cause, started_at) VALUES ('old', ?, 'comp-1', ?, 'shop.example', 'clean', 'block_page', ?)`,
      )
      .run(ACCOUNT, DEVICE, now);
    const again = await setupBrowser(context(), {
      gate: policy.gate,
      driver,
      requireEgress: false,
      setTimer: () => () => undefined,
    });
    try {
      await vi.waitFor(() =>
        expect(again.fallback.sessions(ACCOUNT)[0]).toMatchObject({
          id: 'old',
          endReason: 'restarted',
        }),
      );
    } finally {
      await again.close();
    }
  });
});
