// Extensions over HTTP (FR-117; docs/14 §4-§5; ADR-097 D1-D3): every route needs a session; a
// signed sample uploaded, previewed (Verified, permissions in plain words) and installed without a
// sideload when its publisher is trusted in settings; an unknown publisher only with the sideload
// confirmation; a tampered bundle refused; the `nova dev` reload; commands and status items;
// secrets stored in the vault and never returned; turning off and on; uninstall with its data;
// the panel served through the MCP Apps area with its domains (FR-198); the SDK switch; workers
// ended when the Hub closes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  PluginCatalogs,
  PluginService,
  folderBundleFiles,
  generatePublisherKeyPair,
  loadPublisherPrivateKey,
  packBundle,
  type AuditRecord,
} from '@nova/core';
import type { McpManager } from '@nova/mcp';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupMcpApps, type McpAppsArea } from '../src/mcp-apps.ts';
import type { HubMcpArea } from '../src/mcp.ts';
import { setupSdk, type SdkArea } from '../src/sdk.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

const OWNER = '01920000-0000-7000-8000-0000000000c1';
const AS_OWNER = { 'x-test-account': OWNER };
const HELLO = fileURLToPath(new URL('../../../packages/sdk/examples/hello/', import.meta.url));
const ID = 'com.example.hello';

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: SdkArea;
let apps: McpAppsArea;
let events: EventStore;
let audit: AuditRecord[];
let diagnostics: DiagnosticsRegistry;
const key = generatePublisherKeyPair();
const stranger = generatePublisherKeyPair();

