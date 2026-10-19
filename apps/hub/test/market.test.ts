// Marketplace area (FR-049; docs/14 §5, docs/08 §7; ADR-097 D2, D4) over HTTP: the built-in sample
// catalog (offline, pinned key) and its third-party theme and plugin installed Verified; a
// folder catalog from `plugins.catalogs` that is unsigned (sideload confirmation, Unverified) or
// tampered (refused); an update's permission diff accepted by its hash; managed policy forbidding
// unverified installs and denying a plugin; the owner's sideload switch; ratings; pets and their
// frames; screenshots; MCP items only once the MCP area hands over its installer; sessions.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  ExtensionService,
  PluginCatalogs,
  PluginService,
  SkillIndex,
  managedRestrictions,
  type AuditRecord,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupMarket, type MarketArea } from '../src/market.ts';
import {
  fakeMcpInstaller,
  folderDigest,
  petFolder,
  pluginFolder,
  sha256Hex,
  testPublisher,
  writeCatalog,
  zipOf,
} from '../../../packages/core/test/fixtures/market/env.ts';
import { EXAMPLE_LABS_PUBLIC_KEY } from '../../../packages/core/test/fixtures/market/sample-key.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

const OWNER = '01920000-0000-7000-8000-0000000000c1';
const AS_OWNER = { 'x-test-account': OWNER };

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: MarketArea;
let events: EventStore;
let audit: AuditRecord[];
let managed: Record<string, unknown>;
let diagnostics: DiagnosticsRegistry;
let plugins: PluginService;
let skills: SkillIndex;
const key = testPublisher();

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
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-market-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = '2026-10-19T09:00:00.000Z';
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(OWNER, iso, iso);
  managed = {};
  audit = [];
  events = new EventStore(db);
  diagnostics = new DiagnosticsRegistry();
  const log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
  const dataDir = join(dir, 'data');
  skills = new SkillIndex({ db, userDir: join(dataDir, 'skills'), events });
  plugins = new PluginService({
    db,
    secrets: new MemorySecretStore(),
    dataDir,
    catalogs: new PluginCatalogs({ cacheDir: join(dataDir, 'cache', 'plugins') }),
    catalogConfigs: () => Promise.resolve([]),
    skills,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    novaVersion: '0.8.0',
    // The plugin installer reads managed policy itself (FR-106), as app.ts wires it.
    managed: () =>
      Promise.resolve(
        managedRestrictions(
          resolveSetting('managed.restrict', { global: globalSettings(), project: {}, managed })
            .value,
        ),
      ),
    log,
  });
  const ctx = {
    db,
    secrets: new MemorySecretStore(),
    events,
    log,
    diagnostics,
    dataDir,
    config: { version: '0.8.0' },
    setting: (k: SettingKey) =>
      Promise.resolve(resolveSetting(k, { global: globalSettings(), project: {}, managed }).value),
    accountOf: (req: { headers: Record<string, unknown> }) =>
      req.headers['x-test-account'] === OWNER
        ? Promise.resolve(OWNER)
        : Promise.reject(new NovaError('token_required', 'sign in')),
  } as unknown as HubContext;
  area = await setupMarket(ctx, {
    plugins: { service: plugins, index: skills },
    // A stand-in for the Hub's settings writer: a managed lock refuses, the value is stored.
    writeSetting: (accountId, k, value) => {
      if (resolveSetting(k, { global: globalSettings(), project: {}, managed }).locked)
        return Promise.reject(new NovaError('policy_denied', `${k} is managed`));
      putSetting(k, value);
      return events
        .emit({
          name: 'settings.changed',
          actor: 'user',
          accountId,
          payload: { key: k, scope: 'global' },
        })
        .then(() => undefined);
    },
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    catalogs: {
      fetch: (() =>
        Promise.reject(new Error('no network in this test'))) as unknown as typeof fetch,
      git: () => Promise.reject(new Error('no git in this test')),
    },
  });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = AS_OWNER,
): Promise<{ status: number; json: Json; headers: Record<string, unknown>; raw: Buffer }> {
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
  return { status: res.statusCode, json, headers: res.headers, raw: res.rawPayload };
}

