// MCP servers from the marketplace (FR-049 kind `mcp`, FR-042, FR-199): the MCP area's installer
// handed to the market area, over a signed folder catalog. A registry entry becomes a remote
// server and a `.mcpb` bundle installs through the bundle installer with the marketplace's verdict;
// both update (a bundle's new tool is a permission change to accept, its settings kept), roll
// back when an update fails, and remove with their vault entries and files.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { PluginCatalogs, PluginService, SkillIndex, type AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupMarket, type MarketArea } from '../src/market.ts';
import { setupMcp, type HubMcpArea } from '../src/mcp.ts';
import {
  sha256Hex,
  testPublisher,
  writeCatalog,
} from '../../../packages/core/test/fixtures/market/env.ts';
import { sampleZip } from '../../../packages/mcp/test/bundle-fixture.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

const OWNER = '01920000-0000-7000-8000-0000000000d1';
/** Registry entries are https only; the servers stay off, so nothing is reached. */
const TRACKER = 'https://mcp.tracker.example';
const AS_OWNER = { 'x-test-account': OWNER };
const key = testPublisher();

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let market: MarketArea;
let mcp: HubMcpArea;
let secrets: MemorySecretStore;
let audit: AuditRecord[];
let catalogDir: string;

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-market-mcp-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = '2026-10-19T09:00:00.000Z';
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(OWNER, iso, iso);
  audit = [];
  secrets = new MemorySecretStore();
  const events = new EventStore(db);
  const log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
  const dataDir = join(dir, 'data');
  const auditSink = { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) };
  const skills = new SkillIndex({ db, userDir: join(dataDir, 'skills'), events });
  const plugins = new PluginService({
    db,
    secrets,
    dataDir,
    catalogs: new PluginCatalogs({ cacheDir: join(dataDir, 'cache', 'plugins') }),
    catalogConfigs: () => Promise.resolve([]),
    skills,
    events,
    audit: auditSink,
    novaVersion: '0.8.0',
    log,
  });
  const ctx = {
    db,
    secrets,
    events,
    log,
    diagnostics: new DiagnosticsRegistry(),
    dataDir,
    config: { version: '0.8.0', dataDir },
    setting: (k: SettingKey) =>
      Promise.resolve(
        resolveSetting(k, { global: globalSettings(), project: {}, managed: {} }).value,
      ),
    accountOf: (req: { headers: Record<string, unknown> }) =>
      req.headers['x-test-account'] === OWNER
        ? Promise.resolve(OWNER)
        : Promise.reject(new NovaError('token_required', 'sign in')),
  } as unknown as HubContext;
  mcp = await setupMcp({ ...ctx, audit: auditSink });
  market = await setupMarket(ctx, {
    plugins: { service: plugins, index: skills },
    writeSetting: () => Promise.reject(new Error('no themes in this test')),
    audit: auditSink,
    sampleCatalogDir: null,
    catalogs: {
      fetch: (() =>
        Promise.reject(new Error('no network in this test'))) as unknown as typeof fetch,
      git: () => Promise.reject(new Error('no git in this test')),
    },
  });
  // What app.ts does: the marketplace installs MCP items through the MCP area.
  market.useMcpInstaller(mcp.marketInstaller);
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  mcp.register(app);
  market.register(app);
  await app.ready();
  catalogDir = join(dir, 'catalog');
});

