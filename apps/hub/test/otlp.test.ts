// OTLP export, the Hub area (FR-223, ADR-097 D6), against a fake collector on 127.0.0.1: off by
// default (nothing reaches the collector), turned on through PUT /api/v1/telemetry/otlp with a
// header whose value goes to the vault, request spans and metrics that name the route and never
// the URL, the Hub's logs redacted with no content unless includeContent is on, settings changes
// and managed policy reconfiguring it, the test button, owner-only routes and the status view.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  type SettingKey,
} from '@nova/shared';
import type { AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupOtlp, type OtlpArea } from '../src/otlp.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

const OWNER = '01920000-0000-7000-8000-0000000000c1';
const MEMBER = '01920000-0000-7000-8000-0000000000c2';
const AS_OWNER = { 'x-test-account': OWNER };

let db: NovaDatabase;
let app: FastifyInstance;
let area: OtlpArea;
let events: EventStore;
let secrets: MemorySecretStore;
let log: Logger;
let audit: AuditRecord[];
let managed: Record<string, unknown>;
let collector: Server;
let endpoint: string;
let received: { path: string; headers: IncomingHttpHeaders; body: Json }[];
let answers: number[];

function globalSettings(): Record<string, unknown> {
  const rows = db.raw
    .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
    .all() as { key: string; value_json: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
}

function putSetting(key: string, value: unknown): void {
  db.raw.prepare("DELETE FROM setting WHERE key = ? AND scope_kind = 'global'").run(key);
  db.raw
    .prepare(
      "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES (?, 'global', '', ?, ?)",
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}

beforeEach(async () => {
  received = [];
  answers = [];
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json,
      });
      res.writeHead(answers.shift() ?? 200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = '2026-10-19T09:00:00.000Z';
  for (const id of [OWNER, MEMBER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  db.raw
    .prepare(
      "INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'owner', ?), (?, 'member', ?)",
    )
    .run(OWNER, iso, MEMBER, iso);
  managed = {};
  audit = [];
  events = new EventStore(db);
  secrets = new MemorySecretStore();
  log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
  const ctx = {
    db,
    secrets,
    events,
    log,
    diagnostics: new DiagnosticsRegistry(),
    setting: (key: SettingKey) =>
      Promise.resolve(
        resolveSetting(key, { global: globalSettings(), project: {}, managed }).value,
      ),
    accountOf: (req: { headers: Record<string, unknown> }) => {
      const a = req.headers['x-test-account'];
      return a === OWNER || a === MEMBER
        ? Promise.resolve(a)
        : Promise.reject(new NovaError('token_required', 'sign in'));
    },
  } as unknown as HubContext;
  area = await setupOtlp(ctx, {
    // A stand-in for the Hub's settings writer (app.ts): a managed lock refuses; the value is
    // stored and announced.
    writeSetting: async (accountId, key, value) => {
      if (resolveSetting(key, { global: globalSettings(), managed }).locked)
        throw new NovaError('policy_denied', `${key} is managed`, {
          details: { reason: 'managed' },
        });
      putSetting(key, value);
      await events.emit({
        name: 'settings.changed',
        actor: 'user',
        accountId,
        payload: { key, scope: 'global' },
      });
    },
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    version: '0.8.0',
    exporter: { flushIntervalMs: 0, metricsIntervalMs: 0, random: () => 0.5 },
  });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  app.decorateRequest('principal', null);
  app.get('/api/v1/threads/:id', (req) => {
    log
      .child('chat')
      .info('read a thread', { prompt: 'tell me my secrets', threadId: (req.params as Json).id });
    return { ok: true };
  });
  app.get('/api/v1/boom', () => {
    throw new Error('boom');
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  db.close();
  await new Promise<void>((r) => collector.close(() => r()));
});

async function call(
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = AS_OWNER,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : {}) as Json };
}

async function turnOn(over: Json = {}) {
  const res = await call('PUT', '/api/v1/telemetry/otlp', {
    enabled: true,
    endpoint,
    headers: { 'x-api-key': 'collector-key-0123456789' },
    ...over,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}

const paths = () => received.map((r) => r.path);

describe('off by default', () => {
  it('sends nothing while off, whatever the Hub does', async () => {
    const status = await call('GET', '/api/v1/telemetry/otlp');
    expect(status.json).toMatchObject({
      enabled: false,
      endpoint: '',
      headers: [],
      signals: { traces: true, metrics: true, logs: true },
      includeContent: false,
      managedOff: false,
      active: false,
    });
    await call('GET', '/api/v1/threads/t1');
    log.error('something', { token: 'x' });
    await area.exporter.flush({ force: true });
    expect(received).toEqual([]);
    // An endpoint alone does not turn it on.
    putSetting('telemetry.otlp.endpoint', endpoint);
    await area.reload();
    expect(area.exporter.active).toBe(false);
  });
});

describe('on', () => {
  it('exports request spans, metrics and redacted logs without content, with the vault header', async () => {
    const view = await turnOn();
    expect(view).toMatchObject({
      enabled: true,
      endpoint,
      active: true,
      headers: [{ name: 'x-api-key', set: true }],
    });
    // The header value is only in the vault; the setting holds its reference.
    expect(globalSettings()['telemetry.otlp.headers']).toEqual({
      'x-api-key': 'secret://telemetry/otlp/header/x-api-key',
    });
    expect(await secrets.get('secret://telemetry/otlp/header/x-api-key')).toBe(
      'collector-key-0123456789',
    );
    expect(JSON.stringify(view)).not.toContain('collector-key');
    expect(audit.find((a) => a.action === 'telemetry.otlp.headers')).toMatchObject({
      kind: 'secret',
      detail: { headers: ['x-api-key'] },
    });

    await call('GET', '/api/v1/threads/abc?access_token=nva_abcdefghijklmnopqrstuvwxyz0123456789');
    await call('GET', '/api/v1/boom');
    log.child('net').warn('peer said Bearer abcdefghijklmnopqrstuvwxyz0123');
    area.exporter.collectMetrics();
    await area.exporter.flush();
    expect(paths()).toEqual(['/v1/traces', '/v1/metrics', '/v1/logs']);
    for (const r of received) expect(r.headers['x-api-key']).toBe('collector-key-0123456789');

    const spans = received[0]!.body.resourceSpans[0].scopeSpans[0].spans as Json[];
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['GET /api/v1/threads/:id', 'GET /api/v1/boom']));
    const boom = spans.find((s) => s.name === 'GET /api/v1/boom')!;
    expect(boom.status).toEqual({ code: 2 });
    expect(received[0]!.body.resourceSpans[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'nova-hub' } },
      { key: 'service.version', value: { stringValue: '0.8.0' } },
    ]);

    const metrics = received[1]!.body.resourceMetrics[0].scopeMetrics[0].metrics as Json[];
    expect(metrics.map((m) => m.name)).toEqual(
      expect.arrayContaining([
        'http.server.request.duration',
        'nova.events',
        'process.memory.usage',
        'process.uptime',
      ]),
    );

    const all = JSON.stringify(received.map((r) => r.body));
    // Route patterns only: the URL (and the token in its query) never leaves.
    expect(all).not.toContain('/api/v1/threads/abc');
    expect(all).not.toContain('nva_abcdefghij');
    expect(all).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    // No content without includeContent.
    expect(all).not.toContain('tell me my secrets');
    const logs = received[2]!.body.resourceLogs[0].scopeLogs[0].logRecords as Json[];
    expect(logs.map((l) => l.body.stringValue)).toEqual(expect.arrayContaining(['read a thread']));
    // The area's own records never feed the export.
    expect(logs.some((l) => l.attributes[0].value.stringValue === 'hub.otlp')).toBe(false);
  });

  it('includes content only when includeContent is turned on', async () => {
    await turnOn({ includeContent: true, signals: { traces: false, metrics: false } });
    await call('GET', '/api/v1/threads/abc');
    await area.exporter.flush();
    expect(paths()).toEqual(['/v1/logs']);
    expect(JSON.stringify(received[0]!.body)).toContain('tell me my secrets');
  });

  it('follows settings changes and backs off when the collector fails', async () => {
    await turnOn({ signals: { traces: false, metrics: false, logs: true } });
    answers.push(503);
    log.info('first');
    await area.exporter.flush();
    const status = await call('GET', '/api/v1/telemetry/otlp');
    expect(status.json).toMatchObject({ failures: 1, lastError: 'the collector answered 503' });
    expect(status.json.queued.logs).toBeGreaterThan(0);
    expect(status.json.nextAttemptAt).not.toBeNull();
    // Turning it off through the settings route drops the queue and stops the log sink.
    putSetting('telemetry.otlp.enabled', false);
    await events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId: OWNER,
      payload: { key: 'telemetry.otlp.enabled' },
    });
    await area.reload();
    expect(area.exporter.active).toBe(false);
    log.info('after');
    expect(area.exporter.stats().queued.logs).toBe(0);
  });

  it('removes a header with null and keeps the others', async () => {
    await turnOn({
      headers: { 'x-api-key': 'k1-0123456789', Authorization: 'Bearer abcdefghijklmnop' },
    });
    const res = await call('PUT', '/api/v1/telemetry/otlp', { headers: { 'x-api-key': null } });
    expect(res.json.headers).toEqual([{ name: 'Authorization', set: true }]);
    expect(await secrets.has('secret://telemetry/otlp/header/x-api-key')).toBe(false);
  });
});

