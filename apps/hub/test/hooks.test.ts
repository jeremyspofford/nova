// Hooks routes (FR-197; contracts/hub-api.md "Permissions, rules & hooks"): auth, listing from
// the user hooks file, trust by hash with the 409 race, revoke, switch and delete (user hooks
// only), the plugin registration the plugins area uses, the MCP adapter and the diagnostics probe.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  type HookView,
  type SettingKey,
  type ToolDescriptor,
} from '@nova/shared';
import type { AuditRecord } from '@nova/core';
import type { McpManager } from '@nova/mcp';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { mcpForHooks, setupHooks, type HooksArea } from '../src/hooks.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const AUTH = { 'x-account': ACCOUNT };

let dir: string;
let data: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: HooksArea;
let events: EventStore;
let audit: AuditRecord[];
let diagnostics: DiagnosticsRegistry;
let managed: unknown;

const hook = (id: string, event = 'tool.pre') => ({
  id,
  event,
  handler: { type: 'command', command: ['node', 'check.mjs'] },
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-hooks-'));
  data = join(dir, 'data');
  mkdirSync(join(data, 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  events = new EventStore(db);
  audit = [];
  diagnostics = new DiagnosticsRegistry();
  managed = undefined;
  const ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: {} as never,
    dataDir: data,
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {} as never,
    setting: (key: SettingKey) => Promise.resolve(SETTINGS[key].default as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics,
    audit: { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) },
    managedHooks: () => managed,
  } as unknown as Parameters<typeof setupHooks>[0];
  area = await setupHooks(ctx);
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
  await area.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: AUTH,
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });

const list = async () => (await call('GET', '/api/v1/hooks')).json<{ items: HookView[] }>().items;

describe('hooks routes', () => {
  it('requires a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/hooks'],
      ['PATCH', '/api/v1/hooks/x'],
      ['DELETE', '/api/v1/hooks/x'],
      ['POST', '/api/v1/hooks/x/trust'],
      ['POST', '/api/v1/hooks/x/untrust'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lists, trusts by hash and revokes', async () => {
    writeFileSync(join(data, 'hooks.json'), JSON.stringify({ hooks: [hook('guard')] }));
    managed = { hooks: [hook('org')] };
    const items = await list();
    expect(items.map((h) => [h.source, h.status])).toEqual([
      ['managed', 'trusted'],
      ['user', 'needs_trust'],
    ]);
    const user = items[1]!;
    const stale = await call('POST', `/api/v1/hooks/${user.id}/trust`, {
      contentHash: 'sha256:0000',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'conflict' } });
    expect((await call('POST', `/api/v1/hooks/${user.id}/trust`, {})).statusCode).toBe(400);
    const ok = await call('POST', `/api/v1/hooks/${user.id}/trust`, {
      contentHash: user.contentHash,
    });
    expect(ok.json()).toMatchObject({ id: user.id, status: 'trusted' });
    const persisted = await events.since(null, 100);
    expect(persisted.filter((e) => e.name === 'hook.trust.changed').at(-1)?.payload).toEqual({
      hookId: user.id,
      status: 'trusted',
    });
    expect(audit.some((a) => a.action === 'hook.trust')).toBe(true);
    const revoked = await call('POST', `/api/v1/hooks/${user.id}/untrust`);
    expect(revoked.json()).toMatchObject({ status: 'revoked' });
    const managedRevoke = await call('POST', `/api/v1/hooks/${items[0]!.id}/untrust`);
    expect(managedRevoke.statusCode).toBe(403);
    expect((await call('POST', '/api/v1/hooks/missing/untrust')).statusCode).toBe(404);
  });

  it('switches and deletes user hooks only', async () => {
    writeFileSync(join(data, 'hooks.json'), JSON.stringify({ hooks: [hook('guard')] }));
    const plugin = await area.registerPluginHooks(ACCOUNT, {
      pluginId: 'com.example.dev',
      root: dir,
      hooks: [hook('lint', 'tool.post')],
    });
    expect(plugin.items[0]).toMatchObject({ pluginId: 'com.example.dev', status: 'needs_trust' });
    const user = (await list()).find((h) => h.source === 'user')!;
    expect((await call('PATCH', `/api/v1/hooks/${user.id}`, { enabled: 'no' })).statusCode).toBe(
      400,
    );
    const off = await call('PATCH', `/api/v1/hooks/${user.id}`, { enabled: false });
    expect(off.json()).toMatchObject({ enabled: false, status: 'disabled' });
    expect(
      (await call('PATCH', `/api/v1/hooks/${plugin.items[0]!.id}`, { enabled: false })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/api/v1/hooks/${plugin.items[0]!.id}`)).statusCode).toBe(403);
    expect((await call('DELETE', `/api/v1/hooks/${user.id}`)).json()).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(data, 'hooks.json'), 'utf8'))).toEqual({ hooks: [] });
    await area.setPluginHooksEnabled(ACCOUNT, 'com.example.dev', false);
    expect((await list()).map((h) => h.status)).toEqual(['disabled']);
    await area.removePluginHooks(ACCOUNT, 'com.example.dev');
    expect(await list()).toEqual([]);
    expect(
      area.previewPluginHooks({ pluginId: 'x', root: dir, hooks: [hook('a')] }).items[0]?.id,
    ).toBe('hook:x.a');
  });

  it('reports itself in diagnostics', async () => {
    writeFileSync(join(data, 'hooks.json'), '{ broken');
    await list();
    const d = (await diagnostics.collect()).hooks as {
      available: boolean;
      unreadable: Record<string, string>;
    };
    expect(d.available).toBe(true);
    expect(d.unreadable.user).toMatch(/not valid JSON/);
  });

  it('dispatches a command hook through the sandbox it was given', async () => {
    writeFileSync(join(data, 'hooks.json'), JSON.stringify({ hooks: [hook('guard')] }));
    const [h] = await list();
    await call('POST', `/api/v1/hooks/${h!.id}/trust`, { contentHash: h!.contentHash });
    let stdin = '';
    area.useSandbox({
      substrate: 'container',
      available: () => Promise.resolve({ ok: true, detail: 'fake' }),
      exec: () => Promise.resolve({ status: 'running', sessionId: 's1', output: '' }),
      write: (_id, input) => {
        stdin += input.text ?? '';
        return Promise.resolve();
      },
      poll: () =>
        Promise.resolve({
          status: 'exited',
          exitCode: 0,
          output: '{"block":{"reason":"not here"}}',
        }),
      killTurn: () => Promise.resolve(),
    });
    const tool: ToolDescriptor = {
      name: 'exec.run',
      title: 'Run',
      description: 'Run',
      source: 'builtin',
      inputSchema: { type: 'object' },
    };
    const out = await area.dispatcher.dispatch(
      'tool.pre',
      { accountId: ACCOUNT, threadId: 't1', turnId: 'u1', projectId: null, tool, args: {} },
      new AbortController().signal,
    );
    expect(out.block?.reason).toBe('not here');
    expect(JSON.parse(stdin)).toMatchObject({ event: 'tool.pre', tool: 'exec.run' });
    expect((await events.since(null, 100)).map((e) => e.name)).toContain('hook.blocked');
  });
});

describe('MCP adapter', () => {
  it('finds exposed tools by canonical name and calls them on their server', async () => {
    const descriptor: ToolDescriptor = {
      name: 'mcp:guard.check',
      title: 'check',
      description: '',
      source: 'mcp',
      serverId: 'srv1',
      inputSchema: { type: 'object' },
    };
    const calls: unknown[] = [];
    const manager = {
      exposedTools: () => [{ serverId: 'srv1', original: 'check', descriptor, exposed: true }],
      callTool: (...args: unknown[]) => {
        calls.push(args.slice(0, 3));
        return Promise.resolve({ ok: true, content: [] });
      },
    } as unknown as McpManager;
    const client = mcpForHooks(manager);
    expect(client.find(ACCOUNT, 'mcp:guard.check')).toBe(descriptor);
    expect(client.find(ACCOUNT, 'mcp:guard.other')).toBeNull();
    const signal = new AbortController().signal;
    await client.call(ACCOUNT, 'mcp:guard.check', { a: 1 }, { signal, timeoutMs: 1000 });
    expect(calls).toEqual([['srv1', 'check', { a: 1 }]]);
    const missing = await client.call(ACCOUNT, 'mcp:x.y', {}, { signal, timeoutMs: 1000 });
    expect(missing).toMatchObject({ ok: false, error: { code: 'mcp.tool_not_found' } });
  });
});

describe('in the real Hub', () => {
  let hub: Hub;
  let hubDir: string;
  let hubDb: NovaDatabase;
  const HOST = { host: '127.0.0.1:7419' };

  beforeEach(async () => {
    hubDir = mkdtempSync(join(tmpdir(), 'nova-hub-hooks-real-'));
    const web = join(hubDir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html>');
    mkdirSync(join(hubDir, 'data'), { recursive: true });
    writeFileSync(join(hubDir, 'data', 'hooks.json'), JSON.stringify({ hooks: [hook('guard')] }));
    hubDb = openDatabase({ path: ':memory:' });
    await migrate(hubDb);
    hub = await buildHub({
      config: loadConfig({ NOVA_DATA_DIR: join(hubDir, 'data'), NOVA_WEB_DIR: web }, []),
      db: hubDb,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    });
  });
  afterEach(async () => {
    await hub.app.close();
    hubDb.close();
    rmSync(hubDir, { recursive: true, force: true });
  });

  it('serves the user hooks file to a signed-in owner only', async () => {
    expect((await hub.app.inject({ url: '/api/v1/hooks', headers: HOST })).statusCode).toBe(401);
    const code = await hub.auth.issueSetupCode();
    const setup = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code },
    });
    const cookie = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const headers = { ...HOST, cookie: `${SESSION_COOKIE}=${cookie}` };
    const res = await hub.app.inject({ url: '/api/v1/hooks', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: HookView[] }>().items).toMatchObject([
      { source: 'user', status: 'needs_trust', event: 'tool.pre' },
    ]);
  });
});