afterEach(async () => {
  await app.close();
  await market.close();
  await mcp.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: AS_OWNER,
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  let json: Json;
  try {
    json = (res.body ? JSON.parse(res.body) : {}) as Json;
  } catch {
    json = {};
  }
  return { status: res.statusCode, json };
}

/** The catalog: a registry entry and a bundle, signed with the test key and pinned to it. */
function publish(opts: { trackerUrl: string; version: string; bundle: Uint8Array }): void {
  mkdirSync(catalogDir, { recursive: true });
  const file = `nova-hello-${opts.version}.mcpb`;
  writeFileSync(join(catalogDir, file), opts.bundle);
  writeCatalog(
    catalogDir,
    {
      items: [
        {
          kind: 'mcp',
          id: 'tracker',
          name: 'Tracker',
          version: opts.version,
          server: { transport: 'http', url: opts.trackerUrl },
        },
        {
          kind: 'mcp',
          id: 'nova-hello',
          name: 'Hello',
          version: opts.version,
          format: 'mcpb',
          path: file,
          sha256: sha256Hex(opts.bundle),
        },
      ],
    },
    key.privateKey,
  );
  putSetting('plugins.catalogs', [
    { id: 'mcp', name: 'MCP', location: catalogDir, publisherKey: key.publicKey },
  ]);
}

const bundleAt = (version: string, extraTool = false) =>
  sampleZip((_files, m) => {
    m.version = version;
    if (extraTool) (m.tools as unknown[]).push({ name: 'farewell', description: 'Say goodbye' });
  });

async function preview(id: string) {
  const p = await call('POST', '/api/v1/market/preview', { catalogId: 'mcp', kind: 'mcp', id });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return p.json;
}

const server = (name: string) =>
  db.raw.prepare('SELECT * FROM mcp_server WHERE account_id = ? AND name = ?').get(OWNER, name) as
    Record<string, string | number | null> | undefined;

describe('MCP items through the marketplace', () => {
  it('installs, updates and removes a registry entry as a remote server', async () => {
    publish({ trackerUrl: `${TRACKER}/v1/mcp`, version: '1.0.0', bundle: bundleAt('1.0.0') });
    const p = await preview('tracker');
    expect(p).toMatchObject({
      verification: { status: 'verified' },
      permissions: [expect.objectContaining({ kind: 'network', key: expect.any(String) })],
      details: { form: 'registry', serverName: 'tracker', transport: 'http' },
      replaces: null,
    });
    // Installed turned off: nothing in a test connects to a remote address.
    const r = await call('POST', '/api/v1/market/install', {
      previewId: p.previewId,
      enable: false,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(server('tracker')).toMatchObject({
      transport: 'http',
      url: `${TRACKER}/v1/mcp`,
      source: 'user',
      enabled: 0,
    });
    const listed = await call('GET', '/api/v1/mcp/servers');
    expect(listed.json.items.map((s: Json) => s.name)).toEqual(['tracker']);
    expect(
      (await call('GET', '/api/v1/market/items?kind=mcp')).json.items.find(
        (i: Json) => i.id === 'tracker',
      ),
    ).toMatchObject({ installedVersion: '1.0.0', updateAvailable: false });

    // An update moves the server to its new address; the same host needs no acceptance.
    publish({ trackerUrl: `${TRACKER}/v2/mcp`, version: '1.1.0', bundle: bundleAt('1.0.0') });
    const u = await preview('tracker');
    expect(u.replaces).toEqual({ version: '1.0.0' });
    expect(u.requires).toMatchObject({ permissionAcceptance: false });
    expect(
      (await call('POST', '/api/v1/market/install', { previewId: u.previewId, enable: false }))
        .status,
    ).toBe(201);
    expect(server('tracker')).toMatchObject({ url: `${TRACKER}/v2/mcp` });
    expect(audit.filter((a) => a.kind === 'mcp').map((a) => a.action)).toEqual(['add', 'update']);

    expect((await call('DELETE', '/api/v1/market/installed/mcp/tracker')).status).toBe(200);
    expect(server('tracker')).toBeUndefined();
    expect((await call('GET', '/api/v1/market/installed')).json.items).toEqual([]);
  });

  it('installs, updates (keeping its settings) and removes a bundle with the marketplace verdict', async () => {
    publish({ trackerUrl: `${TRACKER}/mcp`, version: '1.0.0', bundle: bundleAt('1.0.0') });
    const p = await preview('nova-hello');
    expect(p).toMatchObject({
      version: '1.0.0',
      verification: { status: 'verified' },
      details: { form: 'bundle', serverName: 'nova-hello', serverType: 'node' },
    });
    expect(p.permissions.map((l: Json) => l.kind)).toEqual(['program', 'tool', 'tool']);
    const r = await call('POST', '/api/v1/market/install', {
      previewId: p.previewId,
      userConfig: { greeting: 'Howdy', api_key: 'k-123', notes_dir: '/srv/notes' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const row = server('nova-hello')!;
    expect(row).toMatchObject({ source: 'bundle', signature_status: 'verified' });
    const record = JSON.parse(String(row.install_record_json)) as Json;
    expect(record).toMatchObject({ source: 'catalog', signature: 'verified' });
    expect(await secrets.get(`secret://mcp/${String(row.id)}/config/api_key`)).toBe('k-123');
    expect(existsSync(join(dir, 'data', 'mcp', 'bundles', 'nova-hello', '1.0.0'))).toBe(true);
    expect(audit.find((a) => a.action === 'bundle.install')?.detail?.origin as string).toMatch(
      /^mcp\/nova-hello@1\.0\.0$/,
    );

    // 1.1.0 adds a tool: a permission change to accept by its hash; the settings carry over.
    publish({ trackerUrl: `${TRACKER}/mcp`, version: '1.1.0', bundle: bundleAt('1.1.0', true) });
    const u = await preview('nova-hello');
    expect(u.diff.added).toEqual([expect.objectContaining({ kind: 'tool', key: 'tool:farewell' })]);
    const refused = await call('POST', '/api/v1/market/install', { previewId: u.previewId });
    expect(refused.json.error.details.reason).toBe('permission_diff_not_accepted');
    const ok = await call('POST', '/api/v1/market/install', {
      previewId: u.previewId,
      acceptPermissions: u.diff.hash,
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const updated = server('nova-hello')!;
    expect(updated.id).toBe(row.id);
    expect(JSON.parse(String(updated.bundle_manifest_json))).toMatchObject({ version: '1.1.0' });
    expect(await secrets.get(`secret://mcp/${String(row.id)}/config/api_key`)).toBe('k-123');
    expect(JSON.parse(String(updated.install_record_json))).toMatchObject({
      userConfig: { greeting: 'Howdy', notes_dir: '/srv/notes' },
    });

    expect((await call('DELETE', '/api/v1/market/installed/mcp/nova-hello')).status).toBe(200);
    expect(server('nova-hello')).toBeUndefined();
    expect(await secrets.list(`secret://mcp/${String(row.id)}/`)).toEqual([]);
    expect(existsSync(join(dir, 'data', 'mcp', 'bundles', 'nova-hello'))).toBe(false);
  });

  it('rolls a failed update back to the bundle and settings it replaced', async () => {
    publish({ trackerUrl: `${TRACKER}/mcp`, version: '1.0.0', bundle: bundleAt('1.0.0') });
    const p = await preview('nova-hello');
    await call('POST', '/api/v1/market/install', {
      previewId: p.previewId,
      userConfig: { api_key: 'k-1' },
    });
    const before = server('nova-hello')!;
    // 1.2.0 needs a setting nobody gave: the bundle installer refuses it.
    publish({
      trackerUrl: `${TRACKER}/mcp`,
      version: '1.2.0',
      bundle: sampleZip((_f, m) => {
        m.version = '1.2.0';
        (m.user_config as Json).region = { type: 'string', title: 'Region', required: true };
      }),
    });
    const u = await preview('nova-hello');
    const failed = await call('POST', '/api/v1/market/install', {
      previewId: u.previewId,
      ...(u.diff?.hash ? { acceptPermissions: u.diff.hash } : {}),
    });
    expect(failed.status).toBe(400);
    expect(server('nova-hello')).toMatchObject({
      id: before.id,
      bundle_manifest_json: before.bundle_manifest_json,
    });
    expect(await secrets.get(`secret://mcp/${String(before.id)}/config/api_key`)).toBe('k-1');
    expect(audit.find((a) => a.action === 'market.install.failed')).toMatchObject({
      detail: expect.objectContaining({ rolledBack: true }),
    });
  });

  it('refuses a registry entry that would replace a program server of the same name', async () => {
    publish({ trackerUrl: `${TRACKER}/mcp`, version: '1.0.0', bundle: bundleAt('1.0.0') });
    const added = await call('POST', '/api/v1/mcp/servers', {
      name: 'tracker',
      transport: 'stdio',
      command: 'node',
    });
    expect(added.status).toBe(201);
    const p = await preview('tracker');
    expect(p.warnings).toContain(
      'an MCP server named tracker already exists; remove or rename it first',
    );
    const r = await call('POST', '/api/v1/market/install', {
      previewId: p.previewId,
      acceptPermissions: p.diff.hash,
      enable: false,
    });
    expect(r.status).toBe(409);
    expect(r.json.error.details.reason).toBe('name_taken');
    // The hand-added server is untouched.
    expect(server('tracker')).toMatchObject({ transport: 'stdio', command: 'node' });
  });
});
