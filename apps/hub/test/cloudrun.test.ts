// Cloud runner area (FR-108, FR-071, FR-116; contracts/rest-api.md §5; ADR-095 decision 4): every
// /api/v1/cloud route needs a session; registering the runner (tested first, the token only in the
// vault, managed locks win); and the integration: a cloud environment saved through
// /api/v1/environments, a Code session in it, a command of that session run on a real runner on
// 127.0.0.1 (bubblewrap; skipped with the reason where it is missing) and on the same runner with
// a host test double as its sandbox (always), the lease and its metering, the runner's processes
// in the environment routes, Hub-side change capture through the cloud transport, a Work run
// started on the environment, and the sweep that frees an archived session's lease.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  RUNNER_TOKEN_REF,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  type SettingKey,
} from '@nova/shared';
import {
  DirectRouter,
  ExecSessions,
  UnavailableSandbox,
  threadSandboxRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  type AuditRecord,
  type CloudWorkRuns,
} from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  buildRunnerServer,
  newRunnerToken,
  silentLog,
  tokenHash,
  tokenRecord,
  type RunnerServer,
} from '@nova/runner-service';
import { setupCloudRun, type CloudRunArea } from '../src/cloudrun.ts';
import { setupCode, type CodeArea } from '../src/code.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { HostSubstrate } from '../../../services/runner/test/host-substrate.ts';
import { bwrapReason, makeRepo } from '../../../services/runner/test/env.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

const ACCOUNT = '01920000-0000-7000-8000-0000000000c7';
const AUTH = { 'x-test-account': ACCOUNT };
const realReason = await bwrapReason();
if (realReason) console.warn(`cloud runner Hub test on a real sandbox skipped: ${realReason}`);

let dir: string;
let db: NovaDatabase;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-cloud-'));
  mkdirSync(join(dir, 'repos'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
});

interface Env {
  app: FastifyInstance;
  code: CodeArea;
  cloud: CloudRunArea;
  runner: RunnerServer;
  url: string;
  token: string;
  events: EventStore;
  secrets: MemorySecretStore;
  audit: AuditRecord[];
  managed: Record<string, unknown>;
}

