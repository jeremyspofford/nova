// The marketplace (FR-049; docs/14 §5, docs/08 §7; ADR-097 D2, D4) over each source: the built-in
// sample catalog offline, a folder on the Hub, a Git catalog pinned to a commit, a remote catalog
// over HTTPS (a fake server on 127.0.0.1). A bad catalog signature is refused; an unsigned item
// installs only with the sideload confirmation and stays Unverified; an update shows its
// permission diff and needs it accepted; a failed install is rolled back; managed policy can
// forbid unverified installs; `.novax` bundles, skills, themes, pets and MCP items; ratings stay
// on the Hub.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, type MarketPreview } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  Marketplace,
  MarketSources,
  SAMPLE_CATALOG_ID,
  SAMPLE_CATALOG_PUBLIC_KEY,
  signCatalogIndex,
} from '../src/market/index.ts';
import { PluginCatalogs, type GitRunner } from '../src/plugins/catalog.ts';
import {
  ACCOUNT,
  SAMPLE_CATALOG,
  folderDigest,
  makeNovax,
  marketEnv,
  openMarketDb,
  petFolder,
  pluginFolder,
  sha256Hex,
  skillFolder,
  testPublisher,
  themeFile,
  writeCatalog,
  zipOf,
  type MarketEnv,
} from './fixtures/market/env.ts';
import { startFakeCatalog, type FakeCatalogServer } from './fixtures/market/fake-catalog-server.ts';

