// `test.run` in a cloud Code session (J9 follow-up, docs/10 §4): the project's test command is
// detected from the marker files in the session's folder on the runner (through the cloud
// transport), not on the Hub's own disk where that folder does not exist, and runs there. The
// runner uses its host test double as the sandbox, so this runs on any machine.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  type SettingKey,
} from '@nova/shared';
import {
  DirectRouter,
  ExecSessions,
  NodeService,
  ProviderRegistry,
  ThreadService,
  UnavailableSandbox,
  threadSandboxRouter,
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
import { makeRepo } from '../../../services/runner/test/env.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c8';
const AUTH = { 'x-test-account': ACCOUNT };

let dir: string;
let db: NovaDatabase;
let open: { app: FastifyInstance; code: CodeArea; cloud: CloudRunArea; runner: RunnerServer }[] =
  [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-testrun-'));
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

afterEach(async () => {
  for (const e of open) {
    await e.app.close();
    await e.cloud.close();
    await e.code.close();
    await e.runner.close();
  }
  open = [];
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it(
  'detects and runs the test command of a cloud session through its transport',
  { timeout: 60_000 },
  async () => {
    const token = newRunnerToken();
    const runner = await buildRunnerServer({
      dataDir: join(dir, 'runner'),
      tokens: [tokenRecord(tokenHash(token))],
      localRepoRoots: [join(dir, 'repos')],
      log: silentLog,
      limits: { meterIntervalMs: 50, diskIntervalMs: 100 },
      substrate: new HostSubstrate(),
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
    const setting = (key: SettingKey) => {
      const rows = db.raw
        .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
        .all() as { key: string; value_json: string }[];
      const global: Record<string, unknown> = {};
      for (const r of rows) global[r.key] = JSON.parse(r.value_json) as unknown;
      return Promise.resolve(resolveSetting(key, { global, project: {}, managed: {} }).value);
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
    const sink = { append: () => Promise.resolve() };
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
        return reply.status(400).send({ error: { code: 'validation' } });
      return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
    });
    code.register(app);
    cloud.register(app);
    await app.ready();
    open.push({ app, code, cloud, runner });
    const r = async (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) => {
      const res = await app.inject({
        method,
        url: path,
        headers: AUTH,
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
      return {
        status: res.statusCode,
        body: res.body ? res.json<Record<string, unknown>>() : {},
      };
    };

    makeRepo(join(dir, 'repos'), 'app', {
      'package.json': JSON.stringify({ scripts: { test: 'echo cloud-tests-ran' } }),
      'README.md': 'hello\n',
    });
    expect((await r('PUT', '/api/v1/cloud/runner', { url, token, enabled: true })).status).toBe(
      200,
    );
    const created = await r('POST', '/api/v1/environments', {
      kind: 'cloud',
      label: 'app (cloud)',
      connection: { repoUrls: [`file://${join(dir, 'repos', 'app')}`] },
    });
    expect(created.status).toBe(201);
    const envId = created.body.id as string;
    const end = Date.now() + 30_000;
    for (;;) {
      const c = await r('POST', `/api/v1/environments/${envId}/check`);
      if (c.body.status === 'ok') break;
      if (Date.now() > end) throw new Error(`environment not ready: ${JSON.stringify(c.body)}`);
      await new Promise((res) => setTimeout(res, 50));
    }
    const session = await r('POST', '/api/v1/code/sessions', {
      environmentId: envId,
      folder: '/workspace/app',
    });
    expect(session.status).toBe(201);
    const threadId = session.body.threadId as string;
    // The folder exists only on the runner: the Hub's own disk has no /workspace/app.
    expect(existsSync('/workspace/app/package.json')).toBe(false);
    const testRun = (await code.tools.list(ACCOUNT, { threadId, mode: 'code' })).find(
      (t) => t.descriptor.name === 'test.run',
    )!;
    const routed = new ExecSessions(
      threadSandboxRouter(new UnavailableSandbox('No sandbox is available on this Hub'), (a, t) =>
        code.sandboxForThread(a, t),
      ),
    );
    const result = await testRun.handler(
      {},
      {
        accountId: ACCOUNT,
        threadId,
        turnId: 'turn-t',
        callId: 'c-t',
        projectId: null,
        origin: 'model',
        profile: { id: 'workspace', hash: 'h' },
        roots: [],
        sandbox: routed,
        signal: AbortSignal.timeout(50_000),
        log: new Logger({ module: 'test', sinks: [] }),
      },
    );
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    expect(result.ok && result.meta).toMatchObject({ command: 'npm test', status: 'passed' });
    const text = result.ok
      ? result.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
      : '';
    expect(text).toContain('cloud-tests-ran');
  },
);
