// Ops area end to end (FR-013, FR-104 partial, FR-118, FR-149 baseline): notifications,
// audit, activity, diagnostics and logs routes on a real Hub, blob encryption with the data
// key from the secret store, and TLS start-up with a self-signed certificate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DATA_KEY_REF, blobEncryption, readAttachmentBlob, writeAttachmentBlob } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink, RingSink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { start } from '../src/main.ts';

const HOST = { host: '127.0.0.1:7419' };

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let config: HubConfig;
let log: Logger;
let secrets: MemorySecretStore;
let auth: Record<string, string>;
let accountId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-ops-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
  secrets = new MemorySecretStore();
  hub = await buildHub({
    config,
    db,
    log,
    secrets,
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
  });
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  accountId = res.json().accountId;
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
const send = (
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) => hub.app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload }) });

/** Let the event subscribers finish (they run after the emitting call returns). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('ops routes require a session', () => {
  it.each([
    ['GET', '/api/v1/notifications'],
    ['POST', '/api/v1/notifications/read'],
    ['DELETE', '/api/v1/notifications/x'],
    ['GET', '/api/v1/audit'],
    ['GET', '/api/v1/audit/verify'],
    ['GET', '/api/v1/audit/export'],
    ['GET', '/api/v1/activity?ref=x'],
    ['GET', '/api/v1/diagnostics'],
    ['GET', '/api/v1/diagnostics/logs'],
    ['GET', '/api/v1/diagnostics/logs/export'],
  ] as const)('%s %s', async (method, url) => {
    const res = await hub.app.inject({
      method,
      url,
      headers: HOST,
      payload: method === 'POST' ? {} : undefined,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('token_required');
  });
});

describe('notifications', () => {
  it('collects failed turns and unreachable nodes, collapses repeats, marks read and deletes', async () => {
    const thread = await hub.threads.create(accountId, { title: 'Trip plan' });
    await hub.events.emit({
      name: 'turn.completed',
      accountId,
      correlation: { threadId: thread.id, turnId: 'u1' },
      payload: { threadId: thread.id, turnId: 'u1', status: 'failed' },
    });
    for (let i = 0; i < 2; i++)
      await hub.events.emit({
        name: 'node.status.changed',
        accountId,
        payload: { nodeId: 'n1', from: 'active', status: 'unreachable' },
      });
    await settle();
    const list = await get('/api/v1/notifications');
    expect(list.statusCode).toBe(200);
    expect(list.json().unread).toBe(2);
    const [node, failed] = list.json().items;
    expect(failed).toMatchObject({
      kind: 'error',
      title: 'A reply failed in “Trip plan”',
      href: `/chat/${thread.id}`,
      read: false,
    });
    expect(node).toMatchObject({ kind: 'attention', href: '/settings/devices' });
    expect(
      (await hub.events.since(null, 100)).filter((e) => e.name === 'notification.created'),
    ).toHaveLength(2);

    const read = await send('POST', '/api/v1/notifications/read', { ids: [failed.id] });
    expect(read.json()).toEqual({ unread: 1 });
    expect(
      (await get('/api/v1/notifications?unread=true'))
        .json()
        .items.map((n: { id: string }) => n.id),
    ).toEqual([node.id]);
    expect((await send('POST', '/api/v1/notifications/read', {})).statusCode).toBe(400);
    expect((await send('POST', '/api/v1/notifications/read', { all: true })).json()).toEqual({
      unread: 0,
    });
    expect((await send('DELETE', `/api/v1/notifications/${node.id}`)).json()).toEqual({ ok: true });
    expect((await send('DELETE', `/api/v1/notifications/${node.id}`)).statusCode).toBe(404);
    expect((await get('/api/v1/notifications')).json().items).toHaveLength(1);
  });

  it('honours notifications.categories', async () => {
    const off = await send('PATCH', '/api/v1/settings', {
      key: 'notifications.categories',
      value: { approval: true, completion: true, error: false, attention: true, system: true },
    });
    expect(off.statusCode).toBe(200);
    await hub.events.emit({
      name: 'turn.completed',
      accountId,
      payload: { threadId: 't', turnId: 'u', status: 'failed' },
    });
    await settle();
    expect((await get('/api/v1/notifications')).json()).toEqual({ items: [], unread: 0 });
  });
});

describe('audit', () => {
  it('records sign-in and security setting changes, lists, verifies and exports them', async () => {
    expect(
      (await send('PATCH', '/api/v1/settings', { key: 'routing.allowCloud', value: false }))
        .statusCode,
    ).toBe(200);
    expect(
      (await send('PATCH', '/api/v1/settings', { key: 'appearance.theme', value: 'dark' }))
        .statusCode,
    ).toBe(200);
    await settle();
    const page = (await get('/api/v1/audit')).json();
    expect(
      page.items.map((e: { kind: string; action: string; resource: string | null }) => [
        e.kind,
        e.action,
        e.resource,
      ]),
    ).toEqual([
      ['settings', 'setting.changed', 'routing.allowCloud'],
      ['auth', 'session.created', accountId],
    ]);
    expect(page.nextCursor).toBeNull();
    expect((await get('/api/v1/audit?kind=auth')).json().items).toHaveLength(1);
    const first = (await get('/api/v1/audit?limit=1')).json();
    expect(first.nextCursor).not.toBeNull();
    expect(
      (await get(`/api/v1/audit?limit=1&cursor=${first.nextCursor}`)).json().items[0].kind,
    ).toBe('auth');
    expect((await get('/api/v1/audit?limit=0')).statusCode).toBe(400);

    expect((await get('/api/v1/audit/verify')).json()).toEqual({
      ok: true,
      checked: 2,
      brokenAt: null,
    });
    const exp = await get('/api/v1/audit/export');
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toMatch(/application\/x-ndjson/);
    expect(exp.headers['content-disposition']).toMatch(
      /attachment; filename="nova-audit-.*\.jsonl"/,
    );
    const lines = exp.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(lines[1].prevHash).toBe(lines[0].hash);
    expect((await hub.events.since(null, 100)).some((e) => e.name === 'audit.appended')).toBe(true);
  });
});

describe('activity', () => {
  it('returns a thread’s trace oldest first and refuses other threads', async () => {
    const thread = await hub.threads.create(accountId, {});
    const c = { threadId: thread.id, turnId: 'u1' };
    await hub.events.emit({ name: 'turn.started', accountId, correlation: c, payload: { ...c } });
    await hub.events.emit({
      name: 'tool.call.started',
      accountId,
      correlation: c,
      payload: { callId: 'c1', tool: 'fs.read', source: 'builtin', argsPreview: '{}' },
    });
    await hub.events.emit({
      name: 'turn.started',
      accountId,
      correlation: { threadId: 'other' },
      payload: {},
    });
    const res = await get(`/api/v1/activity?ref=${thread.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { kind: string; title: string }) => [i.kind, i.title])).toEqual(
      [
        ['turn', 'Turn started'],
        ['tool_call', 'fs.read'],
      ],
    );
    expect((await get('/api/v1/activity?ref=missing')).statusCode).toBe(404);
    expect((await get('/api/v1/activity')).statusCode).toBe(400);
  });
});

describe('diagnostics and logs', () => {
  it('reports the Hub, secrets backend and encryption state with warnings', async () => {
    const res = await get('/api/v1/diagnostics');
    expect(res.statusCode).toBe(200);
    const snap = res.json();
    expect(snap.hub).toMatchObject({
      version: config.version,
      dataDir: config.dataDir,
      encryptedAtRest: {
        blobs: true,
        volume: expect.stringMatching(/encrypted|unencrypted|unknown/),
      },
    });
    expect(snap.secrets).toEqual({ backend: 'memory', detail: 'In-memory store' });
    expect(snap.providers.length).toBeGreaterThan(0);
    expect(snap.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/memory only/)]));
    expect(Array.isArray(snap.mcp)).toBe(true);
    expect(snap.sandbox).toHaveProperty('available');
  });

  it('serves recent logs with filters, redacted, and exports them', async () => {
    // secret-scan: fake
    log.child('test').warn('leaked Bearer Zq7Lm2Vx9Rt4Wp8Ks3Hd6', { port: 1 });
    log.child('test').debug('below the level');
    await get('/api/v1/health', HOST);
    const all = (await get('/api/v1/diagnostics/logs')).json().items;
    expect(all.some((e: { msg: string }) => e.msg === 'request')).toBe(true);
    const warn = (await get('/api/v1/diagnostics/logs?level=warn&module=hub.test')).json().items;
    expect(warn).toEqual([
      {
        ts: expect.any(String),
        level: 'warn',
        module: 'hub.test',
        msg: 'leaked Bearer [REDACTED]',
        fields: { port: 1 },
      },
    ]);
    expect(
      (await get('/api/v1/diagnostics/logs?since=2999-01-01T00:00:00.000Z')).json().items,
    ).toEqual([]);
    expect((await get('/api/v1/diagnostics/logs?limit=1')).json().items).toHaveLength(1);
    expect((await get('/api/v1/diagnostics/logs?level=loud')).statusCode).toBe(400);
    const exp = await get('/api/v1/diagnostics/logs/export');
    expect(exp.headers['content-disposition']).toMatch(/nova-logs-.*\.jsonl/);
    expect(exp.body).toContain('leaked Bearer [REDACTED]');
    expect(exp.body).not.toContain('Zq7Lm2Vx9Rt4Wp8Ks3Hd6');
  });

  it('maps trace records to debug and detaches its ring on close', async () => {
    const traced = new Logger({ module: 'hub', level: 'trace', sinks: [new MemorySink()] });
    const h = await buildHub({ config, db, log: traced, secrets });
    try {
      traced.trace('fine detail');
      const s = await h.auth.issueSetupCode();
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: HOST,
        payload: { code: s },
      });
      const headers = {
        ...HOST,
        authorization: `Bearer ${r.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`,
      };
      const items = (
        await h.app.inject({ method: 'GET', url: '/api/v1/diagnostics/logs?level=trace', headers })
      ).json().items;
      expect(items.find((e: { msg: string }) => e.msg === 'fine detail')?.level).toBe('debug');
    } finally {
      await h.app.close();
    }
    expect(traced.findSink(RingSink)).toBeUndefined();
  });
});

describe('blobs at rest', () => {
  it('encrypts new blobs with the data key kept in the secret store', async () => {
    expect(await secrets.has(DATA_KEY_REF)).toBe(true);
    expect(blobEncryption(config.dataDir)).toBe(true);
    const blob = writeAttachmentBlob(config.dataDir, Buffer.from('attachment body'));
    expect(readAttachmentBlob(config.dataDir, blob.blobPath).toString()).toBe('attachment body');
  });
});

describe('configuration', () => {
  it('parses NOVA_SECRETS and the TLS pair', () => {
    expect(loadConfig({}, []).secrets).toBe('vault');
    expect(loadConfig({ NOVA_SECRETS: 'keychain' }, []).secrets).toBe('keychain');
    expect(() => loadConfig({ NOVA_SECRETS: 'cloud' }, [])).toThrow(/NOVA_SECRETS/);
    expect(loadConfig({}, []).tls).toBeNull();
    expect(() => loadConfig({ NOVA_TLS_CERT: '/c.pem' }, [])).toThrow(
      /both NOVA_TLS_CERT and NOVA_TLS_KEY/,
    );
    expect(loadConfig({}, ['--tls-cert', '/c.pem', '--tls-key', '/k.pem']).tls).toEqual({
      certPath: '/c.pem',
      keyPath: '/k.pem',
    });
  });
});

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

describe.skipIf(!hasOpenssl)('TLS start-up (FR-149)', () => {
  it('serves HTTPS with a self-signed certificate', async () => {
    const certDir = join(dir, 'tls');
    mkdirSync(certDir);
    const gen = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(certDir, 'key.pem'),
        '-out',
        join(certDir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { encoding: 'utf8' },
    );
    expect(gen.status).toBe(0);
    writeFileSync(join(dir, 'index.html'), '');
    const cfg = loadConfig(
      {
        NOVA_DATA_DIR: join(dir, 'tls-data'),
        NOVA_WEB_DIR: join(dir, 'noweb'),
        NOVA_PORT: '0',
        NOVA_TLS_CERT: join(certDir, 'cert.pem'),
        NOVA_TLS_KEY: join(certDir, 'key.pem'),
      },
      [],
    );
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    let running: Awaited<ReturnType<typeof start>> | null = null;
    try {
      running = await start(cfg);
      expect(running.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
      const ca = readFileSync(join(certDir, 'cert.pem'));
      const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const url = new URL('/api/v1/health', running!.url);
        const req = httpsRequest(url, { ca, headers: { host: url.host } }, (res) => {
          let text = '';
          res.setEncoding('utf8').on('data', (d: string) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body.status).toBe(200);
      expect(JSON.parse(body.text)).toMatchObject({ status: 'ok' });
      // Plain HTTP to the TLS port is not served.
      const plain = await fetch(running.url.replace('https:', 'http:') + '/api/v1/health').then(
        (r) => r.status,
        () => 'refused',
      );
      expect(plain).not.toBe(200);
      // WebSocket upgrades reach the same routes: without a session the handshake gets 401.
      const refused = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${running!.url.replace('https:', 'wss:')}/api/v1/ws`, { ca });
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on('error', () => undefined);
      });
      expect(refused).toBe(401);
    } finally {
      await running?.close();
      process.stdout.write = write;
      process.stderr.write = errWrite;
    }
  });
});