let dir: string;
let db: NovaDatabase;
let env: MarketEnv;
const key = testPublisher();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-market-'));
  db = await openMarketDb();
  env = marketEnv(dir, db);
});
afterEach(() => {
  env.market.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A signed folder catalog with one plugin, trusted through the trusted publishers. */
function signedPluginCatalog(name = 'cat', spec: Parameters<typeof pluginFolder>[1] = {}) {
  const root = join(dir, name);
  const plugin = pluginFolder(join(root, 'notes'), spec);
  writeCatalog(
    root,
    {
      items: [
        {
          kind: 'plugin',
          id: spec.id ?? 'com.test.notes',
          name: 'Notes',
          version: spec.version ?? '1.0.0',
          path: 'notes',
          digest: folderDigest(plugin),
        },
      ],
    },
    key.privateKey,
  );
  env.catalogs.push({ id: name, name: 'Test catalog', location: root });
  env.trusted.push({ name: 'Test publisher', key: key.publicKey });
  return root;
}

async function installFrom(
  catalogId: string,
  kind: MarketPreview['kind'],
  id: string,
  extra: Record<string, unknown> = {},
  version?: string,
) {
  const p = await env.market.preview(ACCOUNT, {
    catalogId,
    kind,
    id,
    ...(version ? { version } : {}),
  });
  return { p, view: await env.market.install(ACCOUNT, { previewId: p.previewId, ...extra }) };
}

describe('the built-in sample catalog', () => {
  beforeEach(() => {
    env.catalogs.push({
      id: SAMPLE_CATALOG_ID,
      name: 'Sample catalog',
      location: SAMPLE_CATALOG,
      builtin: true,
      publisherKey: SAMPLE_CATALOG_PUBLIC_KEY,
    });
  });

  it('is signed by its pinned key and lists every tab offline', async () => {
    expect(await env.market.catalogs()).toEqual([
      {
        id: SAMPLE_CATALOG_ID,
        name: 'Sample catalog',
        location: SAMPLE_CATALOG,
        kind: 'builtin',
        signature: 'verified',
        publisher: { name: null, key: SAMPLE_CATALOG_PUBLIC_KEY },
        commit: null,
        items: 5,
        error: null,
      },
    ]);
    const items = await env.market.search(ACCOUNT);
    expect(items.map((i) => `${i.kind}:${i.id}:${i.verified}`)).toEqual([
      'plugin:com.examplelabs.release-notes:true',
      'plugin:com.example.sample:true',
      'plugin:com.examplelabs.word-count:true',
      'skill:standup:true',
      'theme:com.examplelabs.aurora:true',
    ]);
    const notes = items.find((i) => i.id === 'com.examplelabs.release-notes')!;
    expect(notes.permissions.map((l) => l.text)).toEqual([
      'Use files in ${project}',
      'A read action runs without asking by default',
      'A write action asks you first by default',
    ]);
    expect(await env.market.search(ACCOUNT, { kind: 'theme' })).toHaveLength(1);
    expect(await env.market.search(ACCOUNT, { q: 'stand-up' })).toHaveLength(1);
  });

  it('installs the third-party theme and plugin verified, with no network', async () => {
    const theme = await installFrom(SAMPLE_CATALOG_ID, 'theme', 'com.examplelabs.aurora');
    expect(theme.p.verification).toEqual({
      status: 'verified',
      reasons: [],
      publisher: { name: null, key: SAMPLE_CATALOG_PUBLIC_KEY },
    });
    expect(theme.view).toMatchObject({
      kind: 'theme',
      verified: true,
      version: '1.0.0',
      origin: 'nova-sample/com.examplelabs.aurora@1.0.0',
    });
    expect(env.themes.map((t) => t.id)).toEqual(['com.examplelabs.aurora']);

    const plugin = await installFrom(SAMPLE_CATALOG_ID, 'plugin', 'com.examplelabs.release-notes');
    expect(plugin.p.requires).toEqual({ sideloadConfirmation: false, permissionAcceptance: false });
    expect(plugin.p.warnings).toEqual([]);
    expect(plugin.p.details).toMatchObject({
      skills: expect.arrayContaining([expect.objectContaining({ name: 'release-notes' })]),
    });
    const view = await env.plugins.get(ACCOUNT, 'com.examplelabs.release-notes');
    expect(view).toMatchObject({
      verified: true,
      source: 'catalog',
      origin: 'nova-sample/com.examplelabs.release-notes@1.0.0',
    });
    // The plugin installer recorded the verdict itself (its provenance argument).
    expect(env.audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      verified: true,
      source: 'catalog',
      origin: 'nova-sample/com.examplelabs.release-notes@1.0.0',
      publisher: SAMPLE_CATALOG_PUBLIC_KEY,
      via: SAMPLE_CATALOG_ID,
    });
    expect(env.events.names()).toEqual(
      expect.arrayContaining(['market.installed', 'plugin.installed']),
    );
    expect(
      env.audit
        .filter((a) => a.action.startsWith('market.'))
        .map((a) => [a.action, a.detail?.verified]),
    ).toEqual([
      ['market.install', true],
      ['market.install', true],
    ]);

    // Offline: nothing tried the network or git.
    expect(env.network).toEqual([]);
    const skill = await installFrom(SAMPLE_CATALOG_ID, 'skill', 'standup');
    expect(skill.view.verified).toBe(true);
    expect((await env.skills.views(ACCOUNT)).map((s) => s.id)).toContain('skill:import:standup');

    const listed = await env.market.search(ACCOUNT);
    expect(
      listed
        .filter((i) => i.installedVersion)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['com.examplelabs.aurora', 'com.examplelabs.release-notes', 'standup']);
    expect((await env.market.installed(ACCOUNT)).map((i) => i.itemId)).toEqual([
      'com.examplelabs.release-notes',
      'standup',
      'com.examplelabs.aurora',
    ]);
  });

  it('serves item details and says when an item has no screenshot', async () => {
    const d = await env.market.item(ACCOUNT, SAMPLE_CATALOG_ID, 'plugin', 'com.example.sample');
    expect(d).toMatchObject({
      versions: ['1.0.0'],
      components: { hooks: [{ id: 'hook:com.example.sample.check-fetch', event: 'tool.pre' }] },
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(
      env.market.screenshot(ACCOUNT, SAMPLE_CATALOG_ID, 'plugin', 'com.example.sample', 0),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      env.market.item(ACCOUNT, SAMPLE_CATALOG_ID, 'plugin', 'nope'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a folder catalog', () => {
  it('installs a signed plugin verified and removes it', async () => {
    signedPluginCatalog();
    const { p, view } = await installFrom('cat', 'plugin', 'com.test.notes');
    expect(p.verification.status).toBe('verified');
    expect(view.verified).toBe(true);
    expect((await env.plugins.get(ACCOUNT, 'com.test.notes')).verified).toBe(true);
    await env.market.remove(ACCOUNT, 'plugin', 'com.test.notes');
    await expect(env.plugins.get(ACCOUNT, 'com.test.notes')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await env.market.installed(ACCOUNT)).toEqual([]);
    expect(env.events.names()).toContain('market.removed');
    await expect(env.market.remove(ACCOUNT, 'plugin', 'com.test.notes')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses a catalog whose signature is bad: nothing listed, nothing installed', async () => {
    const root = signedPluginCatalog();
    // The index changes after it was signed.
    const file = join(root, 'catalog.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"Notes"', '"Notes!"'));
    const [view] = await env.market.catalogs();
    expect(view).toMatchObject({
      signature: 'invalid',
      items: 0,
      error: 'the index does not match its signature',
    });
    expect(await env.market.search(ACCOUNT)).toEqual([]);
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'cat', kind: 'plugin', id: 'com.test.notes' }),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'catalog_signature_invalid' },
    });
    expect(env.audit.find((a) => a.action === 'market.refuse')).toMatchObject({
      decision: 'denied',
      detail: { reason: 'catalog_signature_invalid' },
    });
    await expect(env.plugins.get(ACCOUNT, 'com.test.notes')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('installs an unsigned item only with the sideload confirmation, labelled Unverified', async () => {
    const root = join(dir, 'unsigned');
    pluginFolder(join(root, 'notes'));
    writeCatalog(root, {
      plugins: [{ id: 'com.test.notes', name: 'Notes', version: '1.0.0', path: 'notes' }],
    });
    env.catalogs.push({ id: 'unsigned', name: 'Unsigned', location: root });
    expect((await env.market.search(ACCOUNT))[0]!.verified).toBe(false);
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'unsigned',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.verification).toEqual({
      status: 'unverified',
      reasons: ['catalog_unsigned', 'no_checksum'],
      publisher: null,
    });
    expect(p.requires.sideloadConfirmation).toBe(true);
    expect(p.allowed).toBe(true);
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'confirmSideload', reason: 'sideload_confirmation_required' },
    });
    const view = await env.market.install(ACCOUNT, {
      previewId: p.previewId,
      confirmSideload: true,
    });
    expect(view.verified).toBe(false);
    expect((await env.plugins.get(ACCOUNT, 'com.test.notes')).verified).toBe(false);
    expect(env.audit.find((a) => a.action === 'market.install')?.detail).toMatchObject({
      verified: false,
      sideload: true,
      reasons: ['catalog_unsigned', 'no_checksum'],
    });
  });

  it('labels an item Unverified when its checksum does not match or its key is not trusted', async () => {
    const root = signedPluginCatalog();
    writeFileSync(join(root, 'notes', 'extra.txt'), 'added after signing');
    let p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.verification.reasons).toEqual(['checksum_mismatch']);
    env.trusted.splice(0);
    p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.verification.reasons).toEqual(['catalog_untrusted', 'checksum_mismatch']);
    expect((await env.market.catalogs())[0]!.signature).toBe('untrusted');
  });

  it('refuses an artifact that is another item than its entry says', async () => {
    const root = join(dir, 'liar');
    const plugin = pluginFolder(join(root, 'notes'), { id: 'com.test.other' });
    writeCatalog(
      root,
      {
        items: [
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'Notes',
            version: '1.0.0',
            path: 'notes',
            digest: folderDigest(plugin),
          },
        ],
      },
      key.privateKey,
    );
    env.catalogs.push({ id: 'liar', name: 'Liar', location: root });
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'liar', kind: 'plugin', id: 'com.test.notes' }),
    ).rejects.toThrow(/the item is com.test.other, but the catalog lists it as com.test.notes/);
  });

  it('warns when the catalog lists other permissions than the plugin declares', async () => {
    const root = join(dir, 'cat');
    const plugin = pluginFolder(join(root, 'notes'), {
      network: ['api.example.com', 'evil.example.com'],
    });
    writeCatalog(
      root,
      {
        items: [
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'Notes',
            version: '1.0.0',
            path: 'notes',
            digest: folderDigest(plugin),
            permissions: { network: ['api.example.com'] },
          },
        ],
      },
      key.privateKey,
    );
    env.catalogs.push({ id: 'cat', name: 'Cat', location: root, publisherKey: key.publicKey });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.verification.status).toBe('verified');
    expect(p.permissions.map((l) => l.key)).toEqual([
      'network:api.example.com',
      'network:evil.example.com',
    ]);
    expect(p.warnings).toContain(
      'The catalog lists other permissions than the item declares; the item’s own are shown here.',
    );
  });
});

