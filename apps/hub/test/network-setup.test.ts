// Network Setup routes (FR-136; docs/22 §6; docs/17 M6.5 exit criterion "network setup installs
// or configures a mesh with a reachability test and rollback"): sessions on every route, body
// validation, a full Headscale + Tailscale run through the HTTP API against fake CLIs (detect →
// plan → apply each step with its one-time consent → verify → roll back the run), the security
// setting, consents listed and revoked, the lock-out guard decided from the socket the request
// really came in on (a local proxy is not trusted as local), events, audit and diagnostics, and
// the seams the network and trust areas use.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  type NetworkSetupRequestTransport,
  type NetworkSetupRunView,
  type SettingKey,
} from '@nova/shared';
import { CertificateAuthority, type AuditRecord, type SetupReachabilityResult } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import {
  setupNetworkSetup,
  type NetworkSetupArea,
  type NetworkSetupDeps,
} from '../src/network-setup.ts';
import {
  FAKE_MESH,
  FakeMeshWorld,
  TOOLS,
  argvOf,
} from '../../../packages/core/test/fixtures/mesh/world.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000f3';
const AUTH = { 'x-account': ACCOUNT };
const HS = 'https://hs.example.com';

let db: NovaDatabase;
let app: FastifyInstance;
let area: NetworkSetupArea;
let events: EventStore;
let audit: AuditRecord[];
let diagnostics: DiagnosticsRegistry;
let settings: Partial<Record<SettingKey, unknown>>;
let world: FakeMeshWorld;
let dataDir: string;
let lanOk: boolean;

function reachability(): Promise<SetupReachabilityResult[]> {
  const out: SetupReachabilityResult[] = [
    { transport: 'lan', url: 'http://192.168.1.10:7419', ok: lanOk, latencyMs: 1, detail: null },
  ];
  if (world.state.tailscale.backendState === 'Running')
    out.push({
      transport: 'mesh',
      url: 'http://100.64.0.5:7419',
      ok: true,
      latencyMs: 8,
      detail: null,
    });
  return Promise.resolve(out);
}

async function build(deps: Partial<NetworkSetupDeps> = {}) {
  const ctx = {
    config: { host: '127.0.0.1', port: 7419, tls: null, allowedOrigins: [] },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: new MemorySecretStore(),
    dataDir,
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {} as never,
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics,
  } as unknown as Parameters<typeof setupNetworkSetup>[0];
  area = await setupNetworkSetup(ctx, {
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    runner: world.runner,
    probe: {
      interfaces: () => ({}),
      readFile: () => Promise.resolve(null),
      exists: (p) => p === '/usr/bin/apt-get',
      platform: 'linux',
    },
    verifyRetries: 0,
    verifyDelayMs: 0,
    // Injected requests have no socket address; tests say which path they came in on.
    requestTransport: (req) =>
      (req.headers['x-test-transport'] as NetworkSetupRequestTransport | undefined) ?? null,
    ...deps,
  });
  area.useReachability({ test: reachability });
  area.useTrust({
    ensureLocalCa: () => Promise.resolve({ caFingerprint: 'AA:BB' }),
    requestMeshCert: (host) => Promise.resolve({ host, notAfter: '2027-01-01T00:00:00.000Z' }),
  });
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
  await app.ready();
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  events = new EventStore(db);
  audit = [];
  diagnostics = new DiagnosticsRegistry();
  settings = { 'network.setup.allowSystemChanges': true };
  world = new FakeMeshWorld();
  dataDir = mkdtempSync(join(tmpdir(), 'nova-hub-setup-'));
  lanOk = true;
  await build();
});

afterEach(async () => {
  await app.close();
  await area.close();
  world.close();
  rmSync(dataDir, { recursive: true, force: true });
  db.close();
});

const json = <T = Record<string, unknown>>(r: { body: string }) => JSON.parse(r.body) as T;

