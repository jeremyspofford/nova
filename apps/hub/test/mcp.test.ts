// The Hub's MCP area (FR-042, FR-043): routes with auth and validation, CRUD with secrets in the
// vault only, status events, restart, logs and tools against the fixture server, and the area's
// tool source, per-server defaults, diagnostics, audit and startup/shutdown.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { httpStatusFor, isNovaError, uuidv7, type McpServerView } from '@nova/shared';
import { migrate, openDatabase, schema, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupMcp, type HubMcpArea } from '../src/mcp.ts';
import { startHttpHost } from '../../../packages/mcp/test/helpers.ts';

const FIXTURE = fileURLToPath(
  new URL('../../../packages/mcp/test/fixtures/test-server.mjs', import.meta.url),
);
const HOST = { host: '127.0.0.1:7419' };
const SECRET = 'sk-mcp-test-0123456789abcdefghij';

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let sink: MemorySink;
let secrets: MemorySecretStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-mcp-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  sink = new MemorySink();
  secrets = new MemorySecretStore();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fixtureServer(over: Record<string, unknown> = {}, args: string[] = []) {
  return {
    name: 'files',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE, ...args],
    ...over,
  };
}

describe('MCP routes', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [sink] }),
      secrets,
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
  });

  async function api(method: string, url: string, payload?: unknown, auth = true) {
    const res = await hub.app.inject({
      method: method as 'GET',
      url,
      headers: { ...HOST, ...(auth ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, json: res.body ? res.json() : null, body: res.body };
  }

  const view = (id: string) =>
    api('GET', `/api/v1/mcp/servers/${id}`).then((r) => r.json as McpServerView);

  it('requires a session on every route', async () => {
    const id = uuidv7();
    for (const [method, url] of [
      ['GET', '/api/v1/mcp/servers'],
      ['POST', '/api/v1/mcp/servers'],
      ['GET', `/api/v1/mcp/servers/${id}`],
      ['PATCH', `/api/v1/mcp/servers/${id}`],
      ['DELETE', `/api/v1/mcp/servers/${id}`],
      ['POST', `/api/v1/mcp/servers/${id}/restart`],
      ['GET', `/api/v1/mcp/servers/${id}/logs`],
      ['GET', `/api/v1/mcp/servers/${id}/tools`],
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
    const bad = [
      { ...fixtureServer(), name: 'Bad Name' },
      { name: 'x', transport: 'stdio' },
      { name: 'x', transport: 'http' },
      { name: 'x', transport: 'carrier-pigeon', command: 'x' },
      fixtureServer({ env: { 'BAD-NAME': 'v' } }),
      fixtureServer({ toolTimeoutMs: 10 }),
    ];
    for (const body of bad) {
      const r = await api('POST', '/api/v1/mcp/servers', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe('validation');
    }
    // A reference to another vault secret is refused: values are entered, never referenced.
    await secrets.put('secret://provider/p1/api_key', 'sk-provider-key-abcdefghijklmnop');
    const ref = await api(
      'POST',
      '/api/v1/mcp/servers',
      fixtureServer({ env: { KEY: 'secret://provider/p1/api_key' } }),
    );
    expect(ref.status).toBe(400);
    expect(await secrets.list('secret://mcp/')).toEqual([]);
    expect((await api('GET', '/api/v1/mcp/servers')).json.items).toEqual([]);
  });

  it('adds a server, connects it, lists its tools and keeps secrets in the vault only', async () => {
    const created = await api(
      'POST',
      '/api/v1/mcp/servers',
      fixtureServer({ env: { API_KEY: SECRET }, toolTimeoutMs: 20_000 }, [
        '--print-env',
        'API_KEY',
      ]),
    );
    expect(created.status).toBe(201);
    const v = created.json as McpServerView;
    expect(v).toMatchObject({
      name: 'files',
      transport: 'stdio',
      envKeys: ['API_KEY'],
      enabled: true,
      toolTimeoutMs: 20_000,
      startupTimeoutMs: 30_000,
      defaultApproval: null,
      enabledTools: null,
      disabledTools: [],
      url: null,
    });
    const connected = await waitFor(async () => {
      const cur = await view(v.id);
      return cur.status === 'connected' && cur;
    });
    expect(connected).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'nova-test-server', version: '1.0.0' },
      counts: { tools: 5, resources: 1, prompts: 1 },
      lastError: null,
    });
    const tools = (await api('GET', `/api/v1/mcp/servers/${v.id}/tools`)).json.items;
    expect(tools.map((t: { name: string }) => t.name)).toContain('mcp:files.write_note');
    expect(tools[0]).toMatchObject({ source: 'mcp', serverId: v.id, loading: 'deferrable' });

    // The value lives in the vault under the server's reference; the row holds the reference.
    expect(await secrets.get(`secret://mcp/${v.id}/env/API_KEY`)).toBe(SECRET);
    const [row] = await db.orm.select().from(schema.mcpServer);
    expect(row!.envRefJson).toBe(JSON.stringify({ API_KEY: `secret://mcp/${v.id}/env/API_KEY` }));
    expect(row!.lastStatus).toBe('connected');

    const logs = (await api('GET', `/api/v1/mcp/servers/${v.id}/logs`)).json.items;
    expect(logs.some((l: { text: string }) => l.text === 'env API_KEY=[REDACTED]')).toBe(true);
    const events = (await api('GET', '/api/v1/events?limit=500')).json.events;
    const status = events.filter((e: { name: string }) => e.name === 'mcp.server.status.changed');
    expect(status.map((e: { payload: { status: string } }) => e.payload.status)).toEqual([
      'starting',
      'connected',
    ]);
    expect(status[0].payload.serverId).toBe(v.id);
    const everything = JSON.stringify([
      created.json,
      await view(v.id),
      logs,
      events,
      sink.records,
      await db.orm.select().from(schema.mcpServer),
    ]);
    expect(everything).not.toContain(SECRET);
  });

  it('validates read-only tool names: at most 500, each 1 to 200 characters', async () => {
    for (const readOnlyTools of [
      ['x'.repeat(201)],
      [''],
      Array.from({ length: 501 }, (_, i) => `t${i}`),
      'echo',
      [1],
    ]) {
      const r = await api(
        'POST',
        '/api/v1/mcp/servers',
        fixtureServer({ enabled: false, readOnlyTools }),
      );
      expect(r.status, JSON.stringify(readOnlyTools).slice(0, 40)).toBe(400);
      expect(r.json.error.code).toBe('validation');
    }
    const ok = await api(
      'POST',
      '/api/v1/mcp/servers',
      fixtureServer({ enabled: false, readOnlyTools: ['x'.repeat(200)] }),
    );
    expect(ok.status).toBe(201);
    const patched = await api('PATCH', `/api/v1/mcp/servers/${ok.json.id}`, {
      readOnlyTools: [''],
    });
    expect(patched.status).toBe(400);
    expect((await view(ok.json.id)).readOnlyTools).toEqual(['x'.repeat(200)]);
  });

  it('refuses duplicate names and unknown ids', async () => {
    expect(
      (await api('POST', '/api/v1/mcp/servers', fixtureServer({ enabled: false }))).status,
    ).toBe(201);
    const dup = await api('POST', '/api/v1/mcp/servers', fixtureServer({ enabled: false }));
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('conflict');
    const other = await api(
      'POST',
      '/api/v1/mcp/servers',
      fixtureServer({ name: 'other', enabled: false }),
    );
    expect(
      (await api('PATCH', `/api/v1/mcp/servers/${other.json.id}`, { name: 'files' })).status,
    ).toBe(409);
    const missing = uuidv7();
    for (const [method, url] of [
      ['GET', `/api/v1/mcp/servers/${missing}`],
      ['PATCH', `/api/v1/mcp/servers/${missing}`],
      ['DELETE', `/api/v1/mcp/servers/${missing}`],
      ['POST', `/api/v1/mcp/servers/${missing}/restart`],
      ['GET', `/api/v1/mcp/servers/${missing}/logs`],
      ['GET', `/api/v1/mcp/servers/${missing}/tools`],
    ] as const) {
      const r = await api(method, url, method === 'PATCH' ? {} : undefined);
      expect(r.status, `${method} ${url}`).toBe(404);
    }
  });

  it('patches settings, toggles enable, merges secrets and restarts', async () => {
    const created = await api(
      'POST',
      '/api/v1/mcp/servers',
      fixtureServer({ env: { A: 'alpha-value-1', B: 'bravo-value-2', D: 'delta-value-4' } }),
    );
    const id = created.json.id as string;
    await waitFor(async () => (await view(id)).status === 'connected');

    const patched = await api('PATCH', `/api/v1/mcp/servers/${id}`, {
      disabledTools: ['slow'],
      defaultApproval: 'allow',
      toolTimeoutMs: 5000,
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({
      disabledTools: ['slow'],
      defaultApproval: 'allow',
      toolTimeoutMs: 5000,
      status: 'connected',
    });

    // The merged server must stay valid.
    const invalid = await api('PATCH', `/api/v1/mcp/servers/${id}`, { transport: 'http' });
    expect(invalid.status).toBe(400);

    const off = await api('PATCH', `/api/v1/mcp/servers/${id}`, { enabled: false });
    expect(off.json).toMatchObject({ enabled: false, status: 'disabled', lastError: null });
    expect((await api('POST', `/api/v1/mcp/servers/${id}/restart`)).json.error.code).toBe(
      'conflict',
    );
    expect((await api('GET', `/api/v1/mcp/servers/${id}/tools`)).json.items).toEqual([]);

    // `env` is the complete set: a value replaces, an empty string keeps the saved value, a new
    // name is added and a name left out is deleted with its secret.
    const on = await api('PATCH', `/api/v1/mcp/servers/${id}`, {
      enabled: true,
      env: { A: 'alpha-value-new', B: '', C: 'charlie-value-3', E: '' },
    });
    expect(on.json.envKeys).toEqual(['A', 'B', 'C', 'E']);
    expect(await secrets.get(`secret://mcp/${id}/env/A`)).toBe('alpha-value-new');
    expect(await secrets.get(`secret://mcp/${id}/env/B`)).toBe('bravo-value-2');
    expect(await secrets.get(`secret://mcp/${id}/env/C`)).toBe('charlie-value-3');
    expect(await secrets.get(`secret://mcp/${id}/env/E`)).toBe('');
    expect(await secrets.has(`secret://mcp/${id}/env/D`)).toBe(false);
    await waitFor(async () => (await view(id)).status === 'connected');
    // A patch without `env` leaves it alone.
    expect(
      (await api('PATCH', `/api/v1/mcp/servers/${id}`, { toolTimeoutMs: 6000 })).json.envKeys,
    ).toEqual(['A', 'B', 'C', 'E']);
    expect(await secrets.get(`secret://mcp/${id}/env/B`)).toBe('bravo-value-2');

    const restarted = await api('POST', `/api/v1/mcp/servers/${id}/restart`);
    expect(restarted.status).toBe(200);
    expect(restarted.json.status).toBe('starting');
    await waitFor(async () => (await view(id)).status === 'connected');
    const starts = (await api('GET', `/api/v1/mcp/servers/${id}/logs`)).json.items.filter(
      (l: { text: string }) => l.text === 'starting',
    );
    expect(starts.length).toBe(3);
  });

  it('deletes a server, its secrets and its working directory', async () => {
    const created = await api(
      'POST',
      '/api/v1/mcp/servers',
      fixtureServer({ env: { TOKEN: 'token-value-xyz' } }),
    );
    const id = created.json.id as string;
    await waitFor(async () => (await view(id)).status === 'connected');
    expect(await secrets.list(`secret://mcp/${id}/`)).toHaveLength(1);
    const del = await api('DELETE', `/api/v1/mcp/servers/${id}`);
    expect(del.json).toEqual({ ok: true });
    expect(await secrets.list(`secret://mcp/${id}/`)).toEqual([]);
    expect((await api('GET', `/api/v1/mcp/servers/${id}`)).status).toBe(404);
    expect((await api('GET', '/api/v1/mcp/servers')).json.items).toEqual([]);
  });

  it('sends env entries as headers to an HTTP server and renames servers', async () => {
    const key = 'header-secret-value-0987654321';
    const host = await startHttpHost({ requireHeader: ['x-api-key', key] });
    try {
      const created = await api('POST', '/api/v1/mcp/servers', {
        name: 'remote',
        transport: 'http',
        url: host.url,
        env: { X_Api_Key: key },
      });
      expect(created.status).toBe(201);
      const id = created.json.id as string;
      expect(created.json).toMatchObject({
        transport: 'http',
        command: null,
        envKeys: ['X_Api_Key'],
      });
      const connected = await waitFor(async () => {
        const cur = await view(id);
        return cur.status === 'connected' && cur;
      });
      expect(connected.counts.tools).toBe(5);
      expect(host.requests.every((r) => r['x-api-key'] === key)).toBe(true);
      expect(await secrets.get(`secret://mcp/${id}/env/X_Api_Key`)).toBe(key);
      const [row] = await db.orm.select().from(schema.mcpServer);
      expect(JSON.stringify(row)).not.toContain(key);

      const renamed = await api('PATCH', `/api/v1/mcp/servers/${id}`, {
        name: 'remote-2',
        env: {},
      });
      expect(renamed.json).toMatchObject({ name: 'remote-2', envKeys: [] });
      expect(await secrets.list(`secret://mcp/${id}/`)).toEqual([]);
      // Without the header the server refuses the relaunched connection.
      const failed = await waitFor(async () => {
        const cur = await view(id);
        return cur.status === 'error' && cur;
      });
      expect(failed.lastError).toBeTruthy();
      expect(JSON.stringify([renamed.json, failed])).not.toContain(key);
    } finally {
      await host.close();
    }
  });

  it('reports a failing server with its error', async () => {
    const created = await api(
      'POST',
      '/api/v1/mcp/servers',
      fixtureServer({ name: 'old' }, ['--protocol', '2025-06-18']),
    );
    const failed = await waitFor(async () => {
      const cur = await view(created.json.id);
      return cur.status === 'error' && cur;
    });
    expect(failed.lastError).toBe(
      'the server speaks MCP protocol 2025-06-18; Nova supports 2025-11-25 or later',
    );
    const events = (await api('GET', '/api/v1/events?limit=500')).json.events;
    expect(
      events.find(
        (e: { name: string; payload: { status: string } }) =>
          e.name === 'mcp.server.status.changed' && e.payload.status === 'error',
      ).payload.error,
    ).toBe(failed.lastError);
  });
});

describe('MCP area', () => {
  let area: HubMcpArea | null = null;
  let audits: AuditRecord[];
  let account: string;
  let diagnostics: DiagnosticsRegistry;

  beforeEach(async () => {
    audits = [];
    account = uuidv7();
    const now = new Date().toISOString();
    await db.orm
      .insert(schema.account)
      .values({ id: account, kind: 'local', createdAt: now, updatedAt: now });
  });

  afterEach(async () => {
    await area?.close();
    area = null;
  });

  async function setup(accountId = account): Promise<HubMcpArea> {
    diagnostics = new DiagnosticsRegistry();
    const ctx = {
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [sink] }),
      events: new EventStore(db),
      secrets,
      dataDir: config.dataDir,
      accountOf: (_req: FastifyRequest) => Promise.resolve(accountId),
      diagnostics,
      audit: { append: (r: AuditRecord) => Promise.resolve(void audits.push(r)) },
    } as unknown as HubContext & { audit: { append: (r: AuditRecord) => Promise<void> } };
    return setupMcp(ctx);
  }

  async function routes(a: HubMcpArea) {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    // The Hub's error mapping, reduced to what these routes throw.
    app.setErrorHandler((err, _req, reply) => {
      const status = isNovaError(err) ? httpStatusFor(err.code) : 500;
      void reply
        .status(status)
        .send({ error: { code: isNovaError(err) ? err.code : 'server_error' } });
    });
    a.register(app);
    return app;
  }

  it('offers connected tools as a source, with the server default and diagnostics', async () => {
    area = await setup();
    const app = await routes(area);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers',
      payload: fixtureServer({ name: 'src', defaultApproval: 'deny', disabledTools: ['slow'] }),
    });
    const id = res.json().id as string;
    const changed: string[] = [];
    const off = area.onToolsChanged((sid) => changed.push(sid));
    await waitFor(() => Promise.resolve(area!.manager.state(id)?.status === 'connected'));
    expect(changed).toContain(id);
    off();
    const defs = await area.source.list(account);
    expect(defs.map((d) => d.descriptor.name).sort()).toEqual([
      'mcp:src.add',
      'mcp:src.echo',
      'mcp:src.purchase_item',
      'mcp:src.write_note',
    ]);
    const echo = defs.find((d) => d.descriptor.name === 'mcp:src.echo')!;
    const out = await echo.handler({ text: 'hi' }, {
      signal: new AbortController().signal,
    } as never);
    expect(out).toMatchObject({ ok: true, content: [{ type: 'text', text: 'hi' }] });
    expect(await area.source.list(uuidv7())).toEqual([]);
    expect(area.serverDefault(id)).toBe('deny');
    expect(area.serverDefault('nope')).toBeNull();
    expect((await diagnostics.collect()).mcp).toEqual([
      { id, name: 'src', status: 'connected', lastError: null },
    ]);
    await app.close();
  });

  it('audits add, enable, disable, update and remove without secret values', async () => {
    area = await setup();
    const app = await routes(area);
    const id = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/mcp/servers',
        payload: fixtureServer({ enabled: false, env: { KEY: SECRET } }),
      })
    ).json().id as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/mcp/servers/${id}`,
      payload: { enabled: true },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/mcp/servers/${id}`,
      payload: { enabled: false },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/mcp/servers/${id}`,
      payload: { defaultApproval: 'ask' },
    });
    await app.inject({ method: 'DELETE', url: `/api/v1/mcp/servers/${id}` });
    expect(audits.map((a) => a.action)).toEqual(['add', 'enable', 'disable', 'update', 'remove']);
    for (const a of audits) {
      expect(a).toMatchObject({ accountId: account, kind: 'mcp', resource: `mcp_server:${id}` });
    }
    expect(audits[0]!.detail).toMatchObject({
      name: 'files',
      transport: 'stdio',
      envKeys: ['KEY'],
    });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    await app.close();
  });

  it('stores the tools the owner declared read-only, marks them and audits the change (FR-082)', async () => {
    area = await setup();
    const app = await routes(area);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers',
      payload: fixtureServer({ name: 'cal', readOnlyTools: ['echo', 'echo'] }),
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect(res.json().readOnlyTools).toEqual(['echo']);
    expect(audits.at(-1)).toMatchObject({
      action: 'add',
      detail: expect.objectContaining({ readOnlyTools: ['echo'] }),
    });
    await waitFor(() => Promise.resolve(area!.manager.state(id)?.status === 'connected'));
    const marked = async () =>
      (await area!.source.list(account))
        .filter((d) => d.descriptor.userReadOnly === true)
        .map((d) => d.descriptor.name);
    expect(await marked()).toEqual(['mcp:cal.echo']);

    // A change re-lists the tools without a relaunch, and the audit records the list: it
    // loosens what agents may do without asking.
    const changed: string[] = [];
    const off = area.onToolsChanged((sid) => changed.push(sid));
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/mcp/servers/${id}`,
      payload: { readOnlyTools: ['echo', 'mcp:cal.add'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      readOnlyTools: ['echo', 'mcp:cal.add'],
      status: 'connected',
    });
    await waitFor(() => Promise.resolve(changed.includes(id)));
    off();
    expect((await marked()).sort()).toEqual(['mcp:cal.add', 'mcp:cal.echo']);
    expect(audits.at(-1)).toMatchObject({
      action: 'update',
      detail: expect.objectContaining({
        fields: ['readOnlyTools'],
        readOnlyTools: { added: ['mcp:cal.add'], removed: [], now: ['echo', 'mcp:cal.add'] },
      }),
    });
    // The settings list of the server's tools shows the marks too.
    const listed = (await app.inject({ url: `/api/v1/mcp/servers/${id}/tools` })).json().items as {
      name: string;
      userReadOnly?: boolean;
    }[];
    expect(listed.filter((t) => t.userReadOnly).map((t) => t.name)).toEqual([
      'mcp:cal.echo',
      'mcp:cal.add',
    ]);

    // Other changes keep the list; an update that does not change it records no list.
    const other = await app.inject({
      method: 'PATCH',
      url: `/api/v1/mcp/servers/${id}`,
      payload: { toolTimeoutMs: 5000 },
    });
    expect(other.json().readOnlyTools).toEqual(['echo', 'mcp:cal.add']);
    expect(audits.at(-1)!.detail).not.toHaveProperty('readOnlyTools');
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/mcp/servers/${id}`,
      payload: { readOnlyTools: [] },
    });
    expect(cleared.json().readOnlyTools).toEqual([]);
    expect(audits.at(-1)!.detail).toMatchObject({
      readOnlyTools: { added: [], removed: ['echo', 'mcp:cal.add'], now: [] },
    });
    expect(await marked()).toEqual([]);
    await app.close();
  });

  it('takes up to 500 read-only tool names and refuses them on a plugin server', async () => {
    area = await setup();
    const app = await routes(area);
    const id = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/mcp/servers',
        payload: fixtureServer({ enabled: false }),
      })
    ).json().id as string;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/mcp/servers/${id}`,
          payload: { readOnlyTools: Array.from({ length: 500 }, (_, i) => `t${i}`) },
        })
      ).json().readOnlyTools,
    ).toHaveLength(500);
    // A plugin's server follows its manifest: the owner's edits, this one included, are refused.
    await db.orm
      .update(schema.mcpServer)
      .set({ source: 'plugin', pluginId: 'com.example.cal' })
      .where(eq(schema.mcpServer.id, id));
    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/v1/mcp/servers/${id}`,
      payload: { readOnlyTools: ['echo'] },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('conflict');
    // Nor does one ever carry a declaration: only the owner's own servers do.
    expect((await app.inject({ url: `/api/v1/mcp/servers/${id}` })).json().readOnlyTools).toEqual(
      [],
    );
    await app.close();
  });

  it('keeps accounts apart', async () => {
    area = await setup();
    const app = await routes(area);
    const id = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/mcp/servers',
        payload: fixtureServer({ enabled: false }),
      })
    ).json().id as string;
    await app.close();
    await area.close();
    area = await setup(uuidv7());
    const other = await routes(area);
    expect((await other.inject({ url: `/api/v1/mcp/servers/${id}` })).statusCode).toBe(404);
    expect((await other.inject({ url: '/api/v1/mcp/servers' })).json()).toEqual({ items: [] });
    await other.close();
  });

  it('connects stored servers at setup and stops them on close', async () => {
    area = await setup();
    const app = await routes(area);
    const id = (
      await app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: fixtureServer() })
    ).json().id as string;
    await waitFor(() => Promise.resolve(area!.manager.state(id)?.status === 'connected'));
    await app.close();
    await area.close();
    expect(area.manager.state(id)?.status).toBe('stopped');
    area = await setup();
    await waitFor(() => Promise.resolve(area!.manager.state(id)?.status === 'connected'));
  });
});