describe('updates', () => {
  async function setUpV2(spec: Parameters<typeof pluginFolder>[1]) {
    const root = signedPluginCatalog('cat', { version: '1.0.0', network: ['api.example.com'] });
    await installFrom('cat', 'plugin', 'com.test.notes');
    const v2 = pluginFolder(join(root, 'notes-2'), { version: '1.1.0', ...spec });
    writeCatalog(
      root,
      {
        items: [
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'Notes',
            version: '1.0.0',
            path: 'notes',
            digest: folderDigest(join(root, 'notes')),
          },
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'Notes',
            version: '1.1.0',
            path: 'notes-2',
            digest: folderDigest(v2),
          },
        ],
      },
      key.privateKey,
    );
  }

  it('shows the permission diff and installs only once it is accepted', async () => {
    await setUpV2({ network: ['api.example.com', 'uploads.example.com'], hooks: true });
    const [item] = await env.market.search(ACCOUNT);
    expect(item).toMatchObject({
      version: '1.1.0',
      installedVersion: '1.0.0',
      updateAvailable: true,
    });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.replaces).toEqual({ version: '1.0.0' });
    expect(p.diff).toMatchObject({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      added: [
        { key: 'network:uploads.example.com', text: 'Reach uploads.example.com on the network' },
        {
          key: 'hook:hook:com.test.notes.log-prompt',
          text: 'Run the hook hook:com.test.notes.log-prompt on prompt.submit (node hooks/log.mjs)',
        },
      ],
      removed: [],
      changed: [],
    });
    expect(p.requires.permissionAcceptance).toBe(true);
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toMatchObject({
      code: 'validation',
      details: {
        field: 'acceptPermissions',
        reason: 'permission_diff_not_accepted',
        diffHash: p.diff!.hash,
      },
    });
    await expect(
      env.market.install(ACCOUNT, {
        previewId: p.previewId,
        acceptPermissions: 'sha256:' + '0'.repeat(64),
      }),
    ).rejects.toMatchObject({
      details: { reason: 'permission_diff_not_accepted' },
    });
    expect((await env.plugins.get(ACCOUNT, 'com.test.notes')).version).toBe('1.0.0');
    const view = await env.market.install(ACCOUNT, {
      previewId: p.previewId,
      acceptPermissions: p.diff!.hash,
    });
    expect(view.version).toBe('1.1.0');
    expect((await env.plugins.get(ACCOUNT, 'com.test.notes')).version).toBe('1.1.0');
    expect(env.events.names()).toContain('market.updated');
    expect(env.audit.find((a) => a.action === 'market.update')?.detail).toMatchObject({
      previousVersion: '1.0.0',
      permissionsAdded: ['network:uploads.example.com', 'hook:hook:com.test.notes.log-prompt'],
    });
    expect((await env.market.search(ACCOUNT))[0]).toMatchObject({
      installedVersion: '1.1.0',
      updateAvailable: false,
    });
  });

  it('needs no acceptance when an update only removes permissions', async () => {
    await setUpV2({ network: [] });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.diff?.removed.map((l) => l.key)).toEqual(['network:api.example.com']);
    expect(p.requires.permissionAcceptance).toBe(false);
    expect((await env.market.install(ACCOUNT, { previewId: p.previewId })).version).toBe('1.1.0');
  });

  it('rolls a failed update back to the version it replaced', async () => {
    await setUpV2({ network: ['api.example.com'] });
    const real = env.installers.plugin;
    const install = real.install.bind(real);
    // The plugin installer commits, then the next step fails.
    real.install = async (req) => {
      await install(req);
      throw new NovaError('server_error', 'disk full');
    };
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toThrow(
      /disk full/,
    );
    const back = await env.plugins.get(ACCOUNT, 'com.test.notes');
    expect(back).toMatchObject({ version: '1.0.0', verified: true, source: 'catalog' });
    expect(
      existsSync(
        join(dir, 'data', 'plugins', 'com.test.notes', '1.0.0', '.nova-plugin', 'plugin.json'),
      ),
    ).toBe(true);
    expect((await env.market.installed(ACCOUNT))[0]).toMatchObject({ version: '1.0.0' });
    expect(env.audit.find((a) => a.action === 'market.install.failed')).toMatchObject({
      decision: 'failed',
      detail: { rolledBack: true, version: '1.1.0', previousVersion: '1.0.0', error: 'disk full' },
    });
  });

  it('rolls a failed first install back to nothing', async () => {
    signedPluginCatalog();
    const real = env.installers.plugin;
    const install = real.install.bind(real);
    real.install = async (req) => {
      await install(req);
      throw new Error('boom');
    };
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toThrow('boom');
    await expect(env.plugins.get(ACCOUNT, 'com.test.notes')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await env.market.installed(ACCOUNT)).toEqual([]);
  });

  it('refuses an install when what is installed changed since the preview', async () => {
    await setUpV2({ network: ['api.example.com'] });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    await env.plugins.uninstall(ACCOUNT, 'com.test.notes');
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('expires previews', async () => {
    signedPluginCatalog();
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    env.clock.now += 31 * 60_000;
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toMatchObject({
      code: 'request_expired',
    });
    expect(existsSync(join(dir, 'data', 'cache', 'market', 'staging', p.previewId))).toBe(false);
  });
});

