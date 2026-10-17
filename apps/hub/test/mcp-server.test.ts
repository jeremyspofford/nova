// Nova's MCP server and its app authorizations (FR-044, FR-192; docs/08 §2.2): per-client tokens
// (shown once, stored hashed), the server off until a client exists, bearer auth on /mcp (none,
// wrong, revoked, expired), Origin and Host checks, scopes for projects, threads and tools,
// read-only mode, a call that waits for the user's approval, audit with the client id, and
// revocation closing open sessions. Driven end to end with the SDK client over a real port.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { hashToken } from '@nova/security';
import { uuidv7, type AppAuthorizationCreated } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let hub: Hub;
let base: string;
let host: string;
let cookie: string;
let session: string;
const clients: Client[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-mcp-server-'));
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
  base = await hub.app.listen({ port: 0, host: '127.0.0.1' });
  host = new URL(base).host;
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { host },
    payload: { code },
  });
  session = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  cookie = `${SESSION_COOKIE}=${session}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, url: string, payload?: unknown, auth = true) {
  const res = await hub.app.inject({
    method: method as 'GET',
    url,
    headers: { host, ...(auth ? { cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null, headers: res.headers };
}

type Scopes = AppAuthorizationCreated['authorization']['scopes'];
const NONE: Scopes = { tools: [], projects: [], threads: 'none', mode: 'read_only' };

async function addClient(
  scopes: Partial<Scopes>,
  name = 'Editor',
): Promise<AppAuthorizationCreated> {
  const r = await api('POST', '/api/v1/app-authorizations', {
    kind: 'mcp_client',
    clientName: name,
    scopes: { ...NONE, ...scopes },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as AppAuthorizationCreated;
}

async function connect(token: string, endpoint = `${base}/mcp`) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'external-agent', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const rpc = (headers: Record<string, string>, body?: unknown) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(
      body ?? {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      },
    ),
  });

const enabled = async () =>
  ((await api('GET', '/api/v1/settings')).json.settings as { key: string; value: unknown }[]).find(
    (x) => x.key === 'mcpServer.enabled',
  )!.value;

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('app authorizations', () => {
  it('require a session and validate bodies', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/app-authorizations'],
      ['POST', '/api/v1/app-authorizations'],
      ['DELETE', `/api/v1/app-authorizations/${uuidv7()}`],
    ] as const) {
      const r = await api(method, url, method === 'POST' ? {} : undefined, false);
      expect(r.status, `${method} ${url}`).toBe(401);
      expect(r.json.error.code).toBe('token_required');
    }
    for (const bad of [
      {},
      { kind: 'app', clientName: 'x', scopes: NONE },
      { kind: 'mcp_client', clientName: '  ', scopes: NONE },
      { kind: 'mcp_client', clientName: 'x', scopes: { ...NONE, mode: 'admin' } },
      { kind: 'mcp_client', clientName: 'x', scopes: { ...NONE, threads: 'all' } },
      { kind: 'mcp_client', clientName: 'x', scopes: NONE, expiresInDays: 0 },
      { kind: 'mcp_client', clientName: 'x', scopes: { ...NONE, projects: [uuidv7()] } },
    ]) {
      const r = await api('POST', '/api/v1/app-authorizations', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api('DELETE', `/api/v1/app-authorizations/${uuidv7()}`)).status).toBe(404);
  });

  it('expires after 90 days by default, after the chosen days, or never when asked', async () => {
    const day = 86_400_000;
    const at = (c: AppAuthorizationCreated) =>
      c.authorization.expiresAt === null
        ? null
        : Date.parse(c.authorization.expiresAt) - Date.now();
    const byDefault = await addClient({}, 'default');
    expect(at(byDefault)! / day).toBeCloseTo(90, 1);
    for (const [expiresInDays, name] of [
      [7, 'week'],
      [null, 'never'],
    ] as const) {
      const r = await api('POST', '/api/v1/app-authorizations', {
        kind: 'mcp_client',
        clientName: name,
        scopes: NONE,
        expiresInDays,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const c = r.json as AppAuthorizationCreated;
      if (expiresInDays === null) expect(c.authorization.expiresAt).toBeNull();
      else expect(at(c)! / day).toBeCloseTo(7, 1);
    }
  });

  it('shows the token once, stores its hash and turns the server on', async () => {
    expect(await enabled()).toBe(false);
    const created = await addClient({ projects: '*', threads: 'read' });
    expect(created.token).toMatch(/^nvm_[A-Za-z0-9_-]{43}$/);
    expect(created.endpoint).toBe(`${base}/mcp`);
    expect(created.authorization).toMatchObject({
      kind: 'mcp_client',
      clientName: 'Editor',
      scopes: { projects: '*', threads: 'read', tools: [], mode: 'read_only' },
      lastUsedAt: null,
    });
    // Default expiry: 90 days.
    const days = (Date.parse(created.authorization.expiresAt!) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    const raw = db.raw.prepare('SELECT * FROM app_authorization').all() as Record<
      string,
      unknown
    >[];
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain(created.token);
    expect(raw[0]!.token_hash).toBe(hashToken(created.token));
    expect(await enabled()).toBe(true);
    const list = await api('GET', '/api/v1/app-authorizations');
    expect(list.json.items).toEqual([created.authorization]);
    expect(JSON.stringify(list.json)).not.toContain(created.token);
    const events = (await api('GET', '/api/v1/events?limit=500')).json.events as {
      name: string;
      payload: Record<string, unknown>;
    }[];
    expect(events.find((e) => e.name === 'app.authorization.changed')!.payload).toEqual({
      authorizationId: created.authorization.id,
      kind: 'mcp_client',
      clientName: 'Editor',
      status: 'active',
    });
    const audit = (await api('GET', '/api/v1/audit?limit=200')).json.items as {
      action: string;
      resource: string;
    }[];
    expect(audit.some((a) => a.action === 'app_authorization.create')).toBe(true);
  });
});

describe('/mcp authentication', () => {
  it('is off until a client exists', async () => {
    const r = await rpc({});
    expect(r.status).toBe(404);
  });

  it('needs an active, unexpired client token', async () => {
    const a = await addClient({ projects: '*' });
    const none = await rpc({});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('token_required');
    expect(
      (await rpc({ authorization: 'Bearer nvm_wrongwrongwrongwrongwrongwrongwrongwrong123' }))
        .status,
    ).toBe(401);
    // A Hub session is not a client token.
    expect((await rpc({ authorization: `Bearer ${session}` })).status).toBe(401);
    expect((await rpc({ cookie })).status).toBe(401);
    const ok = await rpc({ authorization: `Bearer ${a.token}` });
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    expect(
      (await api('GET', '/api/v1/app-authorizations')).json.items[0].lastUsedAt,
    ).not.toBeNull();
    db.raw
      .prepare('UPDATE app_authorization SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), a.authorization.id);
    expect((await rpc({ authorization: `Bearer ${a.token}` })).status).toBe(401);
    const b = await addClient({ projects: '*' }, 'Second');
    expect((await api('DELETE', `/api/v1/app-authorizations/${b.authorization.id}`)).json).toEqual({
      ok: true,
    });
    expect((await rpc({ authorization: `Bearer ${b.token}` })).status).toBe(401);
    expect(
      (await api('GET', '/api/v1/app-authorizations')).json.items.map((x: { id: string }) => x.id),
    ).toEqual([a.authorization.id]);
    expect((await api('DELETE', `/api/v1/app-authorizations/${b.authorization.id}`)).status).toBe(
      404,
    );
  });

  it('ends open sessions when the server is turned off', async () => {
    const a = await addClient({ projects: '*' });
    const client = await connect(a.token);
    expect((await client.listTools()).tools).toHaveLength(1);
    expect(
      (await api('PATCH', '/api/v1/settings', { key: 'mcpServer.enabled', value: false })).status,
    ).toBe(200);
    await waitFor(async () =>
      JSON.stringify((await api('GET', '/api/v1/diagnostics')).json).includes('"sessions":0'),
    );
    expect((await rpc({ authorization: `Bearer ${a.token}` })).status).toBe(404);
  });

  it('refuses a foreign Origin or Host', async () => {
    const a = await addClient({ projects: '*' });
    const evil = await rpc({ authorization: `Bearer ${a.token}`, origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe('origin_rejected');
    const res = await hub.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'evil.example', authorization: `Bearer ${a.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('what a client sees', () => {
  async function seed() {
    const p1 = (await api('POST', '/api/v1/projects', { name: 'Garden' })).json.id as string;
    const p2 = (await api('POST', '/api/v1/projects', { name: 'Taxes' })).json.id as string;
    const t1 = (await api('POST', '/api/v1/threads', { projectId: p1, title: 'Tomatoes' })).json
      .id as string;
    const t2 = (await api('POST', '/api/v1/threads', { projectId: p2, title: 'Receipts' })).json
      .id as string;
    const tmp = (await api('POST', '/api/v1/threads', { title: 'Scratch', temporary: true })).json
      .id as string;
    const loose = (await api('POST', '/api/v1/threads', { title: 'Loose' })).json.id as string;
    expect(
      (await api('POST', `/api/v1/threads/${t1}/messages`, { text: 'When do I plant?' })).status,
    ).toBe(202);
    await waitFor(async () => {
      const d = (await api('GET', `/api/v1/threads/${t1}`)).json;
      return d.messages.length >= 2 && d.thread.state === 'idle';
    });
    return { p1, p2, t1, t2, tmp, loose };
  }

  it('lists projects and reads threads within the client scopes', async () => {
    const s = await seed();
    const all = await connect((await addClient({ projects: '*', threads: 'read' })).token);
    expect((await all.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'projects.list',
      'threads.list',
      'threads.read',
    ]);
    const projects = JSON.parse(
      textOf(await all.callTool({ name: 'projects.list', arguments: {} })),
    );
    expect(projects.map((p: { name: string }) => p.name).sort()).toEqual(['Garden', 'Taxes']);
    const threads = JSON.parse(textOf(await all.callTool({ name: 'threads.list', arguments: {} })));
    // Temporary chats are never shared.
    expect(threads.items.map((t: { title: string }) => t.title).sort()).toEqual([
      'Loose',
      'Receipts',
      'Tomatoes',
    ]);
    const read = JSON.parse(
      textOf(await all.callTool({ name: 'threads.read', arguments: { threadId: s.t1 } })),
    );
    expect(read.title).toBe('Tomatoes');
    expect(read.messages[0]).toMatchObject({ role: 'user', text: 'When do I plant?' });
    expect(read.messages).toHaveLength(2);
    const hidden = await all.callTool({ name: 'threads.read', arguments: { threadId: s.tmp } });
    expect(hidden).toMatchObject({ isError: true });

    const garden = await connect(
      (await addClient({ projects: [s.p1], threads: 'read' }, 'Garden only')).token,
    );
    expect(
      JSON.parse(textOf(await garden.callTool({ name: 'projects.list', arguments: {} }))),
    ).toHaveLength(1);
    const mine = JSON.parse(textOf(await garden.callTool({ name: 'threads.list', arguments: {} })));
    expect(mine.items.map((t: { id: string }) => t.id)).toEqual([s.t1]);
    expect(
      await garden.callTool({ name: 'threads.read', arguments: { threadId: s.t2 } }),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'Error: thread not found' }],
    });
    expect(
      await garden.callTool({ name: 'threads.list', arguments: { projectId: s.p2 } }),
    ).toMatchObject({
      isError: true,
    });
    expect(await garden.callTool({ name: 'threads.list', arguments: { bogus: 1 } })).toMatchObject({
      isError: true,
    });

    const nothing = await connect((await addClient({ projects: [s.p1] }, 'Projects only')).token);
    expect((await nothing.listTools()).tools.map((t) => t.name)).toEqual(['projects.list']);
    await expect(
      nothing.callTool({ name: 'threads.read', arguments: { threadId: s.t1 } }),
    ).rejects.toThrow(/Unknown tool/);

    // Every call is audited with the client id.
    const audit = (await api('GET', '/api/v1/audit?limit=200')).json.items as {
      action: string;
      actor: string;
      resource: string;
    }[];
    const calls = audit.filter((a) => a.action === 'client.call');
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(
      calls.every(
        (a) => a.resource.startsWith('app_authorization:') && a.actor.startsWith('mcp_client:'),
      ),
    ).toBe(true);
  });

  it('offers only read tools in read-only mode and never tool.search', async () => {
    const ro = await connect((await addClient({ tools: '*', mode: 'read_only' })).token);
    const names = (await ro.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['fs.read', 'fs.list']));
    for (const n of [
      'fs.write',
      'fs.edit',
      'fs.delete',
      'exec.run',
      'tool.search',
      'projects.list',
    ])
      expect(names).not.toContain(n);
    const rw = await connect(
      (await addClient({ tools: '*', mode: 'run_allowed' }, 'Runner')).token,
    );
    const all = (await rw.listTools()).tools.map((t) => t.name);
    expect(all).toEqual(expect.arrayContaining(['fs.read', 'fs.write', 'exec.run']));
    expect(all).not.toContain('tool.search');
    const listed = await connect(
      (await addClient({ tools: ['fs.read', 'fs.write'], mode: 'read_only' }, 'Few')).token,
    );
    expect((await listed.listTools()).tools.map((t) => t.name)).toEqual(['fs.read']);
  });

  it('waits for the user when a call needs approval, then runs it', async () => {
    const created = await addClient({ tools: ['fs.write', 'fs.read'], mode: 'run_allowed' });
    const client = await connect(created.token);
    const call = client.callTool({
      name: 'fs.write',
      arguments: { path: 'from-mcp.md', content: 'hello' },
    });
    const approval = await waitFor(async () => {
      const items = (await api('GET', '/api/v1/approvals')).json.items as {
        id: string;
        status: string;
        toolName?: string;
      }[];
      return items.find((a) => a.status === 'pending');
    });
    // Nothing was written while the approval waits.
    expect(existsSync(join(config.dataDir, 'workspace', 'from-mcp.md'))).toBe(false);
    const decided = await api('POST', '/api/v1/approvals', {
      approvalId: approval.id,
      decision: 'allow_once',
    });
    expect(decided.status).toBe(200);
    const result = await call;
    expect(result.isError).toBe(false);
    expect(readFileSync(join(config.dataDir, 'workspace', 'from-mcp.md'), 'utf8')).toBe('hello');
    // Denied: the call answers as an error and nothing happens.
    const second = client.callTool({
      name: 'fs.write',
      arguments: { path: 'denied.md', content: 'no' },
    });
    const next = await waitFor(async () => {
      const items = (await api('GET', '/api/v1/approvals')).json.items as {
        id: string;
        status: string;
      }[];
      return items.find((a) => a.status === 'pending' && a.id !== approval.id);
    });
    await api('POST', '/api/v1/approvals', { approvalId: next.id, decision: 'deny_continue' });
    expect((await second).isError).toBe(true);
    expect(existsSync(join(config.dataDir, 'workspace', 'denied.md'))).toBe(false);
    const row = db.raw
      .prepare(
        "SELECT origin, status FROM tool_call WHERE tool_name = 'fs.write' ORDER BY created_at",
      )
      .all() as { origin: string; status: string }[];
    expect(row.map((r) => r.origin)).toEqual(['mcp_client', 'mcp_client']);
    const audit = (await api('GET', '/api/v1/audit?limit=200')).json.items as {
      action: string;
      resource: string;
      kind: string;
    }[];
    expect(
      audit.filter(
        (a) =>
          a.action === 'client.call' &&
          a.resource === `app_authorization:${created.authorization.id}`,
      ),
    ).toHaveLength(2);
  });

  it('closes open sessions at once when the client is revoked', async () => {
    const a = await addClient({ projects: '*' });
    const client = await connect(a.token);
    expect((await client.listTools()).tools).toHaveLength(1);
    const before = (await api('GET', '/api/v1/diagnostics')).json;
    expect(JSON.stringify(before)).toContain('"sessions":1');
    await api('DELETE', `/api/v1/app-authorizations/${a.authorization.id}`);
    const after = (await api('GET', '/api/v1/diagnostics')).json;
    expect(JSON.stringify(after)).toContain('"sessions":0');
    await expect(client.listTools()).rejects.toThrow();
    const events = (await api('GET', '/api/v1/events?limit=500')).json.events as {
      name: string;
      payload: { status?: string };
    }[];
    expect(
      events.filter((e) => e.name === 'app.authorization.changed').map((e) => e.payload.status),
    ).toEqual(['active', 'revoked']);
  });
});