describe('guards', () => {
  it('lets managed policy forbid export, and says so', async () => {
    await turnOn();
    // The policy restricts export and, as the managed area does, locks the switch off too.
    managed['managed.restrict'] = { layers: [{ telemetryExport: false }], failClosed: null };
    managed['telemetry.otlp.enabled'] = false;
    await events.emit({
      name: 'managed.policy.changed',
      actor: 'system',
      payload: { active: true },
    });
    await area.reload();
    expect(area.exporter.active).toBe(false);
    expect((await call('GET', '/api/v1/telemetry/otlp')).json.managedOff).toBe(true);
    const refused = await call('PUT', '/api/v1/telemetry/otlp', { enabled: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatchObject({
      message: "Telemetry export is turned off by your organization's policy",
      details: { reason: 'managed' },
    });
    const test = await call('POST', '/api/v1/telemetry/otlp/test');
    expect(test.status).toBe(403);
    expect(test.json.error.details).toEqual({ reason: 'managed' });
    delete managed['managed.restrict'];
    delete managed['telemetry.otlp.enabled'];
    await area.reload();
    expect(area.exporter.active).toBe(true);
    // A managed lock on a key refuses the write.
    managed['telemetry.otlp.includeContent'] = false;
    expect((await call('PUT', '/api/v1/telemetry/otlp', { includeContent: true })).status).toBe(
      403,
    );
  });

  it('refuses a remote http endpoint and an empty change', async () => {
    const bad = await call('PUT', '/api/v1/telemetry/otlp', {
      endpoint: 'http://collector.example:4318',
    });
    expect(bad.status).toBe(400);
    expect((await call('PUT', '/api/v1/telemetry/otlp', {})).status).toBe(400);
  });

  it("is the owner's: a member and no session are refused", async () => {
    const member = await call('GET', '/api/v1/telemetry/otlp', undefined, {
      'x-test-account': MEMBER,
    });
    expect(member.status).toBe(403);
    expect(member.json.error.details).toEqual({ reason: 'owner_only' });
    expect((await call('GET', '/api/v1/telemetry/otlp', undefined, {})).status).toBe(401);
  });

  it('sends a test record on demand', async () => {
    const none = await call('POST', '/api/v1/telemetry/otlp/test');
    expect(none.json.error.details).toEqual({ field: 'endpoint', reason: 'no_endpoint' });
    await turnOn({ enabled: false });
    const ok = await call('POST', '/api/v1/telemetry/otlp/test');
    expect(ok.json).toEqual({ ok: true, status: 200, error: null });
    expect(received.at(-1)).toMatchObject({
      path: '/v1/logs',
      headers: { 'x-api-key': 'collector-key-0123456789' },
    });
    answers.push(401);
    expect((await call('POST', '/api/v1/telemetry/otlp/test')).json).toEqual({
      ok: false,
      status: 401,
      error: 'the collector answered 401',
    });
  });
});