describe('policy', () => {
  it('managed policy forbids unverified installs but not verified ones', async () => {
    const root = join(dir, 'unsigned');
    pluginFolder(join(root, 'notes'));
    writeCatalog(root, {
      plugins: [{ id: 'com.test.notes', name: 'Notes', version: '1.0.0', path: 'notes' }],
    });
    env.catalogs.push({ id: 'unsigned', name: 'Unsigned', location: root });
    env.policy.unverified = false;
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'unsigned',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p).toMatchObject({ allowed: false, blockedBy: 'managed' });
    await expect(
      env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'managed' },
    });
    expect(env.audit.find((a) => a.action === 'market.refuse')).toMatchObject({
      decision: 'denied',
      detail: { reason: 'managed' },
    });
    signedPluginCatalog('signed', { id: 'com.test.signed' });
    const ok = await installFrom('signed', 'plugin', 'com.test.signed');
    expect(ok.view.verified).toBe(true);
  });

  it('under restrict.unverifiedInstalls: false a verified catalog plugin installs and an unverified one is refused', async () => {
    env.policy.unverified = false;
    signedPluginCatalog('signed', { id: 'com.test.signed' });
    const ok = await installFrom('signed', 'plugin', 'com.test.signed');
    expect(ok.view.verified).toBe(true);
    expect(await env.plugins.get(ACCOUNT, 'com.test.signed')).toMatchObject({
      verified: true,
      source: 'catalog',
      origin: 'signed/com.test.signed@1.0.0',
    });
    expect(env.audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      verified: true,
      via: 'signed',
    });
    const root = join(dir, 'unsigned');
    pluginFolder(join(root, 'notes'));
    writeCatalog(root, {
      plugins: [{ id: 'com.test.notes', name: 'Notes', version: '1.0.0', path: 'notes' }],
    });
    env.catalogs.push({ id: 'unsigned', name: 'Unsigned', location: root });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'unsigned',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    await expect(
      env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({ code: 'policy_denied', details: { reason: 'managed' } });
    await expect(env.plugins.get(ACCOUNT, 'com.test.notes')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('the plugin installer refuses an unverified install itself, and nothing is left', async () => {
    // The marketplace's own check is open; only the plugin installer's managed policy refuses.
    env.policy.managedUnverified = false;
    const root = join(dir, 'unsigned');
    pluginFolder(join(root, 'notes'));
    writeCatalog(root, {
      plugins: [{ id: 'com.test.notes', name: 'Notes', version: '1.0.0', path: 'notes' }],
    });
    env.catalogs.push({ id: 'unsigned', name: 'Unsigned', location: root });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'unsigned',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.allowed).toBe(true);
    await expect(
      env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(env.plugins.get(ACCOUNT, 'com.test.notes')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await env.market.installed(ACCOUNT)).toEqual([]);
    expect(env.audit.find((a) => a.action === 'market.install.failed')?.detail).toMatchObject({
      rolledBack: true,
    });
    // A verified one still installs.
    signedPluginCatalog('signed', { id: 'com.test.signed' });
    expect((await installFrom('signed', 'plugin', 'com.test.signed')).view.verified).toBe(true);
  });

  it('the owner can turn sideloading off and limit the kinds', async () => {
    const root = join(dir, 'unsigned');
    themeFile(join(root, 'dusk.json'));
    writeCatalog(root, {
      items: [
        { kind: 'theme', id: 'com.test.dusk', name: 'Dusk', version: '1.0.0', path: 'dusk.json' },
      ],
    });
    env.catalogs.push({ id: 'unsigned', name: 'Unsigned', location: root });
    env.policy.sideload = false;
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'unsigned',
      kind: 'theme',
      id: 'com.test.dusk',
    });
    expect(p.blockedBy).toBe('sideload_disabled');
    await expect(
      env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({ details: { reason: 'sideload_disabled' } });
    env.policy.sideload = true;
    env.policy.kinds = ['plugin'];
    await expect(
      env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({ details: { reason: 'kind_not_allowed' } });
    expect(env.themes).toEqual([]);
  });
});

describe('a Git catalog', () => {
  const COMMIT = 'a'.repeat(40);
  const MOVED = 'b'.repeat(40);

  /** A fake git: init, fetch of one commit (copies that commit's fixture folder), checkout, rev-parse. */
  function fakeGit(
    trees: Record<string, string>,
    calls: string[][],
    head?: () => string,
  ): GitRunner {
    let fetched = '';
    return (args) => {
      calls.push(args);
      if (args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'git version 2.50.0', stderr: '' });
      if (args.includes('init')) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      if (args.includes('fetch')) {
        fetched = args.at(-1)!;
        const tree = trees[fetched];
        if (!tree)
          return Promise.resolve({
            code: 128,
            stdout: '',
            stderr: 'fatal: remote error: not our ref',
          });
        cpSync(tree, args[args.indexOf('-C') + 1]!, { recursive: true });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      if (args.includes('checkout')) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      if (args.includes('rev-parse'))
        return Promise.resolve({ code: 0, stdout: `${head?.() ?? fetched}\n`, stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' });
    };
  }

  function tree(name: string, version: string, network: string[]) {
    const root = join(dir, 'trees', name);
    const plugin = pluginFolder(join(root, 'notes'), { version, network });
    writeCatalog(
      root,
      {
        items: [
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'Notes',
            version,
            path: 'notes',
            digest: folderDigest(plugin),
          },
        ],
      },
      key.privateKey,
    );
    return root;
  }

  it('reads the index at the pinned commit, and a moved pin is an update with its diff', async () => {
    const calls: string[][] = [];
    const trees = {
      [COMMIT]: tree('one', '1.0.0', []),
      [MOVED]: tree('two', '1.0.0', ['api.example.com']),
    };
    db.close();
    db = await openMarketDb();
    env = marketEnv(dir, db, { git: fakeGit(trees, calls) });
    env.trusted.push({ name: 'Test', key: key.publicKey });
    env.catalogs.push({
      id: 'git',
      name: 'Git',
      location: 'https://git.example.com/org/catalog.git',
      commit: COMMIT,
    });
    const [c] = await env.market.catalogs();
    expect(c).toMatchObject({ kind: 'git', signature: 'verified', commit: COMMIT });
    const fetch = calls.find((a) => a.includes('fetch'))!;
    expect(fetch).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        'protocol.file.allow=never',
        '--depth',
        '1',
        '--no-tags',
        'https://git.example.com/org/catalog.git',
        COMMIT,
      ]),
    );
    const { view } = await installFrom('git', 'plugin', 'com.test.notes');
    expect(view).toMatchObject({
      commit: COMMIT,
      origin: `git/com.test.notes@1.0.0#${COMMIT}`,
      verified: true,
    });
    expect((await env.plugins.get(ACCOUNT, 'com.test.notes')).origin).toBe(
      `git/com.test.notes@1.0.0#${COMMIT}`,
    );

    // The owner moves the pin: the same version with other bytes is an update.
    env.catalogs[0]!.commit = MOVED;
    const [item] = await env.market.search(ACCOUNT);
    expect(item).toMatchObject({ installedVersion: '1.0.0', updateAvailable: true });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'git',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.diff?.added.map((l) => l.key)).toEqual(['network:api.example.com']);
    const updated = await env.market.install(ACCOUNT, {
      previewId: p.previewId,
      acceptPermissions: p.diff!.hash,
    });
    expect(updated.commit).toBe(MOVED);
  });

  it('refuses a checkout that is not the pinned commit and a malformed pin', async () => {
    const trees = { [COMMIT]: tree('one', '1.0.0', []) };
    db.close();
    db = await openMarketDb();
    env = marketEnv(dir, db, { git: fakeGit(trees, [], () => MOVED) });
    env.catalogs.push({
      id: 'git',
      name: 'Git',
      location: 'https://git.example.com/org/catalog.git',
      commit: COMMIT,
    });
    expect((await env.market.catalogs())[0]!.error).toMatch(/not the pinned commit/);
    env.catalogs[0]!.commit = 'HEAD';
    expect((await env.market.catalogs())[0]!.error).toMatch(/40 lowercase hex/);
    env.catalogs[0]!.commit = 'c'.repeat(40);
    expect((await env.market.catalogs())[0]!.error).toMatch(
      /git fetch failed: fatal: remote error/,
    );
  });

  it('installs an entry from another repository pinned to a commit', async () => {
    const other = join(dir, 'trees', 'other');
    const plugin = pluginFolder(join(other, 'pkg'));
    const trees = { [MOVED]: other };
    db.close();
    db = await openMarketDb();
    env = marketEnv(dir, db, { git: fakeGit(trees, []) });
    const root = join(dir, 'local');
    writeCatalog(
      root,
      {
        items: [
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'Notes',
            version: '1.0.0',
            repo: 'https://git.example.com/org/notes.git',
            commit: MOVED,
            path: 'pkg',
            digest: folderDigest(plugin),
          },
        ],
      },
      key.privateKey,
    );
    env.catalogs.push({ id: 'local', name: 'Local', location: root, publisherKey: key.publicKey });
    const { view } = await installFrom('local', 'plugin', 'com.test.notes');
    expect(view).toMatchObject({ verified: true, commit: MOVED });
  });
});

