// M3 memory consolidation through the Hub API (FR-204, FR-205): auth on every route, input
// validation, consolidate-now, run history, the summary, topic preferences, the past-chats
// toggle wiring, events, and the background schedule.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSetting, type SettingKey } from '@nova/shared';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { setupConsolidation } from '../src/consolidation.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const HOST = { host: '127.0.0.1:7419' };

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let config: HubConfig;
let auth: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-m3-memory-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const mock = new MockProvider({ id: 'mock', timing: 'instant' });
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
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
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers = auth) => hub.app.inject({ method: 'GET', url, headers });
const send = (method: 'POST' | 'PATCH', url: string, payload?: unknown, headers = auth) =>
  hub.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function say(text: string, body: object = {}): Promise<string> {
  const t = await send('POST', '/api/v1/threads', body);
  expect(t.statusCode).toBe(201);
  const id = t.json<{ id: string }>().id;
  expect((await send('POST', `/api/v1/threads/${id}/messages`, { text })).statusCode).toBe(202);
  await hub.chat.idle();
  return id;
}

/** Chats become idle for consolidation once their last activity is old enough. */
const ageChats = () =>
  db.raw.prepare("UPDATE message SET updated_at = '2000-01-01T00:00:00.000Z'").run();

const runs = async () =>
  (await get('/api/v1/memory/consolidations')).json<{
    items: { phase: string; status: string; threadsScanned: number; itemsCreated: number }[];
  }>().items;

describe('memory consolidation routes (FR-204)', () => {
  it.each([
    ['GET', '/api/v1/memory/summary'],
    ['POST', '/api/v1/memory/consolidate'],
    ['GET', '/api/v1/memory/consolidations'],
    ['GET', '/api/v1/memory/topics'],
    ['PATCH', '/api/v1/memory/topics'],
  ])('%s %s requires a session', async (method, url) => {
    const res = await hub.app.inject({ method: method as 'GET', url, headers: HOST });
    expect(res.statusCode).toBe(401);
  });

  it('consolidates now in the background and serves runs and the summary', async () => {
    expect((await get('/api/v1/memory/summary')).json()).toEqual({
      scopeKind: 'global',
      scopeRef: null,
      summary: null,
      summaryTokens: 0,
      runId: null,
      updatedAt: null,
    });
    await say('My name is Ann. I work at Acme.');
    await say('I am flying to Lisbon on 2026-01-10.');
    ageChats();
    const res = await send('POST', '/api/v1/memory/consolidate');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ phase: 'extract', status: 'running', scopeKind: 'global' });
    await expect
      .poll(async () => (await runs()).map((r) => [r.phase, r.status]))
      .toEqual([
        ['consolidate', 'completed'],
        ['extract', 'completed'],
      ]);
    const [consolidate, extract] = await runs();
    expect(extract!.threadsScanned).toBe(2);
    // Stated facts were saved after each turn; the dated plan is new.
    expect(consolidate!.itemsCreated).toBe(1);
    const summary = (await get('/api/v1/memory/summary?scope=global')).json<{
      summary: string;
      summaryTokens: number;
    }>();
    expect(summary.summary).toContain("The user's name is Ann.");
    expect(summary.summary).toContain('Lisbon on 2026-01-10. (past event)');
    expect(summary.summaryTokens).toBeLessThanOrEqual(2_500);
    const events = (await get('/api/v1/events?limit=500')).json<{
      events: { name: string; payload: Record<string, unknown> }[];
    }>().events;
    expect(
      events.filter((e) => e.name === 'memory.consolidated').map((e) => e.payload.phase),
    ).toEqual(['extract', 'consolidate']);
  });

  it('validates scopes and bodies', async () => {
    expect(
      (await send('POST', '/api/v1/memory/consolidate', { scopeKind: 'project' })).statusCode,
    ).toBe(400);
    const missing = await send('POST', '/api/v1/memory/consolidate', {
      scopeKind: 'project',
      scopeRef: '01920000-0000-7000-8000-00000000dead',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details.reason).toBe('project');
    expect((await send('POST', '/api/v1/memory/consolidate', { nope: 1 })).statusCode).toBe(400);
    expect((await get('/api/v1/memory/summary?scope=team')).statusCode).toBe(400);
    const p = await send('POST', '/api/v1/projects', { name: 'P', memoryScope: 'project_only' });
    const projectId = p.json<{ id: string }>().id;
    await say('Remember that the code word is Heron.', { projectId });
    ageChats();
    const run = await send('POST', '/api/v1/memory/consolidate', {
      scopeKind: 'project',
      scopeRef: projectId,
    });
    expect(run.json()).toMatchObject({ scopeKind: 'project', scopeRef: projectId });
    await expect
      .poll(async () => (await runs()).map((r) => r.status))
      .toEqual(['completed', 'completed']);
    const own = (await get(`/api/v1/memory/summary?scopeKind=project&scopeRef=${projectId}`)).json<{
      summary: string;
    }>();
    expect(own.summary).toContain('Heron');
    expect((await get('/api/v1/memory/summary')).json().summary).toBeNull();
  });

  it('sets and lists topic preferences', async () => {
    const set = await send('PATCH', '/api/v1/memory/topics', { topic: 'Work', preference: 'more' });
    expect(set.json()).toEqual({ topic: 'Work', preference: 'more' });
    await send('PATCH', '/api/v1/memory/topics', { topic: 'cats', preference: 'less' });
    expect((await get('/api/v1/memory/topics')).json()).toEqual({
      items: [
        { topic: 'cats', preference: 'less' },
        { topic: 'Work', preference: 'more' },
      ],
    });
    await send('PATCH', '/api/v1/memory/topics', { topic: 'cats', preference: 'default' });
    expect((await get('/api/v1/memory/topics')).json().items).toHaveLength(1);
    expect(
      (await send('PATCH', '/api/v1/memory/topics', { topic: 'x', preference: 'lots' })).statusCode,
    ).toBe(400);
    expect(
      (await send('PATCH', '/api/v1/memory/topics', { topic: '', preference: 'more' })).statusCode,
    ).toBe(400);
  });

  it('wires the reference-past-chats setting into memory (FR-205)', async () => {
    expect(await hub.memory.referencePastChats(null)).toBe(true);
    const res = await send('PATCH', '/api/v1/settings', {
      key: 'memory.referencePastChats',
      value: false,
    });
    expect(res.statusCode).toBe(200);
    expect(await hub.memory.referencePastChats(null)).toBe(false);
  });
});

