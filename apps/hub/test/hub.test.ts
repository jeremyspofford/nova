import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { hashToken, newToken } from '@nova/security';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { start } from '../src/main.ts';

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let config: HubConfig;
let logs: MemorySink;

const HOST = { host: '127.0.0.1:7419' };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  logs = new MemorySink();
  hub = await buildHub({ config, db, log: new Logger({ module: 'hub', sinks: [logs] }) });
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function signIn(): Promise<string> {
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  return cookie.value;
}

describe('public endpoints', () => {
  it('reports hello and health without credentials', async () => {
    const hello = await hub.app.inject({ url: '/api/v1/hello', headers: HOST });
    expect(hello.json()).toMatchObject({
      name: 'nova-hub',
      apiVersions: ['v1'],
      setupRequired: true,
    });
    const health = await hub.app.inject({ url: '/api/v1/health', headers: HOST });
    expect(health.json()).toEqual({ status: 'ok', version: '0.0.0-dev' });
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");
    expect(health.headers['x-frame-options']).toBe('DENY');
  });

  it('serves the web shell and falls back to index.html for app routes', async () => {
    const root = await hub.app.inject({ url: '/', headers: HOST });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Nova</title>');
    const deep = await hub.app.inject({
      url: '/chat/123',
      headers: { ...HOST, accept: 'text/html' },
    });
    expect(deep.statusCode).toBe(200);
    const api = await hub.app.inject({ url: '/api/v1/nope', headers: HOST });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
  });
});