describe('a remote catalog over HTTPS', () => {
  let server: FakeCatalogServer;
  beforeEach(async () => {
    server = await startFakeCatalog();
    db.close();
    db = await openMarketDb();
    env = marketEnv(dir, db, { fetch: server.fetch });
  });
  afterEach(() => server.close());

  function publish(items: unknown[], signed = true) {
    const index = Buffer.from(JSON.stringify({ schemaVersion: 1, items }));
    server.files.set('/v1/index.json', index);
    if (signed) server.files.set('/v1/index.json.sig', signCatalogIndex(index, key.privateKey));
    else server.files.delete('/v1/index.json.sig');
  }

  it('reads a signed index, downloads a bundle and checks its signature', async () => {
    const plugin = pluginFolder(join(dir, 'src'));
    const bundle = makeNovax(plugin, key);
    server.files.set('/v1/notes-1.0.0.novax', bundle);
    publish([
      {
        kind: 'plugin',
        id: 'com.test.notes',
        name: 'Notes',
        version: '1.0.0',
        url: 'notes-1.0.0.novax',
        sha256: sha256Hex(bundle),
        publisher: { name: 'Test', key: key.publicKey },
      },
    ]);
    env.catalogs.push({
      id: 'remote',
      name: 'Remote',
      location: `${server.origin}/v1/index.json`,
      publisherKey: key.publicKey,
    });
    expect((await env.market.catalogs())[0]).toMatchObject({
      kind: 'url',
      signature: 'verified',
      items: 1,
    });
    // Pinned for the catalog only, the key does not yet vouch for bundles.
    const untrusted = await env.market.preview(ACCOUNT, {
      catalogId: 'remote',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(untrusted.verification.reasons).toEqual(['bundle_untrusted']);
    env.trusted.push({ name: 'Test', key: key.publicKey });
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'remote',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    // The bundle's signer is a trusted publisher.
    expect(p.verification).toEqual({
      status: 'verified',
      reasons: [],
      publisher: { name: 'Test', key: key.publicKey },
    });
    await env.market.install(ACCOUNT, { previewId: p.previewId });
    expect((await env.plugins.get(ACCOUNT, 'com.test.notes')).verified).toBe(true);
    expect(server.requests).toEqual(
      expect.arrayContaining(['/v1/index.json', '/v1/index.json.sig', '/v1/notes-1.0.0.novax']),
    );
  });

  it('reports the verdict of each bundle', async () => {
    const other = testPublisher();
    const verdicts: Record<string, string[]> = {};
    for (const [name, k, tamper] of [
      ['unsigned', undefined, false],
      ['stranger', other, false],
      ['changed', key, true],
    ] as const) {
      const plugin = pluginFolder(join(dir, name), { id: `com.test.${name}` });
      const b = makeNovax(plugin, k, tamper);
      server.files.set(`/v1/${name}.novax`, b);
      verdicts[name] = [];
      publish([
        {
          kind: 'plugin',
          id: `com.test.${name}`,
          name,
          version: '1.0.0',
          url: `${name}.novax`,
          sha256: sha256Hex(b),
          publisher: { key: key.publicKey },
        },
      ]);
      env.catalogs.splice(0, env.catalogs.length, {
        id: `r-${name}`,
        name: 'Remote',
        location: `${server.origin}/v1/index.json`,
        publisherKey: key.publicKey,
      });
      try {
        const p = await env.market.preview(ACCOUNT, {
          catalogId: `r-${name}`,
          kind: 'plugin',
          id: `com.test.${name}`,
        });
        verdicts[name] = p.verification.reasons;
      } catch (err) {
        verdicts[name] = [String(err)];
      }
    }
    expect(verdicts).toEqual({
      unsigned: ['bundle_unsigned'],
      stranger: ['bundle_untrusted'],
      changed: [expect.stringMatching(/refused: the bundle was changed after it was signed/)],
    });
  });

  it('treats a missing signature as unsigned and refuses a redirect to another host', async () => {
    const theme = Buffer.from(readFileSync(themeFile(join(dir, 'dusk.json'))));
    server.files.set('/v1/dusk.json', theme);
    publish(
      [
        {
          kind: 'theme',
          id: 'com.test.dusk',
          name: 'Dusk',
          version: '1.0.0',
          url: 'dusk.json',
          sha256: sha256Hex(theme),
        },
      ],
      false,
    );
    env.catalogs.push({ id: 'remote', name: 'Remote', location: `${server.origin}/v1/index.json` });
    expect((await env.market.catalogs())[0]!.signature).toBe('unsigned');
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'remote',
      kind: 'theme',
      id: 'com.test.dusk',
    });
    expect(p.verification.reasons).toEqual(['catalog_unsigned']);
    await env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    expect(env.themes.map((t) => t.id)).toEqual(['com.test.dusk']);

    server.redirects.set('/v2/index.json', 'https://elsewhere.example.com/index.json');
    env.catalogs.splice(0, 1, {
      id: 'moved',
      name: 'Moved',
      location: `${server.origin}/v2/index.json`,
    });
    expect((await env.market.catalogs())[0]!.error).toMatch(/redirected to another host/);
  });

  it('refuses an item served from another host', async () => {
    publish([
      {
        kind: 'theme',
        id: 'com.test.dusk',
        name: 'Dusk',
        version: '1.0.0',
        url: 'https://elsewhere.example.com/dusk.json',
        sha256: 'a'.repeat(64),
      },
    ]);
    env.catalogs.push({
      id: 'remote',
      name: 'Remote',
      location: `${server.origin}/v1/index.json`,
      publisherKey: key.publicKey,
    });
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'remote', kind: 'theme', id: 'com.test.dusk' }),
    ).rejects.toThrow(/catalog host over https/);
  });
});