const reason = (r: { json: Json }) =>
  (r.json.error as Json | undefined)?.details?.reason as unknown;

async function install(
  catalogId: string,
  kind: string,
  id: string,
  extra: Json = {},
): Promise<{ preview: Json; res: Awaited<ReturnType<typeof call>> }> {
  const p = await call('POST', '/api/v1/market/preview', { catalogId, kind, id });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const res = await call('POST', '/api/v1/market/install', {
    previewId: p.json.previewId,
    ...extra,
  });
  return { preview: p.json, res };
}

/** A folder catalog in `plugins.catalogs` (signed with the test key unless `signed` is false). */
function folderCatalog(id: string, items: unknown[], signed = true, root = join(dir, id)): string {
  writeCatalog(root, { items }, signed ? key.privateKey : undefined);
  const list = (globalSettings()['plugins.catalogs'] as Json[] | undefined) ?? [];
  putSetting('plugins.catalogs', [
    ...list.filter((c) => c.id !== id),
    { id, name: id, location: root, ...(signed ? { publisherKey: key.publicKey } : {}) },
  ]);
  return root;
}

describe('the built-in sample catalog', () => {
  it('lists the catalog, verified by its pinned key, and its items', async () => {
    const cats = await call('GET', '/api/v1/market/catalogs');
    expect(cats.json.items).toEqual([
      expect.objectContaining({
        id: 'nova-sample',
        kind: 'builtin',
        signature: 'verified',
        items: 5,
      }),
    ]);
    const all = await call('GET', '/api/v1/market/items');
    expect(all.json.items.map((i: Json) => i.id)).toEqual([
      'com.examplelabs.release-notes',
      'com.example.sample',
      'com.examplelabs.word-count',
      'standup',
      'com.examplelabs.aurora',
    ]);
    const themes = await call('GET', '/api/v1/market/items?kind=theme');
    expect(themes.json.items).toEqual([
      expect.objectContaining({
        id: 'com.examplelabs.aurora',
        verified: true,
        author: 'Example Labs',
      }),
    ]);
    const detail = await call(
      'GET',
      '/api/v1/market/items/nova-sample/plugin/com.examplelabs.release-notes',
    );
    expect(detail.json).toMatchObject({
      versions: ['1.0.0'],
      changelog: [{ version: '1.0.0', notes: 'First release.' }],
    });
    expect((await call('GET', '/api/v1/market/items?kind=nope')).status).toBe(400);
  });

  it('installs the third-party theme into the saved themes and the plugin Verified', async () => {
    const theme = await install('nova-sample', 'theme', 'com.examplelabs.aurora');
    expect(theme.res.status).toBe(201);
    expect(theme.res.json).toMatchObject({ kind: 'theme', verified: true });
    expect((globalSettings()['appearance.customThemes'] as Json[]).map((t) => t.id)).toEqual([
      'com.examplelabs.aurora',
    ]);

    const plugin = await install('nova-sample', 'plugin', 'com.examplelabs.release-notes');
    expect(plugin.preview).toMatchObject({
      verification: { status: 'verified', reasons: [] },
      requires: { sideloadConfirmation: false, permissionAcceptance: false },
      permissions: expect.arrayContaining([
        expect.objectContaining({ text: 'Use files in ${project}' }),
      ]),
    });
    expect(plugin.res.status).toBe(201);
    expect((await plugins.get(OWNER, 'com.examplelabs.release-notes')).verified).toBe(true);
    const installed = await call('GET', '/api/v1/market/installed');
    expect(installed.json.items.map((i: Json) => `${i.kind}:${i.itemId}:${i.verified}`)).toEqual([
      'plugin:com.examplelabs.release-notes:true',
      'theme:com.examplelabs.aurora:true',
    ]);
    expect(
      (await events.since(null, 100, { accountId: OWNER, systemEvents: true })).map((e) => e.name),
    ).toEqual(expect.arrayContaining(['market.installed', 'plugin.installed']));

    expect(
      (await call('DELETE', '/api/v1/market/installed/theme/com.examplelabs.aurora')).status,
    ).toBe(200);
    expect(globalSettings()['appearance.customThemes']).toEqual([]);
    expect(
      (await call('DELETE', '/api/v1/market/installed/theme/com.examplelabs.aurora')).status,
    ).toBe(404);
  });

  it('a managed lock on the saved themes refuses the install and changes nothing', async () => {
    managed['appearance.customThemes'] = [];
    const theme = await install('nova-sample', 'theme', 'com.examplelabs.aurora');
    expect(theme.res.status).toBe(403);
    expect(globalSettings()['appearance.customThemes']).toBeUndefined();
    expect(audit.find((a) => a.action === 'market.install.failed')).toBeTruthy();
  });
});