function setup(payload: unknown, transport: NetworkSetupRequestTransport = 'lan') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/network/setup',
    headers: { ...AUTH, 'x-test-transport': transport },
    payload: payload as Record<string, unknown>,
  });
}

async function plan(options: Record<string, unknown> = {}): Promise<NetworkSetupRunView> {
  const r = await setup({
    action: 'plan',
    provider: 'headscale',
    options: { controlUrl: HS, advertiseRoutes: ['192.168.1.0/24'], ...options },
  });
  expect(r.statusCode).toBe(201);
  return json<{ run: NetworkSetupRunView }>(r).run;
}

describe('sessions and validation', () => {
  it('every route needs a session', async () => {
    for (const [method, url] of [
      ['POST', '/api/v1/network/setup'],
      ['GET', '/api/v1/network/setup/runs'],
      ['GET', '/api/v1/network/setup/runs/x'],
      ['POST', '/api/v1/network/setup/runs/x/rollback'],
      ['GET', '/api/v1/network/setup/consents'],
      ['DELETE', '/api/v1/network/setup/consents/x'],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('validates every body', async () => {
    for (const body of [
      {},
      { action: 'nuke' },
      { action: 'plan', provider: 'zerotier' },
      { action: 'plan', provider: 'headscale', options: { controlUrl: 'ftp://x' } },
      { action: 'plan', provider: 'headscale', options: { controlUrl: HS, extra: 1 } },
      { action: 'plan', provider: 'headscale', options: { authKey: 'has space in it' } },
      { action: 'plan', provider: 'headscale', options: { tags: ['nova'] } },
      { action: 'plan', provider: 'headscale', options: { advertiseRoutes: ['10.0.0.0'] } },
      { action: 'plan', provider: 'headscale', options: { relay: { url: 'wss://r.example/\nx' } } },
      { action: 'plan', provider: 'headscale', options: { relay: { url: 'wss://r.example/a b' } } },
      { action: 'apply' },
      { action: 'apply', runId: 'r', consent: { stepId: 's' } },
      { action: 'detect', extra: true },
    ]) {
      const r = await setup(body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const rb = await app.inject({
      method: 'POST',
      url: '/api/v1/network/setup/runs/x/rollback',
      headers: AUTH,
      payload: { stepId: 'a', all: true },
    });
    expect(rb.statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/network/setup/runs/nope', headers: AUTH }))
        .statusCode,
    ).toBe(404);
  });
});

describe('a Headscale + Tailscale run over HTTP', { timeout: 30_000 }, () => {
  it('detects, plans, applies each consented step, verifies, and rolls the run back', async () => {
    const det = await setup({ action: 'detect' });
    expect(det.statusCode).toBe(200);
    const detection = json<{ detection: { meshes: { provider: string; installed: boolean }[] } }>(
      det,
    ).detection;
    expect(detection.meshes.find((m) => m.provider === 'headscale')?.installed).toBe(true);

    const run = await plan();
    expect(run.status).toBe('planned');
    for (let i = 0; i < 15; i++) {
      const current = json<NetworkSetupRunView>(
        await app.inject({
          method: 'GET',
          url: `/api/v1/network/setup/runs/${run.id}`,
          headers: AUTH,
        }),
      );
      const next = current.steps.find((s) => s.status === 'pending');
      if (!next) break;
      // Without consent the step is refused with what to confirm.
      if (next.consent.required && !next.consent.remembered) {
        const ask = await setup({ action: 'apply', runId: run.id, stepId: next.id });
        expect(ask.statusCode).toBe(403);
        expect(json<{ error: { details: unknown } }>(ask).error.details).toEqual({
          reason: 'consent_required',
          stepId: next.id,
          description: next.description,
        });
      }
      const r = await setup({
        action: 'apply',
        runId: run.id,
        stepId: next.id,
        consent: { stepId: next.id, description: next.description },
      });
      expect(r.statusCode).toBe(200);
      expect(json<{ step: { status: string } }>(r).step.status).toBe('verified');
    }
    const done = json<NetworkSetupRunView>(
      await app.inject({
        method: 'GET',
        url: `/api/v1/network/setup/runs/${run.id}`,
        headers: AUTH,
      }),
    );
    expect(done.status).toBe('completed');
    expect(world.changes().map(argvOf)).toContain(
      `tailscale up --login-server=${HS} --auth-key=file:/dev/stdin --hostname=nova-hub --advertise-tags=tag:nova-hub --accept-dns=true`,
    );
    const key = world.state.headscale.keys[0]!.key;
    expect(JSON.stringify(done)).not.toContain(key);

    const verify = await setup({ action: 'verify', runId: run.id });
    expect(json<{ ok: boolean }>(verify).ok).toBe(true);

    const list = json<{ items: NetworkSetupRunView[] }>(
      await app.inject({ method: 'GET', url: '/api/v1/network/setup/runs', headers: AUTH }),
    );
    expect(list.items.map((r) => r.id)).toEqual([run.id]);

    // Seams: the mesh endpoints for the network area, the ACL summary, the mesh certificate source.
    expect((await area.endpointSource.list()).map((c) => [c.transport, c.url])).toEqual([
      ['mesh', 'http://nova-hub.nova.mesh:7419'],
      ['mesh', 'http://100.64.0.5:7419'],
    ]);
    expect((await area.aclSummary()).tagOwners).toEqual(['tag:nova-hub']);
    world.update((s) => {
      s.cert = CertificateAuthority.create();
    });
    expect((await area.meshCerts.request('nova-hub.nova.mesh')).certPem).toContain('CERTIFICATE');

    world.clearCalls();
    const back = await app.inject({
      method: 'POST',
      url: `/api/v1/network/setup/runs/${run.id}/rollback`,
      headers: { ...AUTH, 'x-test-transport': 'lan' },
    });
    expect(back.statusCode).toBe(200);
    expect(json<NetworkSetupRunView>(back).status).toBe('rolled_back');
    expect(world.changes().map(argvOf)).toContain('tailscale logout');
    expect(world.state.tailscale.backendState).toBe('NeedsLogin');

    const stored = await events.since(null, 500, { accountId: ACCOUNT });
    const steps = stored
      .filter((e) => e.name === 'network.setup.step')
      .map((e) => e.payload.status);
    expect(steps).toEqual(expect.arrayContaining(['applied', 'verified', 'rolled_back']));
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(new Set(audit.map((a) => a.action))).toEqual(
      new Set(['network.setup.consent', 'network.setup.apply', 'network.setup.rollback']),
    );
    expect(JSON.stringify(audit)).not.toContain(key);
    expect((await diagnostics.collect()).networkSetup).toEqual({
      allowSystemChanges: true,
      runs: { rolled_back: 1 },
    });
  });

  it('consents are listed and revoked', async () => {
    const run = await plan();
    const user = run.steps.find((s) => s.kind === 'server.user')!;
    await setup({
      action: 'apply',
      runId: run.id,
      consent: { stepId: user.id, description: user.description },
    });
    const list = json<{ items: { id: string; kind: string }[] }>(
      await app.inject({ method: 'GET', url: '/api/v1/network/setup/consents', headers: AUTH }),
    );
    expect(list.items.map((c) => c.kind)).toEqual(['server.user']);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/network/setup/consents/${list.items[0]!.id}`,
      headers: AUTH,
    });
    expect(json(del)).toEqual({ ok: true });
    expect(
      json<{ items: unknown[] }>(
        await app.inject({ method: 'GET', url: '/api/v1/network/setup/consents', headers: AUTH }),
      ).items,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/network/setup/consents/${list.items[0]!.id}`,
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses host changes while the setting is off; plans still work', async () => {
    settings['network.setup.allowSystemChanges'] = false;
    const run = await plan();
    const user = run.steps.find((s) => s.kind === 'server.user')!;
    const r = await setup({
      action: 'apply',
      runId: run.id,
      consent: { stepId: user.id, description: user.description },
    });
    expect(r.statusCode).toBe(403);
    expect(json<{ error: { details: { reason: string } } }>(r).error.details.reason).toBe(
      'system_changes_disabled',
    );
    expect(world.changes()).toEqual([]);
  });
});

describe('the lock-out guard over a real socket', { timeout: 30_000 }, () => {
  async function onMeshOnly(deps: Partial<NetworkSetupDeps>) {
    await app.close();
    await build(deps);
    world.update((s) => {
      Object.assign(s.tailscale, {
        backendState: 'Running',
        loggedOut: false,
        wantRunning: true,
        controlUrl: HS,
        hostname: 'nova-hub',
        ips: ['100.64.0.5'],
        dnsName: 'nova-hub.nova.mesh',
      });
    });
    // Only the mesh answers, and the ACL step can cut the mesh.
    lanOk = false;
    const run = await plan({ advertiseRoutes: [] });
    const acl = run.steps.find((s) => s.kind === 'server.acl')!;
    const user = run.steps.find((s) => s.kind === 'server.user')!;
    await setup({
      action: 'apply',
      runId: run.id,
      consent: { stepId: user.id, description: user.description },
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    return (headers: Record<string, string>) =>
      fetch(`${url}/api/v1/network/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH, ...headers },
        body: JSON.stringify({
          action: 'apply',
          runId: run.id,
          stepId: acl.id,
          consent: { stepId: acl.id, description: acl.description },
        }),
      });
  }

  it('does not take loopback as proof the owner is on the Hub (review finding 9)', async () => {
    const call = await onMeshOnly({ requestTransport: undefined });
    // An SSH tunnel or a proxy that adds no header arrives from 127.0.0.1 just the same: the
    // path is unknown, and the only healthy path is the mesh this step touches.
    const variants: Record<string, string>[] = [
      {},
      { 'x-real-ip': '100.64.0.9' },
      { 'x-forwarded-for': '100.64.0.9' },
    ];
    for (const headers of variants) {
      const r = await call(headers);
      expect(r.status, JSON.stringify(headers)).toBe(409);
      const body = (await r.json()) as {
        error: { details: { reason: string; transport: string } };
      };
      expect(body.error.details).toMatchObject({ reason: 'would_lock_out', transport: 'unknown' });
    }
    expect(world.state.headscale.policy).toBeNull();
  });

  it('believes an explicit marker from the Hub', async () => {
    const call = await onMeshOnly({ requestTransport: () => 'local' });
    expect((await call({})).status).toBe(200);
  });
});

describe('NOVA_NETWORK_TOOLS_FILE', () => {
  afterEach(() => {
    delete process.env.NOVA_NETWORK_TOOLS_FILE;
  });

  it('runs the programs the file names instead of the system CLIs', async () => {
    const file = join(dataDir, 'tools.json');
    writeFileSync(
      file,
      JSON.stringify({
        bins: Object.fromEntries(TOOLS.map((t) => [t, [process.execPath, FAKE_MESH, t]])),
        baseEnv: { NOVA_FAKE_MESH_DIR: world.dir },
      }),
    );
    process.env.NOVA_NETWORK_TOOLS_FILE = file;
    await app.close();
    await area.close();
    await build({ runner: undefined });
    const before = world.calls().length;
    const det = await setup({ action: 'detect' });
    expect(det.statusCode).toBe(200);
    expect(world.calls().length).toBeGreaterThan(before);
  });

  it('refuses to start with a file it cannot parse', async () => {
    const file = join(dataDir, 'tools.json');
    writeFileSync(file, JSON.stringify({ bins: { tailscale: 'not a list' } }));
    process.env.NOVA_NETWORK_TOOLS_FILE = file;
    await app.close();
    await area.close();
    await expect(build({ runner: undefined })).rejects.toThrow();
    // afterEach closes what build left open: give it a working area again.
    delete process.env.NOVA_NETWORK_TOOLS_FILE;
    await build();
  });
});