describe('other kinds', () => {
  function signedItems(items: unknown[]) {
    const root = join(dir, 'kinds');
    writeCatalog(root, { items }, key.privateKey);
    env.catalogs.push({ id: 'kinds', name: 'Kinds', location: root, publisherKey: key.publicKey });
    return root;
  }

  it('installs, updates and removes a skill', async () => {
    const root = join(dir, 'kinds');
    const s1 = skillFolder(join(root, 'tidy'), 'tidy');
    signedItems([
      {
        kind: 'skill',
        id: 'tidy',
        name: 'Tidy',
        version: '1.0.0',
        path: 'tidy',
        digest: folderDigest(s1),
      },
    ]);
    await installFrom('kinds', 'skill', 'tidy');
    expect((await env.skills.get(ACCOUNT, 'skill:import:tidy')).allowedTools).toEqual([]);
    const s2 = skillFolder(join(root, 'tidy-2'), 'tidy', ['fs.read']);
    signedItems([
      {
        kind: 'skill',
        id: 'tidy',
        name: 'Tidy',
        version: '1.1.0',
        path: 'tidy-2',
        digest: folderDigest(s2),
      },
    ]);
    env.catalogs.splice(0, 1);
    const p = await env.market.preview(ACCOUNT, { catalogId: 'kinds', kind: 'skill', id: 'tidy' });
    expect(p.diff?.added.map((l) => l.text)).toEqual(['Ask to use the tool fs.read']);
    await env.market.install(ACCOUNT, { previewId: p.previewId, acceptPermissions: p.diff!.hash });
    expect((await env.skills.get(ACCOUNT, 'skill:import:tidy')).allowedTools).toEqual(['fs.read']);
    await env.market.remove(ACCOUNT, 'skill', 'tidy');
    await expect(env.skills.get(ACCOUNT, 'skill:import:tidy')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('puts the saved themes back when a theme install fails', async () => {
    let fail = false;
    db.close();
    db = await openMarketDb();
    env = marketEnv(dir, db, { failThemeWrite: () => fail });
    const root = join(dir, 'kinds');
    const t = themeFile(join(root, 'dusk.json'));
    signedItems([
      {
        kind: 'theme',
        id: 'com.test.dusk',
        name: 'Dusk',
        version: '1.0.0',
        path: 'dusk.json',
        sha256: sha256Hex(readFileSync(t)),
      },
    ]);
    await installFrom('kinds', 'theme', 'com.test.dusk');
    const before = JSON.stringify(env.themes);
    fail = true;
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'kinds',
      kind: 'theme',
      id: 'com.test.dusk',
    });
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toThrow(
      /settings write failed/,
    );
    expect(JSON.stringify(env.themes)).toBe(before);
    expect(env.audit.find((a) => a.action === 'market.install.failed')?.detail).toMatchObject({
      rolledBack: false,
    });
    fail = false;
    await env.market.remove(ACCOUNT, 'theme', 'com.test.dusk');
    expect(env.themes).toEqual([]);
  });

  it('refuses a theme that is not a theme file or whose values leave their property', async () => {
    const root = join(dir, 'kinds');
    writeFileSync(join(dir, 'x'), '');
    themeFile(join(root, 'bad.json'), 'com.test.bad', '#fff; } body { display: none');
    const bad = readFileSync(join(root, 'bad.json'));
    writeFileSync(join(root, 'notjson.json'), '{');
    signedItems([
      {
        kind: 'theme',
        id: 'com.test.bad',
        name: 'Bad',
        version: '1.0.0',
        path: 'bad.json',
        sha256: sha256Hex(bad),
      },
      { kind: 'theme', id: 'com.test.nj', name: 'NJ', version: '1.0.0', path: 'notjson.json' },
    ]);
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'kinds', kind: 'theme', id: 'com.test.bad' }),
    ).rejects.toThrow(/not a plain CSS value/);
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'kinds', kind: 'theme', id: 'com.test.nj' }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('installs a pet from a zip and removes it', async () => {
    const root = join(dir, 'kinds');
    mkdirSync(root, { recursive: true });
    const zip = zipOf(petFolder(join(dir, 'owl')), 'owl/');
    writeFileSync(join(root, 'owl.zip'), zip);
    signedItems([
      {
        kind: 'pet',
        id: 'com.test.owl',
        name: 'Owl',
        version: '1.0.0',
        path: 'owl.zip',
        sha256: sha256Hex(zip),
      },
    ]);
    const { p } = await installFrom('kinds', 'pet', 'com.test.owl');
    expect(p.details).toEqual({ states: ['idle', 'thinking'] });
    expect(env.pets.pets()).toEqual([
      {
        id: 'com.test.owl',
        name: 'Owl',
        version: '1.0.0',
        states: {
          idle: { frames: ['frames/idle-1.png', 'frames/idle-2.png'], fps: 4, loop: true },
          thinking: { frames: ['frames/thinking-1.webp'], fps: 8, loop: true },
        },
      },
    ]);
    expect(existsSync(join(env.pets.folder('com.test.owl'), 'frames', 'idle-1.png'))).toBe(true);
    await env.market.remove(ACCOUNT, 'pet', 'com.test.owl');
    expect(env.pets.pets()).toEqual([]);
  });

  it('refuses a pet frame that is not an image or leaves its folder', async () => {
    const root = join(dir, 'kinds');
    const pet = petFolder(join(root, 'owl'));
    const manifest = JSON.parse(readFileSync(join(pet, 'pet.json'), 'utf8')) as {
      states: { idle: { frames: string[] } };
    };
    manifest.states.idle.frames = ['../../x.png'];
    writeFileSync(join(pet, 'pet.json'), JSON.stringify(manifest));
    signedItems([
      {
        kind: 'pet',
        id: 'com.test.owl',
        name: 'Owl',
        version: '1.0.0',
        path: 'owl',
        digest: folderDigest(pet),
      },
    ]);
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'kinds', kind: 'pet', id: 'com.test.owl' }),
    ).rejects.toThrow(/leaves the plugin folder|outside/);
  });

  it('installs MCP registry entries and bundles through the MCP installer', async () => {
    const root = join(dir, 'kinds');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'hello.mcpb'), 'bundle bytes');
    signedItems([
      {
        kind: 'mcp',
        id: 'linear',
        name: 'Linear',
        version: '1.0.0',
        server: { transport: 'http', url: 'https://mcp.linear.example/mcp' },
      },
      {
        kind: 'mcp',
        id: 'hello',
        name: 'Hello',
        version: '0.1.0',
        path: 'hello.mcpb',
        sha256: sha256Hex('bundle bytes'),
      },
      {
        kind: 'mcp',
        id: 'plain',
        name: 'Plain',
        version: '0.1.0',
        server: { transport: 'http', url: 'http://mcp.example/mcp' },
      },
    ]);
    const items = await env.market.search(ACCOUNT, { kind: 'mcp' });
    expect(items.map((i) => [i.id, i.verified, i.permissions.map((l) => l.text)])).toEqual([
      ['hello', true, []],
      ['linear', true, ['Connect to mcp.linear.example']],
      ['plain', true, ['Connect to mcp.example']],
    ]);
    const reg = await installFrom('kinds', 'mcp', 'linear');
    expect(reg.p).toMatchObject({
      verification: { status: 'verified' },
      details: { form: 'registry' },
    });
    const bun = await installFrom('kinds', 'mcp', 'hello');
    expect(bun.p.verification.status).toBe('verified');
    expect([...env.mcp.servers]).toEqual([
      ['linear', '1.0.0'],
      ['hello', '0.1.0'],
    ]);
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'kinds', kind: 'mcp', id: 'plain' }),
    ).rejects.toThrow(/over https/);
  });

  it('says when a kind has no installer on this Hub', async () => {
    const m = new Marketplace({
      db,
      sources: new MarketSources({ catalogs: new PluginCatalogs({ cacheDir: join(dir, 'c') }) }),
      catalogConfigs: () => Promise.resolve([]),
      trustedPublishers: () => Promise.resolve([]),
      installers: { theme: env.installers.theme },
      workDir: join(dir, 'w'),
    });
    await expect(
      m.preview(ACCOUNT, { catalogId: 'x', kind: 'mcp', id: 'y' }),
    ).rejects.toMatchObject({
      code: 'capability_missing',
    });
    await expect(m.remove(ACCOUNT, 'pet', 'y')).rejects.toMatchObject({
      code: 'capability_missing',
    });
    m.close();
  });
});

