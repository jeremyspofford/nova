// OAuth for remote MCP servers through the Hub (FR-047) against an in-process authorization
// server: start (PKCE, dynamic registration), the callback without a session (single-use state),
// bad and reused states, the client metadata document, tokens only in the vault, refresh after the
// server refuses an expired token, revocation and removal.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { uuidv7, type McpServerView } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import {
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../../packages/mcp/test/oauth-fixture.ts';

const HOST = { host: '127.0.0.1:7419' };
const CALLBACK = 'http://127.0.0.1:7419/api/v1/mcp/oauth/callback';

let dir: string;
let db: NovaDatabase;
let secrets: MemorySecretStore;
let hub: Hub;
let cookie: string;
let as: FakeAuthServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-oauth-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  secrets = new MemorySecretStore();
  as = await startFakeAuthServer();
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
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
  await as.close();
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
  return {
    status: res.statusCode,
    json: res.body && res.headers['content-type']?.toString().includes('json') ? res.json() : null,
    location: res.headers.location,
  };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const server = (id: string) =>
  api('GET', `/api/v1/mcp/servers/${id}`).then((r) => r.json as McpServerView);

async function remote(): Promise<McpServerView> {
  const r = await api('POST', '/api/v1/mcp/servers', {
    name: 'remote',
    transport: 'http',
    url: as.mcpUrl,
  });
  expect(r.status).toBe(201);
  return r.json as McpServerView;
}

/** Start, follow the authorization as the user, and land on the callback without a session. */
async function authorize(id: string) {
  const start = await api('POST', `/api/v1/mcp/servers/${id}/oauth/start`);
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  const back = await as.authorize(start.json.authorizeUrl as string);
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  const cb = await api('GET', `${back.pathname}${back.search}`, undefined, false);
  return { start: start.json as { authorizeUrl: string }, back, cb };
}

describe('OAuth for remote MCP servers', () => {
  it('reports a server that refuses unauthenticated use as needing authorization', async () => {
    const s = await remote();
    const v = await waitFor(async () => {
      const x = await server(s.id);
      return x.status === 'error' ? x : null;
    });
    expect(v.lastError).toBe('the server needs authorization (HTTP 401)');
    expect(v.auth).toEqual({ kind: 'oauth', status: 'needs_auth', expiresAt: null, scopes: [] });
  });

  it('authorizes with PKCE and dynamic registration, keeping tokens in the vault', async () => {
    const s = await remote();
    const { start, cb } = await authorize(s.id);
    const u = new URL(start.authorizeUrl);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(as.registrations[0]).toMatchObject({ client_name: 'Nova', redirect_uris: [CALLBACK] });
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/settings/tools?oauth=ok');
    const v = await waitFor(async () => {
      const x = await server(s.id);
      return x.status === 'connected' ? x : null;
    });
    expect(v.auth).toMatchObject({ kind: 'oauth', status: 'connected', scopes: ['read', 'write'] });
    expect(v.counts.tools).toBe(5);
    const token = as.accessTokens()[0]!;
    expect(await secrets.get(`secret://mcp/${s.id}/oauth/access_token`)).toBe(token);
    const row = db.raw.prepare('SELECT * FROM mcp_oauth WHERE server_id = ?').get(s.id) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ registration: 'dynamic', client_id: 'dyn-1', status: 'connected' });
    expect(JSON.stringify(row)).not.toContain(token);
    const audit = (await api('GET', '/api/v1/audit?limit=200')).json.items as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['oauth.start', 'oauth.connect']),
    );
  });

  it('uses each state once and refuses unknown or malformed callbacks', async () => {
    const s = await remote();
    const { back } = await authorize(s.id);
    const again = await api('GET', `${back.pathname}${back.search}`, undefined, false);
    expect(again.location).toBe('/settings/tools?oauth=error');
    const unknown = await api(
      'GET',
      `/api/v1/mcp/oauth/callback?state=made-up&code=x`,
      undefined,
      false,
    );
    expect(unknown.location).toBe('/settings/tools?oauth=error');
    expect((await api('GET', '/api/v1/mcp/oauth/callback', undefined, false)).status).toBe(400);
    // A refusal at the authorization server lands back in settings as an error.
    const start = await api('POST', `/api/v1/mcp/servers/${s.id}/oauth/start`);
    const denied = await as.authorize(start.json.authorizeUrl as string, { deny: true });
    expect(
      (await api('GET', `${denied.pathname}${denied.search}`, undefined, false)).location,
    ).toBe('/settings/tools?oauth=error');
  });

  it('validates the start request', async () => {
    expect(
      (await api('POST', `/api/v1/mcp/servers/${uuidv7()}/oauth/start`, undefined, false)).status,
    ).toBe(401);
    expect((await api('POST', `/api/v1/mcp/servers/${uuidv7()}/oauth/start`)).status).toBe(404);
    const local = await api('POST', '/api/v1/mcp/servers', {
      name: 'local',
      transport: 'stdio',
      command: process.execPath,
      enabled: false,
    });
    const r = await api('POST', `/api/v1/mcp/servers/${local.json.id}/oauth/start`);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/sse and http/);
    expect((await api('DELETE', `/api/v1/mcp/servers/${uuidv7()}/oauth`)).status).toBe(404);
  });

  it('serves its client metadata document', async () => {
    const r = await api('GET', '/.well-known/nova-client.json', undefined, false);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      client_id: 'http://127.0.0.1:7419/.well-known/nova-client.json',
      client_name: 'Nova',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
    });
  });

  it('refreshes when the server refuses an expired token', async () => {
    const s = await remote();
    await authorize(s.id);
    await waitFor(async () => (await server(s.id)).status === 'connected');
    for (const t of as.accessTokens()) as.expire(t);
    expect((await api('POST', `/api/v1/mcp/servers/${s.id}/restart`)).status).toBe(200);
    await waitFor(() =>
      Promise.resolve(as.tokenRequests.some((t) => t.grant_type === 'refresh_token')),
    );
    const v = await waitFor(async () => {
      const x = await server(s.id);
      return x.status === 'connected' ? x : null;
    });
    expect(v.auth!.status).toBe('connected');
    expect(as.bearers.at(-1)).toBe(await secrets.get(`secret://mcp/${s.id}/oauth/access_token`));
  });

  it('revokes and forgets the tokens, and removing the server removes its record', async () => {
    const s = await remote();
    await authorize(s.id);
    await waitFor(async () => (await server(s.id)).status === 'connected');
    const refresh = await secrets.get(`secret://mcp/${s.id}/oauth/refresh_token`);
    const r = await api('DELETE', `/api/v1/mcp/servers/${s.id}/oauth`);
    expect(r.status).toBe(200);
    expect((r.json as McpServerView).auth).toMatchObject({ kind: 'oauth', status: 'needs_auth' });
    expect(as.revoked).toContain(refresh);
    expect(await secrets.get(`secret://mcp/${s.id}/oauth/access_token`)).toBeNull();
    expect((await api('DELETE', `/api/v1/mcp/servers/${s.id}`)).json).toEqual({ ok: true });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM mcp_oauth').get()).toEqual({ n: 0 });
    expect(await secrets.list(`secret://mcp/${s.id}/`)).toEqual([]);
  });
});