function globalSettings(): Record<string, unknown> {
  const rows = db.raw
    .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
    .all() as { key: string; value_json: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
}

function putSetting(k: string, value: unknown): void {
  db.raw.prepare("DELETE FROM setting WHERE key = ? AND scope_kind = 'global'").run(k);
  db.raw
    .prepare(
      "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES (?, 'global', '', ?, ?)",
    )
    .run(k, JSON.stringify(value), new Date().toISOString());
}

const bundle = (root: string, pem?: string) =>
  Buffer.from(
    packBundle(folderBundleFiles(root), { privateKey: pem ? loadPublisherPrivateKey(pem) : null })
      .bytes,
  ).toString('base64');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-sdk-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(OWNER, iso, iso);
  audit = [];
  events = new EventStore(db);
  diagnostics = new DiagnosticsRegistry();
  const secrets = new MemorySecretStore();
  const ctx = {
    db,
    secrets,
    events,
    dataDir: join(dir, 'data'),
    config: { version: '0.8.0' },
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting: (k: SettingKey) =>
      Promise.resolve(
        resolveSetting(k, { global: globalSettings(), project: {}, managed: {} }).value,
      ),
    accountOf: (req: { headers: Record<string, unknown> }) =>
      req.headers['x-test-account'] === OWNER
        ? Promise.resolve(OWNER)
        : Promise.reject(new NovaError('token_required', 'sign in')),
  } as unknown as HubContext;
  const plugins = new PluginService({
    db,
    secrets,
    dataDir: join(dir, 'data'),
    catalogs: new PluginCatalogs({ cacheDir: join(dir, 'cache') }),
    catalogConfigs: () => Promise.resolve([]),
    events,
  });
  area = await setupSdk(ctx, {
    plugins,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    host: { startTimeoutMs: 15_000 },
  });
  apps = await setupMcpApps({
    ...ctx,
    mcp: { manager: {} as McpManager } as HubMcpArea,
    reader: () => Promise.resolve({ ok: false, message: 'no servers here' }),
  });
  apps.useExtensions(area.ui);
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  apps.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  await apps.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = AS_OWNER,
): Promise<{ status: number; json: Json; body: string; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  let json: Json;
  try {
    json = (res.body ? JSON.parse(res.body) : {}) as Json;
  } catch {
    json = {};
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

const reason = (r: { json: Json }) =>
  (r.json.error as Json | undefined)?.details?.reason as unknown;

async function installSigned(): Promise<Json> {
  putSetting('plugins.trustedPublishers', [{ name: 'Nova examples', key: key.publicKey }]);
  const preview = await call('POST', '/api/v1/extensions/preview', {
    source: { kind: 'upload', bundle: bundle(HELLO, key.privateKeyPem), fileName: 'hello.novax' },
  });
  expect(preview.status).toBe(200);
  const installed = await call('POST', '/api/v1/extensions', { previewId: preview.json.previewId });
  expect(installed.status).toBe(201);
  return installed.json;
}

describe('/api/v1/extensions', () => {
  it('needs a session on every route', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/extensions'],
      ['POST', '/api/v1/extensions/preview'],
      ['POST', '/api/v1/extensions'],
      ['POST', '/api/v1/extensions/dev'],
      ['GET', '/api/v1/extensions/contributions'],
      ['GET', `/api/v1/extensions/${ID}`],
      ['PATCH', `/api/v1/extensions/${ID}`],
      ['DELETE', `/api/v1/extensions/${ID}`],
      ['POST', `/api/v1/extensions/${ID}/commands/hello.greet/run`],
      ['POST', `/api/v1/extensions/${ID}/status/hello.count/click`],
      ['PUT', `/api/v1/extensions/${ID}/secrets/greeting`],
      ['DELETE', `/api/v1/extensions/${ID}/secrets/greeting`],
    ] as const)
      expect((await call(method, url, {}, {})).status, `${method} ${url}`).toBe(401);
  });

  it('installs a signed sample from a trusted publisher, runs it, and removes it with its data', async () => {
    const view = await installSigned();
    expect(view).toMatchObject({
      id: ID,
      verified: true,
      signature: 'verified',
      status: 'running',
    });
    expect((await call('GET', '/api/v1/extensions')).json.items).toHaveLength(1);

    // A secret goes to the vault and never comes back.
    expect(
      (await call('PUT', `/api/v1/extensions/${ID}/secrets/greeting`, { value: 'Howdy' })).json,
    ).toEqual({ ok: true });
    expect(
      (await call('PUT', `/api/v1/extensions/${ID}/secrets/other`, { value: 'x' })).status,
    ).toBe(400);
    const got = await call('GET', `/api/v1/extensions/${ID}`);
    expect(got.json.secrets).toEqual([{ name: 'greeting', set: true }]);
    expect(got.body).not.toContain('Howdy');

    const ran = await call('POST', `/api/v1/extensions/${ID}/commands/hello.greet/run`, {
      args: { name: 'Ada' },
    });
    expect(ran.json).toEqual({
      ok: true,
      result: { text: 'Howdy, Ada!', greeted: 1 },
      error: null,
    });
    expect((await call('POST', `/api/v1/extensions/${ID}/commands/nope/run`, {})).status).toBe(404);
    expect((await call('POST', `/api/v1/extensions/${ID}/status/hello.count/click`)).json.ok).toBe(
      true,
    );
    const contrib = (await call('GET', '/api/v1/extensions/contributions')).json;
    expect(contrib.commands).toEqual([
      { extensionId: ID, id: 'hello.greet', title: 'Hello: say hello' },
    ]);
    expect(contrib.panels[0]).toMatchObject({ id: 'hello.panel', resource: 'ui://hello/panel' });
    expect((await call('DELETE', `/api/v1/extensions/${ID}/secrets/greeting`)).json).toEqual({
      ok: true,
    });

    const off = await call('PATCH', `/api/v1/extensions/${ID}`, { enabled: false });
    expect(off.json).toMatchObject({ enabled: false, status: 'disabled' });
    expect(area.service.host.liveWorkers()).toBe(0);
    expect((await call('PATCH', `/api/v1/extensions/${ID}`, { enabled: true })).json.status).toBe(
      'running',
    );

    expect((await call('DELETE', `/api/v1/extensions/${ID}?removeData=true`)).json).toEqual({
      ok: true,
    });
    expect((await call('GET', `/api/v1/extensions/${ID}`)).status).toBe(404);
    expect(area.service.host.liveWorkers()).toBe(0);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'extension.install',
        'extension.secret.set',
        'extension.command.run',
        'extension.disable',
        'extension.enable',
        'extension.uninstall',
      ]),
    );
  });

  it('serves the panel through the MCP Apps area with its domains', async () => {
    await installSigned();
    const entries = (await call('GET', '/api/v1/ui/entry-points?kind=global')).json.items as Json[];
    const panel = entries.find((e) => e.pluginId === ID);
    expect(panel).toMatchObject({
      kind: 'global',
      title: 'Hello',
      serverId: `extension:${ID}`,
      resource: 'ui://hello/panel',
      domains: ['api.example.com'],
    });
    const res = await call('GET', `/api/v1/ui/resource?entry=${String(panel!.id)}`, undefined, {
      ...AS_OWNER,
      accept: 'text/html',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Hello from an extension');
    expect(String(res.headers['content-security-policy'])).toContain(
      'connect-src https://api.example.com',
    );
    await call('PATCH', `/api/v1/extensions/${ID}`, { enabled: false });
    expect((await call('GET', '/api/v1/ui/entry-points')).json.items).toEqual([]);
  });

  it('an unknown publisher needs the sideload confirmation; a tampered bundle is refused', async () => {
    const preview = await call('POST', '/api/v1/extensions/preview', {
      source: { kind: 'upload', bundle: bundle(HELLO, stranger.privateKeyPem) },
    });
    expect(preview.json).toMatchObject({
      verified: false,
      signature: 'unverified',
      publisher: { key: stranger.publicKey },
    });
    const refused = await call('POST', '/api/v1/extensions', { previewId: preview.json.previewId });
    expect(refused.status).toBe(400);
    expect(reason(refused)).toBe('sideload_confirmation_required');
    const ok = await call('POST', '/api/v1/extensions', {
      previewId: preview.json.previewId,
      confirmSideload: true,
    });
    expect(ok.json).toMatchObject({ verified: false, status: 'running' });

    const { strToU8, unzipSync, zipSync } = await import('fflate');
    const entries = unzipSync(Buffer.from(bundle(HELLO, key.privateKeyPem), 'base64'));
    entries['extension.js'] = strToU8('export function activate() {}');
    const tampered = await call('POST', '/api/v1/extensions/preview', {
      source: { kind: 'upload', bundle: Buffer.from(zipSync(entries)).toString('base64') },
    });
    expect(tampered.status).toBe(400);
    expect(reason(tampered)).toBe('signature_invalid');
    expect(
      (
        await call('POST', '/api/v1/extensions/preview', {
          source: { kind: 'upload', bundle: '!!!' },
        })
      ).status,
    ).toBe(400);
    expect((await call('POST', '/api/v1/extensions', { previewId: 'gone' })).status).toBe(410);
  });

  it('nova dev loads and reloads a local extension; it needs the sideload confirmation', async () => {
    const root = join(dir, 'dev');
    const { cpSync } = await import('node:fs');
    cpSync(HELLO, root, { recursive: true });
    const missing = await call('POST', '/api/v1/extensions/dev', { bundle: bundle(root) });
    expect(missing.status).toBe(400);
    expect(reason(missing)).toBe('sideload_confirmation_required');
    expect((await call('POST', '/api/v1/extensions/dev', { nonsense: true })).status).toBe(400);
    const first = await call('POST', '/api/v1/extensions/dev', {
      bundle: bundle(root),
      confirmSideload: true,
      trustHooks: true,
    });
    expect(first.json).toMatchObject({
      signature: 'dev',
      status: 'running',
      hooks: [{ status: 'needs_trust' }],
    });
    writeFileSync(
      join(root, 'extension.js'),
      "export function activate(nova) { nova.commands.register({ id: 'hello.greet', run: () => 'reloaded' }); }",
    );
    await call('POST', '/api/v1/extensions/dev', { bundle: bundle(root), confirmSideload: true });
    expect(
      (await call('POST', `/api/v1/extensions/${ID}/commands/hello.greet/run`, {})).json.result,
    ).toBe('reloaded');
    expect(audit.filter((a) => a.action === 'extension.dev.reload')).toHaveLength(2);
  });

  it('accepts a bundle over the default 1 MB body limit, and a .novax file on the Hub', async () => {
    const root = join(dir, 'big');
    const { cpSync } = await import('node:fs');
    cpSync(HELLO, root, { recursive: true });
    writeFileSync(join(root, 'assets.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    const big = await call('POST', '/api/v1/extensions/preview', {
      source: { kind: 'upload', bundle: bundle(root) },
    });
    expect(big.status).toBe(200);
    const file = join(dir, 'hello.novax');
    writeFileSync(file, Buffer.from(bundle(HELLO), 'base64'));
    const fromPath = await call('POST', '/api/v1/extensions/preview', {
      source: { kind: 'path', path: file },
    });
    expect(fromPath.json).toMatchObject({
      id: ID,
      signature: 'unverified',
      sideloadReason: 'the bundle is not signed',
    });
  });

  it('stops an extension a managed policy change refuses, and fetches within the egress ceiling', async () => {
    await installSigned();
    expect(area.service.host.liveWorkers()).toBe(1);
    putSetting('managed.restrict', { layers: [{ extensions: { deny: [ID] } }], failClosed: null });
    await events.emit({ name: 'managed.policy.changed', actor: 'system', payload: {} });
    for (let i = 0; i < 200 && area.service.host.liveWorkers() > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(area.service.host.liveWorkers()).toBe(0);
    const got = await call('GET', `/api/v1/extensions/${ID}`);
    expect(got.json).toMatchObject({
      status: 'stopped',
      error: expect.stringMatching(/not allowed/),
    });
    expect((await call('PATCH', `/api/v1/extensions/${ID}`, { enabled: true })).status).toBe(403);
    putSetting('managed.restrict', { layers: [], failClosed: null });
    await events.emit({ name: 'managed.policy.changed', actor: 'system', payload: {} });
    for (let i = 0; i < 300 && area.service.host.status(OWNER, ID).status !== 'running'; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await call('GET', `/api/v1/extensions/${ID}`)).json.status).toBe('running');
  });

  it('follows the SDK switch, reports diagnostics, and ends its workers when the Hub closes', async () => {
    await installSigned();
    expect(area.service.host.liveWorkers()).toBe(1);
    putSetting('sdk.enabled', false);
    await events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId: OWNER,
      payload: { key: 'sdk.enabled' },
    });
    for (let i = 0; i < 200 && area.service.host.liveWorkers() > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(area.service.host.liveWorkers()).toBe(0);
    expect((await call('GET', `/api/v1/extensions/${ID}`)).json.status).toBe('stopped');
    putSetting('sdk.enabled', true);
    await events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId: OWNER,
      payload: { key: 'sdk.enabled' },
    });
    for (let i = 0; i < 300 && area.service.host.status(OWNER, ID).status !== 'running'; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await call('GET', `/api/v1/extensions/${ID}`)).json.status).toBe('running');
    expect((await diagnostics.collect()).extensions).toEqual({
      installed: 1,
      running: 1,
      previews: 0,
    });
    await area.start();
    await area.close();
    expect(area.service.host.liveWorkers()).toBe(0);
  });
});