describe('background schedule', () => {
  it('runs on its interval where there is work and stops on close', async () => {
    const overrides: Record<string, unknown> = {
      'memory.consolidation': { enabled: true, idleMinutes: 5 },
    };
    const diagnostics = new DiagnosticsRegistry();
    const ctx: HubContext & { memory: Hub['memory'] } = {
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [] }),
      events: hub.events,
      secrets: new MemorySecretStore(),
      dataDir: config.dataDir,
      registry: hub.registry,
      router: hub.router,
      nodes: hub.nodes,
      threads: hub.threads,
      setting: <K extends SettingKey>(key: K) =>
        Promise.resolve(resolveSetting(key, { global: overrides, project: {}, managed: {} }).value),
      accountOf: () => Promise.reject(new Error('unused')),
      diagnostics,
      memory: hub.memory,
    };
    // Leave a run "running" as if the Hub had stopped mid-job: setup marks it failed.
    db.raw
      .prepare(
        `INSERT INTO memory_consolidation_run (id, account_id, scope_kind, phase, status, started_at)
         SELECT '01920000-0000-7000-8000-00000000beef', id, 'global', 'extract', 'running', '2000-01-01'
         FROM account LIMIT 1`,
      )
      .run();
    const area = await setupConsolidation(ctx, { intervalMs: 20 });
    expect((await runs())[0]).toMatchObject({ status: 'failed' });
    await say('I work at Acme.');
    ageChats();
    await expect
      .poll(async () => (await runs()).filter((r) => r.status === 'completed').length, {
        timeout: 3_000,
      })
      .toBe(2);
    const probes = await diagnostics.collect();
    expect(probes.memoryConsolidation).toMatchObject({
      settings: { enabled: true, idleMinutes: 5 },
      lastRun: { phase: 'consolidate', status: 'completed' },
    });
    // Turned off, nothing runs even with an idle chat waiting.
    const count = (await runs()).length;
    overrides['memory.consolidation'] = { enabled: false, idleMinutes: 5 };
    await say('I live in Lisbon.');
    ageChats();
    await new Promise((r) => setTimeout(r, 100));
    expect((await runs()).length).toBe(count);
    // Closed, the schedule stops.
    await area.close();
    overrides['memory.consolidation'] = { enabled: true, idleMinutes: 5 };
    await new Promise((r) => setTimeout(r, 100));
    expect((await runs()).length).toBe(count);
  });
});