const open: Env[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) {
    await e.app.close();
    await e.cloud.close();
    await e.code.close();
    await e.runner.close();
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function env(opts: { host?: boolean } = {}): Promise<Env> {
  const token = newRunnerToken();
  const runner = await buildRunnerServer({
    dataDir: join(dir, 'runner'),
    tokens: [tokenRecord(tokenHash(token))],
    localRepoRoots: [join(dir, 'repos')],
    log: silentLog,
    limits: { meterIntervalMs: 50, diskIntervalMs: 100 },
    ...(opts.host ? { substrate: new HostSubstrate() } : {}),
  });
  const url = await runner.app.listen({ host: '127.0.0.1', port: 0 });
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const mock = new MockProvider({ id: 'mock' });
  const registry = new ProviderRegistry({
    db,
    secrets,
    factory: (input) => (input.row.provider === 'mock' ? mock : undefined),
  });
  await registry.ensureDefaultProvider(ACCOUNT);
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
  const managed: Record<string, unknown> = {};
  const setting = (key: SettingKey) => {
    const rows = db.raw
      .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
      .all() as { key: string; value_json: string }[];
    const global: Record<string, unknown> = {};
    for (const r of rows) global[r.key] = JSON.parse(r.value_json) as unknown;
    return Promise.resolve(resolveSetting(key, { global, project: {}, managed }).value);
  };
  const ctx = {
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    events,
    secrets,
    dataDir: config.dataDir,
    registry,
    router,
    nodes: new NodeService({ db, secrets, events }),
    threads,
    setting,
    accountOf: (req: { headers: Record<string, unknown> }) => {
      if (req.headers['x-test-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const audit: AuditRecord[] = [];
  const sink = { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) };
  const code = await setupCode({
    ...ctx,
    audit: sink,
    home: join(dir, 'home'),
    sandbox: () => null,
    containerSandbox: () => null,
    turns: {
      startTurn: () =>
        Promise.resolve({ turnId: 't', messageId: 'm', done: new Promise(() => undefined) }),
      cancel: () => Promise.resolve(),
    },
  });
  const cloud = await setupCloudRun(ctx, { audit: sink, sweepIntervalMs: 60_000 });
  // The lead's wiring (app.ts).
  code.service.envs.useCloud(cloud.provider);
  code.service.useEnvironmentTransport('cloud', cloud.transportFor);
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  code.register(app);
  cloud.register(app);
  await app.ready();
  const e: Env = { app, code, cloud, runner, url, token, events, secrets, audit, managed };
  open.push(e);
  return e;
}

function req(e: Env) {
  return async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const r = await e.app.inject({
      method,
      url,
      headers: AUTH,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    const body: Json = r.body ? r.json() : {};
    return { status: r.statusCode, body, raw: r.body };
  };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('cloud runner routes', () => {
  it('requires a session on every route', async () => {
    const e = await env({ host: true });
    const id = '01920000-0000-7000-8000-00000000dead';
    for (const [method, url] of [
      ['GET', '/api/v1/cloud/runner'],
      ['PUT', '/api/v1/cloud/runner'],
      ['PATCH', '/api/v1/cloud/runner'],
      ['POST', '/api/v1/cloud/runner/test'],
      ['DELETE', '/api/v1/cloud/runner'],
      ['GET', '/api/v1/cloud/environments'],
      ['GET', `/api/v1/cloud/environments/${id}`],
      ['POST', `/api/v1/cloud/environments/${id}/rebuild`],
      ['GET', `/api/v1/cloud/environments/${id}/files?path=/workspace`],
      ['GET', `/api/v1/cloud/environments/${id}/snapshots`],
      ['POST', `/api/v1/cloud/environments/${id}/snapshots`],
      ['POST', `/api/v1/cloud/snapshots/${id}/restore`],
      ['DELETE', `/api/v1/cloud/snapshots/${id}`],
      ['GET', '/api/v1/cloud/runs'],
      ['GET', `/api/v1/cloud/runs/${id}`],
      ['PATCH', `/api/v1/cloud/runs/${id}`],
      ['POST', `/api/v1/cloud/runs/${id}/cancel`],
      ['POST', `/api/v1/cloud/runs/${id}/artifacts`],
      ['POST', '/api/v1/cloud/work'],
    ] as const) {
      const res = await e.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('registers the runner: tested first, the token only in the vault, managed locks win', async () => {
    const e = await env({ host: true });
    const r = req(e);
    expect((await r('GET', '/api/v1/cloud/runner')).body).toMatchObject({
      enabled: false,
      state: 'unconfigured',
      hasToken: false,
      caps: { cpuSeconds: 3600, wallSeconds: 14400, diskMb: 10240 },
    });
    const bad = await r('PUT', '/api/v1/cloud/runner', {
      url: e.url,
      token: newRunnerToken(),
      enabled: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe('runner_test_failed');
    expect(
      (await r('PUT', '/api/v1/cloud/runner', { url: 'http://example.com', token: e.token }))
        .status,
    ).toBe(400);
    const ok = await r('PUT', '/api/v1/cloud/runner', {
      url: e.url,
      token: e.token,
      enabled: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, hasToken: true, state: 'ok', url: e.url });
    expect(ok.raw).not.toContain(e.token);
    expect(await e.secrets.get(RUNNER_TOKEN_REF)).toBe(e.token);
    const changed = (await e.events.since(null, 500)).filter((x) => x.name === 'settings.changed');
    expect(changed.map((x) => x.payload.key)).toEqual(
      expect.arrayContaining(['cloud.runner.url', 'cloud.runner.token', 'cloud.runner.enabled']),
    );
    expect(JSON.stringify(await e.events.since(null, 500))).not.toContain(e.token);
    expect((await r('POST', '/api/v1/cloud/runner/test')).body).toMatchObject({ ok: true });
    expect((await r('PATCH', '/api/v1/cloud/runner', { enabled: false })).body.enabled).toBe(false);
    e.managed['cloud.runner.enabled'] = false;
    const locked = await r('PATCH', '/api/v1/cloud/runner', { enabled: true });
    expect(locked.status).toBe(403);
    delete e.managed['cloud.runner.enabled'];
    expect((await r('DELETE', '/api/v1/cloud/runner')).body).toEqual({ ok: true });
    expect(await e.secrets.get(RUNNER_TOKEN_REF)).toBeNull();
    expect(e.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['cloud.runner.change', 'cloud.runner.remove']),
    );
    // Without a runner a cloud environment is refused, never run on the Hub.
    const refused = await r('POST', '/api/v1/environments', {
      kind: 'cloud',
      label: 'x',
      connection: { repoUrls: [] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.reason).toBe('runner_unconfigured');
    // Review finding 1: no network for a cloud environment unless the owner's setting is on.
    expect(
      (await r('PUT', '/api/v1/cloud/runner', { url: e.url, token: e.token, enabled: true }))
        .status,
    ).toBe(200);
    const networked = await r('POST', '/api/v1/environments', {
      kind: 'cloud',
      label: 'x',
      connection: { repoUrls: [], network: 'on' },
    });
    expect(networked.status).toBe(400);
    expect(networked.body.error.details.reason).toBe('cloud_network_off');
    // Review finding 5: no credentials in a repository URL.
    const cred = await r('POST', '/api/v1/environments', {
      kind: 'cloud',
      label: 'x',
      connection: { repoUrls: ['https://u:ghp_secret@git.example/x.git'] },
    });
    expect(cred.status).toBe(400);
    expect(cred.raw).not.toContain('ghp_secret');
  });
});

const MODES = [
  ['a real runner (bubblewrap)', false],
  ['the runner with a host test double', true],
] as const;

describe.each(MODES)('a Code session on %s', (_name, host) => {
  it.skipIf(!host && realReason)(
    'runs its commands there, meters them, and frees the lease when archived',
    { timeout: 60_000 },
    async () => {
      const e = await env({ host });
      const r = req(e);
      makeRepo(join(dir, 'repos'), 'app', { 'README.md': 'hello\n' });
      expect(
        (await r('PUT', '/api/v1/cloud/runner', { url: e.url, token: e.token, enabled: true }))
          .status,
      ).toBe(200);
      const created = await r('POST', '/api/v1/environments', {
        kind: 'cloud',
        label: 'app (cloud)',
        connection: {
          repoUrls: [`file://${join(dir, 'repos', 'app')}`],
          setupScript: 'echo prepared > /workspace/app/.prepared',
          caches: ['npm'],
        },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        kind: 'cloud',
        connection: { kind: 'cloud', caches: ['npm'] },
      });
      const envId = created.body.id as string;
      const checked = await until(
        () => r('POST', `/api/v1/environments/${envId}/check`),
        (x) => x.body.status !== 'degraded' && x.body.status !== 'unknown',
      );
      expect(checked.body.status).toBe('ok');
      const listed = await r('GET', '/api/v1/cloud/environments');
      expect(listed.body.items[0]).toMatchObject({
        id: envId,
        runner: { status: 'ready', setup: { status: 'ok' }, repos: [{ path: '/workspace/app' }] },
      });
      const files = await r(
        'GET',
        `/api/v1/cloud/environments/${envId}/files?path=/workspace/app/README.md`,
      );
      expect(files.body).toMatchObject({ kind: 'file', text: 'hello\n' });

      const session = await r('POST', '/api/v1/code/sessions', {
        environmentId: envId,
        folder: '/workspace/app',
        title: 'cloud work',
      });
      expect(session.status, session.raw).toBe(201);
      const threadId = session.body.threadId as string;
      const sandbox = e.code.sandboxForThread(ACCOUNT, threadId)!;
      expect(sandbox.substrate).toBe('cloud');
      // J9 bug 3: on a Hub without a sandbox of its own, the session's tools check the sandbox
      // its commands go to (the runner); a local session on the same Hub is still refused.
      mkdirSync(join(dir, 'home', 'proj'), { recursive: true });
      const local = await r('POST', '/api/v1/code/sessions', { folder: join(dir, 'home', 'proj') });
      expect(local.status, local.raw).toBe(201);
      const routed = new ExecSessions(
        threadSandboxRouter(new UnavailableSandbox('No sandbox is available on this Hub'), (a, t) =>
          e.code.sandboxForThread(a, t),
        ),
      );
      const testRun = (await e.code.tools.list(ACCOUNT, { threadId, mode: 'code' })).find(
        (t) => t.descriptor.name === 'test.run',
      )!;
      const call = (tid: string) =>
        testRun.handler(
          {},
          {
            accountId: ACCOUNT,
            threadId: tid,
            turnId: 'turn-t',
            callId: 'c-t',
            projectId: null,
            origin: 'model',
            profile: { id: 'workspace', hash: 'h' },
            roots: [],
            sandbox: routed,
            signal: AbortSignal.timeout(20_000),
            log: new Logger({ module: 'test', sinks: [] }),
          },
        );
      const onCloud = await call(threadId);
      expect(onCloud.ok ? null : onCloud.error.code).not.toBe('sandbox_unavailable');
      const onHub = await call(local.body.threadId as string);
      expect(onHub).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
      await e.code.service.archive(ACCOUNT, local.body.id as string);
      // Review finding 4: the Hub's file tools are denied (hidden) in this thread.
      const rules = await e.cloud.toolRules(null).forThread(ACCOUNT, threadId);
      expect(rules?.rules[0]).toMatchObject({
        effect: 'deny',
        match: { tool: expect.arrayContaining(['fs.read', 'fs.write']) },
      });
      expect(await e.cloud.toolRules(null).forThread(ACCOUNT, 'not-cloud')).toBeNull();
      const out = await sandbox.exec({
        cmd: 'cat .prepared README.md; echo changed >> README.md',
        cwd: '/workspace/app',
        roots: [{ path: '/workspace/app', access: 'write', label: 'app' }],
        network: 'off',
        yieldMs: 15_000,
        signal: AbortSignal.timeout(30_000),
        turnId: 'turn-1',
        owner: { accountId: ACCOUNT, threadId },
      } as Parameters<typeof sandbox.exec>[0]);
      expect(out).toEqual({ status: 'exited', exitCode: 0, output: 'prepared\nhello\n' });

      const leases = await r('GET', `/api/v1/cloud/runs?threadId=${threadId}`);
      expect(leases.body.items).toHaveLength(1);
      const lease = leases.body.items[0];
      expect(lease).toMatchObject({ kind: 'code', status: 'active', threadId });
      const metered = await until(
        () => r('GET', `/api/v1/cloud/runs/${lease.id}`),
        (x) => x.body.usage.commands >= 1,
      );
      expect(metered.body.caps).toEqual({ cpuSeconds: 3600, wallSeconds: 14400 });
      const processes = await r('GET', `/api/v1/environments/${envId}/processes`);
      expect(
        processes.body.items.some((p: { sessionId: string }) => p.sessionId === session.body.id),
      ).toBe(true);

      // Hub-side change capture runs its Git through the cloud transport.
      // (J9: the host double once left GIT_WORK_TREE unmapped, "Invalid path '/workspace'".)
      await e.code.service.refresh(ACCOUNT, session.body.id);
      const changes = await r('GET', `/api/v1/code/sessions/${session.body.id}/changes`);
      expect(changes.status, changes.raw).toBe(200);
      expect(JSON.stringify(changes.body.items)).toContain('README.md');

      const snap = await r('POST', `/api/v1/cloud/environments/${envId}/snapshots`, {
        label: 'now',
      });
      expect(snap.status).toBe(201);
      expect(
        (await r('GET', `/api/v1/cloud/environments/${envId}/snapshots`)).body.items,
      ).toHaveLength(1);

      // A Work run on the same environment (the runs area stubbed).
      const started: string[] = [];
      const runs: CloudWorkRuns = {
        create: () => Promise.resolve({ id: 'run-1', threadId: 'work-thread' }),
        start: (_a, id) => {
          started.push(id);
          return Promise.resolve(null);
        },
      };
      e.cloud.useRuns(runs);
      const work = await r('POST', '/api/v1/cloud/work', {
        environmentId: envId,
        objective: 'run the tests',
        snapshot: false,
      });
      expect(work.status, work.raw).toBe(201);
      expect(work.body).toMatchObject({ runId: 'run-1', threadId: 'work-thread', snapshot: null });
      expect(started).toEqual(['run-1']);
      expect(e.cloud.sandboxForThread(ACCOUNT, 'work-thread')?.substrate).toBe('cloud');

      // Removing the environment waits for its sessions; archiving frees the lease.
      expect((await r('DELETE', `/api/v1/environments/${envId}`)).status).toBe(409);
      await e.code.service.archive(ACCOUNT, session.body.id);
      expect(await e.cloud.service.sweep()).toBeGreaterThanOrEqual(1);
      expect((await r('GET', `/api/v1/cloud/runs/${lease.id}`)).body.status).toBe('completed');
      expect((await r('DELETE', `/api/v1/environments/${envId}`)).status).toBe(204);
      expect((await r('GET', '/api/v1/cloud/environments')).body.items).toEqual([]);
      expect(e.audit.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'environment.created',
          'cloud.run.start',
          'cloud.snapshot.create',
          'cloud.work.start',
          'cloud.environment.remove',
        ]),
      );
    },
  );
});
