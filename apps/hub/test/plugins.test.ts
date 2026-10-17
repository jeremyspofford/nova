// The Hub's plugins area (FR-045, FR-046; hub-api M4): routes with a session and validation, the
// sample plugin installed from the built-in catalog with its MCP server started for real (the SDK
// found through NODE_PATH from a data folder outside the repo), its skills and slash command, the
// events and audit, disable and uninstall.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import type { McpServerView, PluginPreview, PluginView, SkillView } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import type { HubMcpArea } from '../src/mcp.ts';
import {
  SAMPLE_CATALOG_ID,
  novaNodeModules,
  pluginServerConfig,
  setupPlugins,
} from '../src/plugins.ts';

const HOST = { host: '127.0.0.1:7419' };

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let hub: Hub;
let cookie: string;

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-plugins-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets: new MemorySecretStore(),
    events: new EventStore(db),
  });
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code },
  });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, url: string, payload?: unknown, auth = true) {
  const res = await hub.app.inject({
    method: method as 'GET',
    url,
    headers: { ...HOST, ...(auth ? { cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null };
}

async function installSample(enable = true) {
  const preview = await api('POST', '/api/v1/plugins/preview', {
    source: { kind: 'catalog', catalogId: SAMPLE_CATALOG_ID, pluginId: 'com.example.sample' },
  });
  expect(preview.status).toBe(200);
  const p = preview.json as PluginPreview;
  const installed = await api('POST', '/api/v1/plugins', {
    previewId: p.previewId,
    confirmSideload: true,
    enable,
    trustHooks: p.hooks.map((h) => ({ id: h.id, contentHash: h.contentHash })),
  });
  expect(installed.status).toBe(201);
  return { preview: p, view: installed.json as PluginView };
}

describe('plugins routes', () => {
  it('requires a session on every route', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/plugins'],
      ['POST', '/api/v1/plugins/preview'],
      ['POST', '/api/v1/plugins'],
      ['PATCH', '/api/v1/plugins/com.example.sample'],
      ['DELETE', '/api/v1/plugins/com.example.sample'],
      ['GET', '/api/v1/plugins/catalogs'],
      ['GET', '/api/v1/plugins/catalog'],
      ['GET', '/api/v1/skills'],
      ['POST', '/api/v1/skills'],
      ['GET', '/api/v1/skills/skill%3Auser%3Ax'],
      ['PATCH', '/api/v1/skills/skill%3Auser%3Ax'],
      ['DELETE', '/api/v1/skills/skill%3Auser%3Ax'],
      ['GET', '/api/v1/slash-commands'],
    ] as const) {
      const r = await api(
        method,
        url,
        method === 'GET' || method === 'DELETE' ? undefined : {},
        false,
      );
      expect(r.status, `${method} ${url}`).toBe(401);
      expect(r.json.error.code).toBe('token_required');
    }
  });

  it('validates bodies', async () => {
    const bad: [string, string, unknown][] = [
      ['POST', '/api/v1/plugins/preview', { source: { kind: 'ftp', path: '/x' } }],
      ['POST', '/api/v1/plugins/preview', { source: { kind: 'git', url: 'not a url' } }],
      ['POST', '/api/v1/plugins', { enable: true }],
      ['PATCH', '/api/v1/plugins/com.example.sample', { enabled: 'yes' }],
      ['POST', '/api/v1/skills', { name: 'Bad Name', description: 'd', body: 'b' }],
      ['POST', '/api/v1/skills', { name: 'ok', description: '', body: 'b' }],
      ['PATCH', '/api/v1/skills/skill%3Auser%3Ax', {}],
    ];
    for (const [method, url, body] of bad) {
      const r = await api(method, url, body);
      expect(r.status, `${method} ${url} ${JSON.stringify(body)}`).toBe(400);
      expect(r.json.error.code).toBe('validation');
    }
    expect(
      (
        await api('POST', '/api/v1/plugins/preview', {
          source: { kind: 'path', path: join(dir, 'nope') },
        })
      ).status,
    ).toBe(400);
    expect((await api('POST', '/api/v1/plugins', { previewId: 'gone' })).status).toBe(410);
    expect((await api('PATCH', '/api/v1/plugins/com.example.none', { enabled: true })).status).toBe(
      404,
    );
    expect((await api('DELETE', '/api/v1/plugins/com.example.none')).status).toBe(404);
  });

  it('lists the built-in sample catalog and its entry', async () => {
    const catalogs = await api('GET', '/api/v1/plugins/catalogs');
    expect(catalogs.json.items).toEqual([
      expect.objectContaining({ id: SAMPLE_CATALOG_ID, kind: 'local' }),
    ]);
    const entries = await api('GET', '/api/v1/plugins/catalog?q=sample');
    expect(entries.json.items).toEqual([
      expect.objectContaining({
        catalogId: SAMPLE_CATALOG_ID,
        pluginId: 'com.example.sample',
        installedVersion: null,
      }),
    ]);
    expect((await api('GET', '/api/v1/plugins/catalog?q=zzz')).json.items).toEqual([]);
  });

  it('installs the sample plugin: its server connects and lists its tools, its command is a slash command', async () => {
    const { preview, view } = await installSample();
    expect(preview.hooks).toHaveLength(1);
    expect(view).toMatchObject({
      id: 'com.example.sample',
      status: 'ok',
      source: 'catalog',
      enabled: true,
    });
    expect((await api('GET', '/api/v1/plugins')).json.items).toHaveLength(1);

    const server = await waitFor(async () => {
      const list = (await api('GET', '/api/v1/mcp/servers')).json.items as McpServerView[];
      const s = list.find((x) => x.name === 'sample');
      return s?.status === 'connected' ? s : null;
    });
    const tools = (await api('GET', `/api/v1/mcp/servers/${server.id}/tools`)).json.items as {
      name: string;
    }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mcp:sample.fetch_status',
      'mcp:sample.panel_action',
    ]);

    const slash = (await api('GET', '/api/v1/slash-commands')).json.items as {
      name: string;
      skillId: string;
    }[];
    expect(slash.map((s) => s.name)).toEqual(['greet', 'summarize-notes']);
    const greet = await api(
      'GET',
      `/api/v1/skills/${encodeURIComponent('skill:com.example.sample:greet')}`,
    );
    expect(greet.json).toMatchObject({
      source: 'plugin',
      pluginId: 'com.example.sample',
      body: expect.stringContaining('# Greet'),
    });

    const events = db.raw.prepare("SELECT name FROM event WHERE name LIKE 'plugin.%'").all();
    expect(events).toEqual([{ name: 'plugin.installed' }]);
    const audit = db.raw
      .prepare("SELECT action, resource FROM audit_event WHERE action LIKE 'plugin.%'")
      .all();
    expect(audit).toEqual([{ action: 'plugin.install', resource: 'plugin:com.example.sample' }]);

    // Disable stops the server; uninstall removes it and the skills.
    const off = await api('PATCH', '/api/v1/plugins/com.example.sample', { enabled: false });
    expect(off.json).toMatchObject({ enabled: false, status: 'disabled' });
    expect(
      ((await api('GET', `/api/v1/mcp/servers/${server.id}`)).json as McpServerView).status,
    ).toBe('disabled');
    expect((await api('GET', '/api/v1/slash-commands')).json.items).toEqual([]);
    expect((await api('DELETE', '/api/v1/plugins/com.example.sample')).json).toEqual({ ok: true });
    expect((await api('GET', '/api/v1/mcp/servers')).json.items).toEqual([]);
    expect((await api('GET', '/api/v1/plugins')).json.items).toEqual([]);
    expect((await api('GET', '/api/v1/skills')).json.items).toEqual([]);
  }, 30_000);

  it('creates, reads, toggles and deletes user skills', async () => {
    const created = await api('POST', '/api/v1/skills', {
      name: 'standup',
      description: 'Write my daily standup from my notes.',
      body: 'Summarize yesterday, today and blockers.',
    });
    expect(created.status).toBe(201);
    const s = created.json as SkillView;
    expect(s).toMatchObject({ id: 'skill:user:standup', source: 'user', enabled: true });
    const id = encodeURIComponent(s.id);
    expect((await api('GET', `/api/v1/skills/${id}`)).json).toMatchObject({
      body: 'Summarize yesterday, today and blockers.',
    });
    expect((await api('PATCH', `/api/v1/skills/${id}`, { enabled: false })).json.enabled).toBe(
      false,
    );
    expect((await api('GET', '/api/v1/slash-commands')).json.items).toEqual([]);
    expect((await api('PATCH', `/api/v1/skills/${id}`, { enabled: true })).json.enabled).toBe(true);
    expect((await api('GET', '/api/v1/skills')).json.items.map((x: SkillView) => x.id)).toEqual([
      s.id,
    ]);
    expect(
      (await api('POST', '/api/v1/skills', { name: 'standup', description: 'Again.', body: 'x' }))
        .status,
    ).toBe(409);
    expect((await api('DELETE', `/api/v1/skills/${id}`)).json).toEqual({ ok: true });
    expect((await api('GET', `/api/v1/skills/${id}`)).status).toBe(404);
    // A project skill needs a project folder.
    const projectId = '01920000-0000-7000-8000-00000000abcd';
    const r = await api('POST', '/api/v1/skills', {
      name: 'p',
      description: 'Project skill.',
      body: 'x',
      projectId,
    });
    expect(r.status).toBe(409);
    expect((await api('GET', `/api/v1/skills?projectId=${projectId}`)).json.items).toEqual([]);
  });
});