describe('folder catalogs', () => {
  it('needs the sideload confirmation for an unsigned item and labels it Unverified', async () => {
    const root = join(dir, 'loose');
    pluginFolder(join(root, 'notes'));
    folderCatalog(
      'loose',
      [{ kind: 'plugin', id: 'com.test.notes', name: 'Notes', version: '1.0.0', path: 'notes' }],
      false,
    );
    const p = await call('POST', '/api/v1/market/preview', {
      catalogId: 'loose',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.json).toMatchObject({
      verification: { status: 'unverified' },
      requires: { sideloadConfirmation: true },
      allowed: true,
    });
    const refused = await call('POST', '/api/v1/market/install', { previewId: p.json.previewId });
    expect(refused.status).toBe(400);
    expect(reason(refused)).toBe('sideload_confirmation_required');
    const ok = await call('POST', '/api/v1/market/install', {
      previewId: p.json.previewId,
      confirmSideload: true,
    });
    expect(ok.status).toBe(201);
    expect(ok.json.verified).toBe(false);
    expect((await plugins.get(OWNER, 'com.test.notes')).verified).toBe(false);
  });

  it('refuses a catalog whose index was changed after signing', async () => {
    const root = join(dir, 'bad');
    const plugin = pluginFolder(join(root, 'notes'));
    folderCatalog('bad', [
      {
        kind: 'plugin',
        id: 'com.test.notes',
        name: 'Notes',
        version: '1.0.0',
        path: 'notes',
        digest: folderDigest(plugin),
      },
    ]);
    writeFileSync(
      join(root, 'catalog.json'),
      readFileSync(join(root, 'catalog.json'), 'utf8').replace('Notes', 'Nates'),
    );
    const cats = await call('GET', '/api/v1/market/catalogs');
    expect(cats.json.items.find((c: Json) => c.id === 'bad')).toMatchObject({
      signature: 'invalid',
      items: 0,
    });
    const p = await call('POST', '/api/v1/market/preview', {
      catalogId: 'bad',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.status).toBe(400);
    expect(reason(p)).toBe('catalog_signature_invalid');
  });

  it('shows an update’s permission diff and installs it once accepted', async () => {
    const root = join(dir, 'up');
    const v1 = pluginFolder(join(root, 'v1'));
    folderCatalog('up', [
      {
        kind: 'plugin',
        id: 'com.test.notes',
        name: 'Notes',
        version: '1.0.0',
        path: 'v1',
        digest: folderDigest(v1),
      },
    ]);
    expect((await install('up', 'plugin', 'com.test.notes')).res.status).toBe(201);
    const v2 = pluginFolder(join(root, 'v2'), { version: '2.0.0', network: ['api.example.com'] });
    folderCatalog('up', [
      {
        kind: 'plugin',
        id: 'com.test.notes',
        name: 'Notes',
        version: '1.0.0',
        path: 'v1',
        digest: folderDigest(v1),
      },
      {
        kind: 'plugin',
        id: 'com.test.notes',
        name: 'Notes',
        version: '2.0.0',
        path: 'v2',
        digest: folderDigest(v2),
      },
    ]);
    const items = await call('GET', '/api/v1/market/items?catalogId=up');
    expect(items.json.items[0]).toMatchObject({ installedVersion: '1.0.0', updateAvailable: true });
    const p = await call('POST', '/api/v1/market/preview', {
      catalogId: 'up',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.json.diff.added).toEqual([
      expect.objectContaining({ text: 'Reach api.example.com on the network' }),
    ]);
    const refused = await call('POST', '/api/v1/market/install', { previewId: p.json.previewId });
    expect(reason(refused)).toBe('permission_diff_not_accepted');
    const ok = await call('POST', '/api/v1/market/install', {
      previewId: p.json.previewId,
      acceptPermissions: p.json.diff.hash,
    });
    expect(ok.status).toBe(201);
    expect((await plugins.get(OWNER, 'com.test.notes')).version).toBe('2.0.0');
  });

  it('serves screenshots as images and pets with their frames', async () => {
    const root = join(dir, 'pets');
    mkdirSync(root, { recursive: true });
    const zip = zipOf(petFolder(join(dir, 'owl-src')));
    writeFileSync(join(root, 'owl.zip'), zip);
    writeFileSync(join(root, 'shot.png'), Buffer.from('png bytes'));
    folderCatalog('pets', [
      {
        kind: 'pet',
        id: 'com.test.owl',
        name: 'Owl',
        version: '1.0.0',
        path: 'owl.zip',
        sha256: sha256Hex(zip),
        screenshots: ['shot.png', 'notes.txt'],
      },
    ]);
    const shot = await call('GET', '/api/v1/market/items/pets/pet/com.test.owl/screenshots/0');
    expect(shot.status).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');
    expect(shot.raw.toString()).toBe('png bytes');
    expect(
      (await call('GET', '/api/v1/market/items/pets/pet/com.test.owl/screenshots/1')).status,
    ).toBe(400);
    expect(
      (await call('GET', '/api/v1/market/items/pets/pet/com.test.owl/screenshots/2')).status,
    ).toBe(404);

    expect((await install('pets', 'pet', 'com.test.owl')).res.status).toBe(201);
    const list = await call('GET', '/api/v1/market/pets');
    expect(list.json.items).toEqual([expect.objectContaining({ id: 'com.test.owl', name: 'Owl' })]);
    const frame = await call('GET', '/api/v1/market/pets/com.test.owl/files/frames/idle-1.png');
    expect(frame.status).toBe(200);
    expect(frame.headers['content-type']).toBe('image/png');
    expect((await call('GET', '/api/v1/market/pets/com.test.owl/files/pet.json')).status).toBe(404);
    expect(
      (await call('GET', '/api/v1/market/pets/com.test.owl/files/..%2F..%2Fsecret.png')).status,
    ).toBe(404);
    expect(
      (await call('GET', '/api/v1/market/pets/com.test.nope/files/frames/idle-1.png')).status,
    ).toBe(404);
  });
});

describe('policy', () => {
  function looseCatalog() {
    const root = join(dir, 'loose');
    pluginFolder(join(root, 'notes'));
    folderCatalog(
      'loose',
      [{ kind: 'plugin', id: 'com.test.notes', name: 'Notes', version: '1.0.0', path: 'notes' }],
      false,
    );
  }

  it('under restrict.unverifiedInstalls: false a verified catalog plugin installs and an unverified one is refused', async () => {
    looseCatalog();
    managed['managed.restrict'] = { layers: [{ unverifiedInstalls: false }], failClosed: null };
    const p = await call('POST', '/api/v1/market/preview', {
      catalogId: 'loose',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.json).toMatchObject({ allowed: false, blockedBy: 'managed' });
    const r = await call('POST', '/api/v1/market/install', {
      previewId: p.json.previewId,
      confirmSideload: true,
    });
    expect(r.status).toBe(403);
    expect(reason(r)).toBe('managed');
    expect(audit.find((a) => a.action === 'market.refuse')).toMatchObject({ decision: 'denied' });
    await expect(plugins.get(OWNER, 'com.test.notes')).rejects.toMatchObject({
      code: 'not_found',
    });
    // A verified plugin from a signed catalog passes both the marketplace and the plugin
    // installer, which gets the verdict as its provenance.
    const ok = await install('nova-sample', 'plugin', 'com.examplelabs.release-notes');
    expect(ok.res.status, JSON.stringify(ok.res.json)).toBe(201);
    expect(await plugins.get(OWNER, 'com.examplelabs.release-notes')).toMatchObject({
      verified: true,
      source: 'catalog',
      origin: 'nova-sample/com.examplelabs.release-notes@1.0.0',
    });
    expect(audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      verified: true,
      via: 'nova-sample',
    });
    expect((await install('nova-sample', 'theme', 'com.examplelabs.aurora')).res.status).toBe(201);
  });

  it('managed policy can deny a plugin by id, even a verified one', async () => {
    managed['managed.restrict'] = {
      layers: [{ plugins: { deny: ['com.examplelabs.*'] } }],
      failClosed: null,
    };
    const p = await call('POST', '/api/v1/market/preview', {
      catalogId: 'nova-sample',
      kind: 'plugin',
      id: 'com.examplelabs.release-notes',
    });
    expect(p.json).toMatchObject({ allowed: false, blockedBy: 'managed' });
    const r = await call('POST', '/api/v1/market/install', { previewId: p.json.previewId });
    expect(r.status).toBe(403);
  });

  it('the owner can turn sideloading off and limit the kinds', async () => {
    looseCatalog();
    putSetting('market.allowSideload', false);
    const p = await call('POST', '/api/v1/market/preview', {
      catalogId: 'loose',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.json.blockedBy).toBe('sideload_disabled');
    expect(
      reason(
        await call('POST', '/api/v1/market/install', {
          previewId: p.json.previewId,
          confirmSideload: true,
        }),
      ),
    ).toBe('sideload_disabled');
    putSetting('market.allowedKinds', ['plugin']);
    const t = await call('POST', '/api/v1/market/preview', {
      catalogId: 'nova-sample',
      kind: 'theme',
      id: 'com.examplelabs.aurora',
    });
    expect(t.json.blockedBy).toBe('kind_not_allowed');
  });
});

describe('extensions', () => {
  it('installs the sample catalog’s signed .novax through the extension installer, Verified with its publisher', async () => {
    const ext = new ExtensionService({
      db,
      secrets: new MemorySecretStore(),
      dataDir: join(dir, 'data'),
      plugins,
      settings: {
        // Workers stay off here; the verdict and the publisher do not depend on them.
        enabled: () => Promise.resolve(false),
        trustedPublishers: () =>
          Promise.resolve(
            (globalSettings()['plugins.trustedPublishers'] as { name: string; key: string }[]) ??
              [],
          ),
      },
      events,
      audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    });
    area.useExtensionInstaller(ext);
    try {
      putSetting('plugins.trustedPublishers', [
        { name: 'Example Labs', key: EXAMPLE_LABS_PUBLIC_KEY },
      ]);
      const { preview, res } = await install('nova-sample', 'plugin', 'com.examplelabs.word-count');
      expect(preview.verification).toMatchObject({
        status: 'verified',
        publisher: { key: EXAMPLE_LABS_PUBLIC_KEY, name: 'Example Labs' },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(await ext.get(OWNER, 'com.examplelabs.word-count')).toMatchObject({
        verified: true,
        publisher: { key: EXAMPLE_LABS_PUBLIC_KEY, name: 'Example Labs', trusted: true },
      });
      expect(
        (await call('DELETE', '/api/v1/market/installed/plugin/com.examplelabs.word-count')).status,
      ).toBe(200);
      await expect(ext.get(OWNER, 'com.examplelabs.word-count')).rejects.toMatchObject({
        code: 'not_found',
      });
    } finally {
      area.useExtensionInstaller(null);
      await ext.close();
    }
  });
});

describe('MCP items', () => {
  it('answer capability_missing until the MCP area hands over its installer', async () => {
    folderCatalog('mcp', [
      {
        kind: 'mcp',
        id: 'linear',
        name: 'Linear',
        version: '1.0.0',
        server: { transport: 'http', url: 'https://mcp.linear.example/mcp' },
      },
    ]);
    const p = await call('POST', '/api/v1/market/preview', {
      catalogId: 'mcp',
      kind: 'mcp',
      id: 'linear',
    });
    expect(p.status).toBe(400);
    expect(p.json.error.code).toBe('capability_missing');
    const fake = fakeMcpInstaller();
    area.useMcpInstaller(fake);
    expect((await install('mcp', 'mcp', 'linear')).res.status).toBe(201);
    expect([...fake.servers.keys()]).toEqual(['linear']);
    expect(await diagnostics.collect()).toMatchObject({
      market: { catalogs: 2, pets: 0, mcpInstaller: true },
    });
    area.useMcpInstaller(null);
    expect((await call('DELETE', '/api/v1/market/installed/mcp/linear')).status).toBe(400);
  });
});

describe('ratings', () => {
  it('rates, lists and removes ratings; nothing is shared', async () => {
    const r = await call('PUT', '/api/v1/market/ratings', {
      kind: 'theme',
      itemId: 'com.examplelabs.aurora',
      stars: 5,
      review: 'Lovely',
    });
    expect(r.json).toMatchObject({ stars: 5, review: 'Lovely', shared: false });
    expect(
      (await call('PUT', '/api/v1/market/ratings', { kind: 'theme', itemId: 'x', stars: 6 }))
        .status,
    ).toBe(400);
    expect((await call('GET', '/api/v1/market/ratings')).json.items).toHaveLength(1);
    const items = await call('GET', '/api/v1/market/items?kind=theme');
    expect(items.json.items[0].rating).toMatchObject({ stars: 5 });
    expect(
      (await call('DELETE', '/api/v1/market/ratings/theme/com.examplelabs.aurora')).status,
    ).toBe(200);
    expect((await call('GET', '/api/v1/market/ratings')).json.items).toEqual([]);
  });
});

it('every route needs a session', async () => {
  for (const [method, url] of [
    ['GET', '/api/v1/market/catalogs'],
    ['GET', '/api/v1/market/items'],
    ['GET', '/api/v1/market/items/nova-sample/theme/com.examplelabs.aurora'],
    ['GET', '/api/v1/market/items/nova-sample/theme/com.examplelabs.aurora/screenshots/0'],
    ['POST', '/api/v1/market/preview'],
    ['POST', '/api/v1/market/install'],
    ['GET', '/api/v1/market/installed'],
    ['DELETE', '/api/v1/market/installed/theme/x'],
    ['GET', '/api/v1/market/ratings'],
    ['PUT', '/api/v1/market/ratings'],
    ['DELETE', '/api/v1/market/ratings/theme/x'],
    ['GET', '/api/v1/market/pets'],
    ['GET', '/api/v1/market/pets/com.test.owl/files/frames/a.png'],
  ] as const) {
    const r = await call(method, url, method === 'GET' || method === 'DELETE' ? undefined : {}, {});
    expect(r.status, `${method} ${url}`).toBe(401);
  }
});