describe('authentication (FR-192)', () => {
  it('requires a token for the API', async () => {
    const res = await hub.app.inject({ url: '/api/v1/settings', headers: HOST });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('token_required');
  });

  it('exchanges a one-time setup code for a session and burns the code', async () => {
    const code = await hub.auth.issueSetupCode();
    const first = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code },
    });
    expect(first.statusCode).toBe(200);
    const again = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code },
    });
    expect(again.statusCode).toBe(401);
    const hello = await hub.app.inject({ url: '/api/v1/hello', headers: HOST });
    expect(hello.json().setupRequired).toBe(false);
  });

  it('rejects expired setup codes and never accepts a setup code as a bearer token', async () => {
    const expired = await hub.auth.issueSetupCode(-1);
    const r1 = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code: expired },
    });
    expect(r1.statusCode).toBe(401);
    const code = await hub.auth.issueSetupCode();
    const r2 = await hub.app.inject({
      url: '/api/v1/session',
      headers: { ...HOST, authorization: `Bearer ${code}` },
    });
    expect(r2.statusCode).toBe(401);
  });

  it('accepts the session as cookie or bearer, and logout revokes it', async () => {
    const session = await signIn();
    const viaCookie = await hub.app.inject({
      url: '/api/v1/session',
      headers: HOST,
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(viaCookie.json()).toMatchObject({ displayName: 'Owner', kind: 'session' });
    const viaBearer = await hub.app.inject({
      url: '/api/v1/session',
      headers: { ...HOST, authorization: `Bearer ${session}` },
    });
    expect(viaBearer.statusCode).toBe(200);
    const out = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...HOST, authorization: `Bearer ${session}` },
    });
    expect(out.statusCode).toBe(200);
    const after = await hub.app.inject({
      url: '/api/v1/session',
      headers: { ...HOST, authorization: `Bearer ${session}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('never lets a device, app or MCP-client token act as the user (FR-192)', async () => {
    await signIn();
    const now = new Date().toISOString();
    for (const kind of ['device', 'app', 'mcp_client'] as const) {
      const token = newToken(kind);
      db.raw
        .prepare(
          'INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES (?, ?, ?, NULL, ?)',
        )
        .run(uuidv7(), kind, hashToken(token), now);
      for (const url of ['/api/v1/session', '/api/v1/threads']) {
        const res = await hub.app.inject({
          url,
          headers: { ...HOST, authorization: `Bearer ${token}` },
        });
        expect(res.statusCode, `${kind} on ${url}`).toBe(401);
      }
    }
  });

  it('validates the setup body', async () => {
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });
});

describe('Host and Origin guards', () => {
  it('refuses unexpected Host headers (DNS rebinding)', async () => {
    const res = await hub.app.inject({ url: '/api/v1/health', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_rejected');
  });

  it('refuses cross-origin browser requests but accepts same-origin ones', async () => {
    const session = await signIn();
    const bad = await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { ...HOST, origin: 'https://evil.example' },
      cookies: { [SESSION_COOKIE]: session },
      payload: { key: 'appearance.theme', value: 'dark' },
    });
    expect(bad.statusCode).toBe(403);
    const good = await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { ...HOST, origin: 'http://127.0.0.1:7419' },
      cookies: { [SESSION_COOKIE]: session },
      payload: { key: 'appearance.theme', value: 'dark' },
    });
    expect(good.statusCode).toBe(200);
  });
});

describe('settings API (docs/14 §1)', () => {
  it('resolves defaults, stores writes and applies project overrides', async () => {
    const session = await signIn();
    const auth = { ...HOST, authorization: `Bearer ${session}` };
    const initial = await hub.app.inject({ url: '/api/v1/settings', headers: auth });
    const theme = (s: { key: string }[]) => s.find((x) => x.key === 'appearance.theme');
    expect(theme(initial.json().settings)).toMatchObject({ value: 'system', source: 'default' });
    await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: auth,
      payload: { key: 'appearance.theme', value: 'dark' },
    });
    await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: auth,
      payload: { key: 'appearance.theme', value: 'light' },
    });
    await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: auth,
      payload: {
        key: 'appearance.theme',
        value: 'high-contrast-dark',
        scope: 'project',
        projectId: 'p1',
      },
    });
    const global = await hub.app.inject({ url: '/api/v1/settings', headers: auth });
    expect(theme(global.json().settings)).toMatchObject({ value: 'light', source: 'global' });
    const project = await hub.app.inject({ url: '/api/v1/settings?projectId=p1', headers: auth });
    expect(theme(project.json().settings)).toMatchObject({
      value: 'high-contrast-dark',
      source: 'project',
    });
  });

  it('rejects unknown keys, invalid values, missing projectId and security keys per project', async () => {
    const session = await signIn();
    const auth = { ...HOST, authorization: `Bearer ${session}` };
    const patch = (payload: object) =>
      hub.app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth, payload });
    expect((await patch({ key: 'nope', value: 1 })).statusCode).toBe(400);
    expect((await patch({ key: 'appearance.fontScale', value: 99 })).statusCode).toBe(400);
    expect(
      (await patch({ key: 'appearance.theme', value: 'dark', scope: 'project' })).statusCode,
    ).toBe(400);
    const sec = await patch({
      key: 'privacy.telemetry',
      value: true,
      scope: 'project',
      projectId: 'p',
    });
    expect(sec.json().error.details.reason).toBe('security_key_in_project');
  });

  it('refuses writes to managed keys', async () => {
    await hub.app.close();
    hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [logs] }),
      managedSettings: () => ({ 'appearance.theme': 'light' }),
    });
    const session = await signIn();
    const res = await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { ...HOST, authorization: `Bearer ${session}` },
      payload: { key: 'appearance.theme', value: 'dark' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('policy_denied');
  });
});

describe('events', () => {
  it('persists events and lists them after a cursor', async () => {
    const session = await signIn();
    const auth = { ...HOST, authorization: `Bearer ${session}` };
    const a = await hub.events.emit({ name: 'test.first', payload: { n: 1 } });
    await hub.events.emit({
      name: 'test.second',
      payload: { n: 2 },
      correlation: { threadId: 't1' },
    });
    hub.events.emitEphemeral({ name: 'chat.delta', payload: { text: 'x' } });
    const all = await hub.app.inject({ url: '/api/v1/events', headers: auth });
    const names = all.json().events.map((e: { name: string }) => e.name);
    expect(names).toContain('test.first');
    expect(names).not.toContain('chat.delta');
    const after = await hub.app.inject({ url: `/api/v1/events?after=${a.id}`, headers: auth });
    expect(after.json().events.map((e: { name: string }) => e.name)).toEqual(['test.second']);
    expect(after.json().events[0].correlation).toEqual({ threadId: 't1' });
  });

  it('streams replayed and live events over SSE', async () => {
    const session = await signIn();
    await hub.events.emit({ name: 'test.before', payload: {} });
    const addr = await hub.app.listen({ host: '127.0.0.1', port: 0 });
    const ac = new AbortController();
    const res = await fetch(`${addr}/api/v1/events/stream`, {
      headers: { authorization: `Bearer ${session}` },
      signal: ac.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    setTimeout(() => void hub.events.emit({ name: 'test.live', payload: {} }), 50);
    while (!text.includes('test.live')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    ac.abort();
    expect(text).toContain('event: test.before');
    expect(text).toContain('event: test.live');
  });
});

describe('process start (FR-225)', () => {
  it('falls back to the next port when the configured one is taken, and prints a setup link', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as { port: number }).port;
    const cfg = loadConfig(
      {
        NOVA_DATA_DIR: join(dir, 'proc'),
        NOVA_WEB_DIR: join(dir, 'web'),
        NOVA_PORT: String(taken),
      },
      [],
    );
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s: string) => (out.push(s), true);
    process.stderr.write = () => true;
    try {
      const running = await start(cfg);
      expect(running.url).not.toContain(`:${taken}`);
      expect(out.join('')).toMatch(/#setup=nvs_/);
      await running.close();
    } finally {
      process.stdout.write = write;
      process.stderr.write = errWrite;
      blocker.close();
    }
  });
});