describe('plugin server config', () => {
  it("reads a stored row the way the MCP area does and finds Nova's node_modules", () => {
    const row = {
      id: 's1',
      accountId: 'a1',
      name: 'sample',
      transport: 'stdio' as const,
      command: 'node',
      argsJson: '["x.mjs"]',
      url: null,
      envRefJson: '{"NODE_PATH":"secret://mcp/s1/env/NODE_PATH"}',
      configJson: '{"startupTimeoutMs":20000,"enabledTools":["a"],"disabledTools":["b"]}',
      source: 'plugin' as const,
      pluginId: 'com.example.sample',
      deviceId: null,
      bundleManifestJson: null,
      signatureStatus: null,
      bundleSha256: null,
      installRecordJson: null,
      enabled: true,
      lastStatus: null,
      lastError: null,
      createdAt: '',
      updatedAt: '',
    };
    expect(pluginServerConfig(row)).toEqual({
      id: 's1',
      accountId: 'a1',
      name: 'sample',
      transport: 'stdio',
      command: 'node',
      args: ['x.mjs'],
      url: null,
      env: { NODE_PATH: 'secret://mcp/s1/env/NODE_PATH' },
      headers: {},
      enabled: true,
      startupTimeoutMs: 20000,
      toolTimeoutMs: 60000,
      enabledTools: ['a'],
      disabledTools: ['b'],
    });
    expect(pluginServerConfig({ ...row, configJson: 'not json', argsJson: null })).toMatchObject({
      args: [],
      startupTimeoutMs: 30000,
      enabledTools: null,
      disabledTools: [],
    });
    expect(novaNodeModules()).toMatch(/node_modules$/);
  });
});