describe('ratings', () => {
  it('keeps ratings on the Hub and shows them on the card', async () => {
    signedPluginCatalog();
    expect(
      await env.market.rate(ACCOUNT, {
        kind: 'plugin',
        itemId: 'com.test.notes',
        stars: 4,
        review: '  Handy  ',
      }),
    ).toMatchObject({
      stars: 4,
      review: 'Handy',
      shared: false,
    });
    await env.market.rate(ACCOUNT, { kind: 'plugin', itemId: 'com.test.notes', stars: 5 });
    expect(await env.market.ratings(ACCOUNT)).toEqual([
      expect.objectContaining({ kind: 'plugin', itemId: 'com.test.notes', stars: 5, review: null }),
    ]);
    expect((await env.market.search(ACCOUNT))[0]!.rating).toMatchObject({ stars: 5 });
    await env.market.unrate(ACCOUNT, 'plugin', 'com.test.notes');
    expect(await env.market.ratings(ACCOUNT)).toEqual([]);
  });
});

it('reports a catalog it cannot read without failing the others', async () => {
  env.catalogs.push({ id: 'gone', name: 'Gone', location: join(dir, 'nope') });
  env.catalogs.push({ id: 'rel', name: 'Relative', location: 'relative/path' });
  signedPluginCatalog();
  const views = await env.market.catalogs();
  expect(views.map((v) => [v.id, v.error === null])).toEqual([
    ['gone', false],
    ['rel', false],
    ['cat', true],
  ]);
  expect((await env.market.search(ACCOUNT)).map((i) => i.id)).toEqual(['com.test.notes']);
  await expect(
    env.market.preview(ACCOUNT, { catalogId: 'gone', kind: 'plugin', id: 'x' }),
  ).rejects.toMatchObject({ code: 'validation' });
  await expect(
    env.market.preview(ACCOUNT, { catalogId: 'missing', kind: 'plugin', id: 'x' }),
  ).rejects.toMatchObject({ code: 'not_found' });
});
