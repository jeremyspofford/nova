// Exec session routes (FR-184, docs/10 §6): GET /api/v1/exec/sessions lists the account's
// running agent commands (optionally one thread's) for the terminal pane; DELETE kills one.
// Both need a session and are account-scoped; the kill is audited. Also: the area gives exec
// tools the `exec.sessions` settings and registers the context tools (FR-183).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError } from '@nova/shared';
import {
  DirectRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  allowAllGate,
  noopNotifier,
  type AuditRecord,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupTools, type ToolsArea } from '../src/tools.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000aa';
const OTHER = '01920000-0000-7000-8000-0000000000bb';
const AUTH = { 'x-test-account': ACCOUNT };
const AUTH_OTHER = { 'x-test-account': OTHER };

/** Commands starting with `serve` keep running; the rest exit at once. */
class FakeSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly requests: ExecRequest[] = [];
  readonly terminated: string[] = [];
  #n = 0;
  available() {
    return Promise.resolve({ ok: true, detail: 'fake' });
  }
  exec(req: ExecRequest): Promise<ExecResult> {
    this.requests.push(req);
    if (req.cmd.startsWith('serve'))
      return Promise.resolve({ status: 'running', sessionId: `s${++this.#n}`, output: 'up\n' });
    return Promise.resolve({ status: 'exited', exitCode: 0, output: 'x'.repeat(10_000) });
  }
  poll(sessionId: string): Promise<ExecResult> {
    return Promise.resolve({ status: 'running', sessionId, output: '' });
  }
  write(sessionId: string, input: { signal?: string }): Promise<void> {
    if (input.signal === 'terminate') this.terminated.push(sessionId);
    return Promise.resolve();
  }
  killTurn(): Promise<void> {
    return Promise.resolve();
  }
}

let dir: string;
let db: NovaDatabase;
let config: HubConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-exec-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(id, now, now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface AreaEnv {
  app: FastifyInstance;
  area: ToolsArea;
  audit: AuditRecord[];
  threads: ThreadService;
  sandbox: FakeSandbox;
  settings: Record<string, unknown>;
}

async function areaEnv(): Promise<AreaEnv> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const registry = new ProviderRegistry({ db, secrets });
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
  const settings: Record<string, unknown> = {};
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
    setting: (key: string) => {
      const defaults: Record<string, unknown> = {
        'search.searxngUrl': null,
        'tools.permissionProfile': 'workspace',
        'tools.roots': [],
        'tools.deferBudget': { tools: 40, schemaTokens: 8000 },
      };
      return Promise.resolve(key in settings ? settings[key] : defaults[key]);
    },
    accountOf: (req: { headers: Record<string, unknown> }) => {
      const id = req.headers['x-test-account'];
      if (id !== ACCOUNT && id !== OTHER)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(id);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const audit: AuditRecord[] = [];
  const sandbox = new FakeSandbox();
  const area = await setupTools({
    ...ctx,
    gate: allowAllGate,
    sources: [],
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    notifier: noopNotifier,
    sandbox,
    invokeWaitMs: 2_000,
  });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return { app, area, audit, threads, sandbox, settings };
}

describe('exec session routes', () => {
  let e: AreaEnv;
  afterEach(async () => {
    await e.app.close();
    await e.area.close();
  });

  async function serve(threadId: string, cmd = 'serve --port 5173') {
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/exec.run/invoke',
      headers: AUTH,
      payload: { args: { cmd }, threadId, initiator: 'user' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('Still running');
  }

  it('require a session', async () => {
    e = await areaEnv();
    for (const [method, url] of [
      ['GET', '/api/v1/exec/sessions'],
      ['DELETE', '/api/v1/exec/sessions/s1'],
    ] as const) {
      const res = await e.app.inject({ method, url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("list the account's running sessions, one thread's on request", async () => {
    e = await areaEnv();
    const a = await e.threads.create(ACCOUNT, {});
    const b = await e.threads.create(ACCOUNT, {});
    await serve(a.id);
    await serve(b.id, 'serve api');
    const all = await e.app.inject({ method: 'GET', url: '/api/v1/exec/sessions', headers: AUTH });
    expect(all.json().items).toHaveLength(2);
    const one = await e.app.inject({
      method: 'GET',
      url: `/api/v1/exec/sessions?threadId=${a.id}`,
      headers: AUTH,
    });
    expect(one.json().items).toEqual([
      expect.objectContaining({
        id: 's1',
        threadId: a.id,
        cmd: 'serve --port 5173',
        retained: false,
      }),
    ]);
    // Another account sees none, and cannot name this account's thread.
    const other = await e.app.inject({
      method: 'GET',
      url: '/api/v1/exec/sessions',
      headers: AUTH_OTHER,
    });
    expect(other.json().items).toEqual([]);
    const foreign = await e.app.inject({
      method: 'GET',
      url: `/api/v1/exec/sessions?threadId=${a.id}`,
      headers: AUTH_OTHER,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('kill one session of the account, audited', async () => {
    e = await areaEnv();
    const t = await e.threads.create(ACCOUNT, {});
    await serve(t.id);
    const denied = await e.app.inject({
      method: 'DELETE',
      url: '/api/v1/exec/sessions/s1',
      headers: AUTH_OTHER,
    });
    expect(denied.statusCode).toBe(404);
    const res = await e.app.inject({
      method: 'DELETE',
      url: '/api/v1/exec/sessions/s1',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(e.sandbox.terminated).toEqual(['s1']);
    expect(e.area.execSessions.list(ACCOUNT)).toEqual([]);
    expect(e.audit.find((a) => a.action === 'exec.session.kill')).toMatchObject({
      accountId: ACCOUNT,
      actor: 'user',
      result: 'killed',
      threadId: t.id,
    });
    const again = await e.app.inject({
      method: 'DELETE',
      url: '/api/v1/exec/sessions/s1',
      headers: AUTH,
    });
    expect(again.statusCode).toBe(404);
  });

  it('give exec tools the exec.sessions settings and register the context tools', async () => {
    e = await areaEnv();
    e.settings['exec.sessions'] = { yieldMs: 1_500, outputTokens: 500 };
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/exec.run/invoke',
      headers: AUTH,
      payload: { args: { cmd: 'build' }, initiator: 'user' },
    });
    expect(e.sandbox.requests[0]!.yieldMs).toBe(1_500);
    expect((res.json().text as string).length).toBeLessThan(2_100);
    const tools = await e.app.inject({ method: 'GET', url: '/api/v1/tools', headers: AUTH });
    const names = (tools.json().items as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['context.remaining', 'context.fresh']));
    // The chat loop gets the tracker the context tools read, and the settings it needs.
    const loop = e.area.loopOptions;
    expect(loop.context?.tracker).toBeDefined();
    expect(loop.audit).toBeDefined();
    e.settings['context.compactThreshold'] = 0.6;
    expect(await loop.context?.compactThreshold?.(null)).toBe(0.6);
    e.settings['instructions.files'] = {
      rootMarkers: ['.hg'],
      fallbackNames: [],
      budgetBytes: 2048,
    };
    expect(await loop.context?.instructionFiles?.()).toMatchObject({ budgetBytes: 2048 });
    expect(await loop.context?.projectFolders?.('p1')).toEqual([]);
  });
});
