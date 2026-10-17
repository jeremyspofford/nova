// Settings → Diagnostics tests (FR-119): POST /diagnostics/test for providers (a tiny request
// held to one account), MCP servers (connection and tool list), the sandbox (a command run in
// it), storage (write/read/delete and an integrity check) and updates. The area is built on its
// own with fakes for the parts later areas provide, then once more inside a real Hub with the
// Mock provider. Also the audit export's shape (FR-104).
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError } from '@nova/shared';
import {
  DirectRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  type ExecResult,
  type SandboxClient,
} from '@nova/core';
import { MockProvider, type Provider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupOps, type HubOpsArea, type McpDiagnosticsSource } from '../src/ops.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000aa';
const AUTH = { 'x-test-account': ACCOUNT };
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

let dir: string;
let db: NovaDatabase;
let config: HubConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-diag-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  mkdirSync(config.dataDir, { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A provider whose model list or stream misbehaves, by account label. */
function providerFor(label: string, id: string): Provider {
  switch (label) {
    case 'Broken':
      return new MockProvider({
        id,
        timing: 'instant',
        failWith: { code: 'auth_expired', message: `key ${SECRET} was refused` },
      });
    case 'Offline': {
      const p = new MockProvider({ id, timing: 'instant' });
      p.listModels = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:11434'));
      return p;
    }
    case 'Empty':
      return new MockProvider({ id, timing: 'instant', models: [] });
    case 'Hangs': {
      const p = new MockProvider({ id, timing: 'instant' });
      p.stream = async function* (_req, _ctx) {
        await new Promise(() => undefined);
        yield { type: 'stop', reason: 'end' };
      };
      return p;
    }
    default:
      return new MockProvider({ id, timing: 'instant' });
  }
}

interface AreaEnv {
  app: FastifyInstance;
  area: HubOpsArea;
  registry: ProviderRegistry;
}

async function areaEnv(timeoutMs = 2_000): Promise<AreaEnv> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const registry = new ProviderRegistry({
    db,
    secrets,
    factory: ({ row }) => providerFor(row.label, row.id),
  });
  const router = new DirectRouter(registry);
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
    threads: new ThreadService({ db, router, events }),
    setting: (key: string) =>
      Promise.resolve(
        key === 'notifications.categories'
          ? { approval: true, completion: true, error: true, attention: true, system: true }
          : null,
      ),
    accountOf: (req: { headers: Record<string, unknown> }) => {
      if (req.headers['x-test-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const area = await setupOps(ctx, { diagnosticTimeoutMs: timeoutMs });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return { app, area, registry };
}

let e: AreaEnv | undefined;
afterEach(async () => {
  if (!e) return;
  await e.app.close();
  await e.area.close();
  e = undefined;
});

const test = (body: Record<string, unknown>, headers: Record<string, string> = AUTH) =>
  e!.app.inject({ method: 'POST', url: '/api/v1/diagnostics/test', headers, payload: body });

describe('POST /diagnostics/test (FR-119)', () => {
  it('requires a session and a known component', async () => {
    e = await areaEnv();
    expect((await test({ component: 'storage' }, {})).statusCode).toBe(401);
    expect((await test({ component: 'kernel' })).statusCode).toBe(400);
    expect((await test({})).statusCode).toBe(400);
  });

  it('tests every provider account with a tiny request, held to that account', async () => {
    e = await areaEnv(300);
    const ok = await e.registry.create(ACCOUNT, { provider: 'mock', label: 'Mock' });
    const broken = await e.registry.create(ACCOUNT, { provider: 'mock', label: 'Broken' });
    const offline = await e.registry.create(ACCOUNT, { provider: 'mock', label: 'Offline' });
    const empty = await e.registry.create(ACCOUNT, { provider: 'mock', label: 'Empty' });
    const hangs = await e.registry.create(ACCOUNT, { provider: 'mock', label: 'Hangs' });
    const res = await test({ component: 'provider' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      component: 'provider',
      ref: null,
      status: 'error',
      detail: '4 of 5 providers need attention.',
    });
    const by = (id: string) => body.checks.find((c: { ref: string }) => c.ref === id);
    expect(by(ok.id)).toMatchObject({ name: 'Mock', status: 'ok' });
    expect(by(ok.id).detail).toMatch(/^.+ answered in \d+ ms\.$/);
    expect(by(broken.id).status).toBe('error');
    expect(by(broken.id).detail).toContain('was refused');
    expect(res.body).not.toContain(SECRET);
    expect(by(offline.id)).toMatchObject({ status: 'error' });
    expect(by(offline.id).detail).toMatch(/ECONNREFUSED/);
    expect(by(empty.id)).toMatchObject({
      status: 'warning',
      detail: 'Connected, but it offers no models.',
    });
    expect(by(hangs.id)).toMatchObject({ status: 'error', detail: 'no answer within 300 ms' });

    const one = (await test({ component: 'provider', ref: ok.id })).json();
    expect(one).toMatchObject({ ref: ok.id, status: 'ok', checks: [{ ref: ok.id }] });
    expect(one.detail).toBe(one.checks[0].detail);
    expect(typeof one.durationMs).toBe('number');
    expect(Date.parse(one.testedAt)).not.toBeNaN();
    expect((await test({ component: 'provider', ref: 'nope' })).statusCode).toBe(404);
  });

  it('says when no provider is connected', async () => {
    e = await areaEnv();
    expect((await test({ component: 'provider' })).json()).toMatchObject({
      status: 'unavailable',
      detail: 'No providers are connected.',
      checks: [],
    });
  });

  it('tests MCP servers by their connection and tool list once wired', async () => {
    e = await areaEnv();
    expect((await test({ component: 'mcp' })).json()).toMatchObject({
      status: 'unavailable',
      detail: 'MCP is not set up on this Hub.',
    });
    const states: ReturnType<McpDiagnosticsSource['states']> = [];
    const tools: Record<string, string[]> = {
      s1: Array.from({ length: 10 }, (_, i) => `files.t${i}`),
      s5: [],
    };
    e.area.useDiagnosticTests({
      mcp: {
        states: (accountId) => (accountId === ACCOUNT ? states : []),
        tools: (id) => (tools[id] ?? []).map((name) => ({ descriptor: { name } })),
      },
    });
    expect((await test({ component: 'mcp' })).json()).toMatchObject({
      status: 'unavailable',
      detail: 'No MCP servers are set up.',
    });
    states.push(
      { id: 's1', name: 'files', status: 'connected', lastError: null },
      { id: 's2', name: 'mail', status: 'error', lastError: 'spawn ENOENT' },
      { id: 's3', name: 'off', status: 'disabled', lastError: null },
      { id: 's4', name: 'slow', status: 'starting', lastError: null },
      { id: 's5', name: 'bare', status: 'connected', lastError: null },
      { id: 's6', name: 'gone', status: 'stopped', lastError: null },
    );
    const all = (await test({ component: 'mcp' })).json();
    expect(all).toMatchObject({ status: 'error', detail: '5 of 6 servers need attention.' });
    expect(all.checks.map((c: { status: string; detail: string }) => [c.status, c.detail])).toEqual(
      [
        [
          'ok',
          'Connected; lists 10 tools: files.t0, files.t1, files.t2, files.t3, files.t4, files.t5, files.t6, files.t7 and 2 more.',
        ],
        ['error', 'spawn ENOENT'],
        ['unavailable', 'Turned off.'],
        ['warning', 'Still starting; test again in a moment.'],
        ['warning', 'Connected, but it lists no tools.'],
        ['error', 'Not connected.'],
      ],
    );
    expect((await test({ component: 'mcp', ref: 's1' })).json()).toMatchObject({
      status: 'ok',
      ref: 's1',
    });
    expect((await test({ component: 'mcp', ref: 'zz' })).statusCode).toBe(404);
  });

  it('runs a command in the sandbox and reports each way it can fail', async () => {
    e = await areaEnv(300);
    expect((await test({ component: 'sandbox' })).json()).toMatchObject({
      status: 'unavailable',
      detail: 'No sandbox is set up on this Hub.',
    });
    let available = { ok: false, detail: 'docker is installed but its engine is not running' };
    let next: () => Promise<ExecResult> = () =>
      Promise.resolve({ status: 'exited', exitCode: 0, output: '' });
    const exec = vi.fn((..._args: unknown[]) => next());
    const killTurn = vi.fn(() => Promise.resolve());
    const sandbox: SandboxClient = {
      substrate: 'container',
      available: () => Promise.resolve(available),
      exec: (req) => exec(req),
      poll: () => Promise.reject(new Error('unused')),
      write: () => Promise.resolve(),
      killTurn,
    };
    e.area.useDiagnosticTests({ sandbox: () => sandbox });
    expect((await test({ component: 'sandbox' })).json()).toMatchObject({
      status: 'unavailable',
      detail: 'docker is installed but its engine is not running',
    });
    available = { ok: true, detail: 'docker 27' };
    const ok = (await test({ component: 'sandbox' })).json();
    expect(ok.status).toBe('ok');
    expect(ok.detail).toMatch(/^Ran a command in the sandbox \(container\) in \d+ ms\.$/);
    expect(exec.mock.calls[0]![0]).toMatchObject({ cmd: 'true', roots: [], network: 'off' });

    next = () => Promise.resolve({ status: 'exited', exitCode: 2, output: `oops ${SECRET}` });
    const failed = await test({ component: 'sandbox' });
    expect(failed.json()).toMatchObject({ status: 'error' });
    expect(failed.json().detail).toMatch(/^The test command exited with code 2: oops /);
    expect(failed.body).not.toContain(SECRET);

    next = () => Promise.resolve({ status: 'running', sessionId: 'x', output: '' });
    expect((await test({ component: 'sandbox' })).json()).toMatchObject({
      status: 'error',
      detail: 'The test command did not finish.',
    });
    expect(killTurn).toHaveBeenCalledTimes(1);

    next = () => new Promise(() => undefined);
    expect((await test({ component: 'sandbox' })).json()).toMatchObject({
      status: 'error',
      detail: 'no answer within 300 ms',
    });
    expect(killTurn).toHaveBeenCalledTimes(2);
  });

  it('checks storage with a write, read and delete and an integrity check', async () => {
    e = await areaEnv();
    const r = (await test({ component: 'storage' })).json();
    expect(r.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
      ['Data folder', 'ok'],
      ['Database', 'ok'],
      ['Free space', expect.stringMatching(/^(ok|warning)$/)],
    ]);
    expect(r.checks[1].detail).toBe('Passed its integrity check.');
    // The test file is gone.
    expect(readdirSync(config.dataDir).filter((f) => f.startsWith('.diagnostics-'))).toEqual([]);
  });

  it('reports a data folder it cannot write to', async () => {
    e = await areaEnv();
    rmSync(config.dataDir, { recursive: true, force: true });
    const r = (await test({ component: 'storage' })).json();
    expect(r.status).toBe('error');
    expect(r.checks[0]).toMatchObject({ name: 'Data folder', status: 'error' });
    expect(r.detail).toMatch(/^Data folder: .*ENOENT/);
  });

  it('says there is no update channel yet', async () => {
    e = await areaEnv();
    expect((await test({ component: 'update' })).json()).toMatchObject({
      component: 'update',
      status: 'unavailable',
      detail: `No update channel is configured. This Hub runs version ${config.version}.`,
    });
  });
});

// ---- in a real Hub: the Mock provider through the full router, and the audit export ----------

describe('in a real Hub (FR-119, FR-104)', () => {
  let hub: Hub;
  let auth: Record<string, string>;
  const HOST = { host: '127.0.0.1:7419' };

  beforeEach(async () => {
    hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      secrets: new MemorySecretStore(),
      chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    });
    const code = await hub.auth.issueSetupCode();
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code, displayName: 'Owner' },
    });
    auth = {
      ...HOST,
      authorization: `Bearer ${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`,
    };
  });
  afterEach(async () => {
    await hub.app.close();
  });

  const post = (url: string, payload: unknown) =>
    hub.app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: payload as Record<string, unknown>,
    });

  it('tests the default Mock provider and storage through the real stack', async () => {
    const providers = (
      await hub.app.inject({ method: 'GET', url: '/api/v1/providers', headers: auth })
    ).json();
    expect(providers.items.length).toBeGreaterThan(0);
    const r = (await post('/api/v1/diagnostics/test', { component: 'provider' })).json();
    expect(r).toMatchObject({ component: 'provider', status: 'ok' });
    expect(r.detail).toMatch(/answered in \d+ ms/);
    expect(
      (await post('/api/v1/diagnostics/test', { component: 'storage' })).json().checks[1],
    ).toMatchObject({
      name: 'Database',
      status: 'ok',
    });
  });

  it('exports tool calls as redacted JSON lines with actor, tool, input hash, decision, result and time', async () => {
    const t = await post('/api/v1/threads', { title: 'Audit' });
    const threadId = t.json().id as string;
    const call = await post('/api/v1/tools/tool.search/invoke', {
      args: { query: `find ${SECRET}` },
      threadId,
      initiator: 'user',
    });
    expect(call.statusCode).toBe(200);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const exp = await hub.app.inject({ method: 'GET', url: '/api/v1/audit/export', headers: auth });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toMatch(/application\/x-ndjson/);
    expect(exp.body).not.toContain(SECRET);
    const lines = exp.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const entry = lines.find((l) => l.kind === 'tool_call')!;
    // FR-104: actor, tool (the action of a tool_call entry), inputs hash, decision, result and
    // timestamp, plus the hash chain so the export can be verified offline.
    expect(entry).toMatchObject({
      actor: 'user',
      kind: 'tool_call',
      action: 'tool.search',
      decision: 'allow',
      result: 'ok',
      threadId,
    });
    expect(entry.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(String(entry.ts))).not.toBeNaN();
    expect(entry.hash).toEqual(expect.any(String));
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining([
        'id',
        'seq',
        'ts',
        'actor',
        'kind',
        'action',
        'resource',
        'inputHash',
        'decision',
        'result',
        'prevHash',
        'hash',
      ]),
    );
    // Inputs themselves are never exported, only their hash.
    expect(JSON.stringify(entry)).not.toContain('find ');
  });
});