describe('plugins area wiring', () => {
  it('takes the hooks area trust count and serves manifests, entry points and server defaults', async () => {
    const owner = await hub.auth.ownerAccount();
    const accountId = owner!.id;
    const ctx = {
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [] }),
      events: new EventStore(db),
      secrets: new MemorySecretStore(),
      dataDir: join(dir, 'area'),
      setting: () => Promise.resolve([]),
      accountOf: () => Promise.resolve(accountId),
      diagnostics: new DiagnosticsRegistry(),
    } as unknown as HubContext;
    const started: string[] = [];
    const mcp = {
      manager: {
        update: (c: { id: string }) => (started.push(c.id), Promise.resolve()),
        remove: () => Promise.resolve(true),
      },
    } as unknown as HubMcpArea;
    const area = await setupPlugins({
      ...ctx,
      audit: { append: () => Promise.resolve() },
      mcp,
      builtinSkillsDir: null,
    });
    const preview = await area.service.preview(accountId, {
      kind: 'catalog',
      catalogId: SAMPLE_CATALOG_ID,
      pluginId: 'com.example.sample',
    });
    const view = await area.service.install(accountId, {
      previewId: preview.previewId,
      confirmSideload: true,
    });
    expect(view.status).toBe('needs_trust');
    expect(started).toHaveLength(1);
    area.useHookTrust(() => Promise.resolve(0));
    expect((await area.service.get(accountId, 'com.example.sample')).status).toBe('ok');
    expect((await area.enabledManifests(accountId)).map((m) => m.pluginId)).toEqual([
      'com.example.sample',
    ]);
    const entries = await area.uiEntryPoints(accountId);
    expect(entries.map((e) => [e.kind, e.resource, e.serverIds])).toEqual([
      ['global', 'ui://sample/panel', [started[0]]],
      ['thread', 'ui://sample/panel', [started[0]]],
    ]);
    expect(await area.serverDefault(accountId, started[0]!)).toBe('ask');
    expect((await area.hooks.list(accountId)).map((h) => h.id)).toEqual([
      'hook:com.example.sample.check-fetch',
    ]);
    expect(await area.skills.catalogSection(accountId, null, 100_000)).toContain('- greet:');
    await area.close();
  });
});
