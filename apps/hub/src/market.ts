// Marketplace area (FR-049; docs/14 §5, docs/08 §7; ADR-097 D2, D4): the catalogs (the built-in
// sample catalog, pinned to its key, plus `plugins.catalogs`), search and item cards, previews
// with the item's own permissions and the verdict, installs and updates (the permission diff
// accepted by its hash), removal, ratings kept on the Hub, and installed pets with their frames.
// Every route needs a session, and all of them are the Hub owner's (installs are for everyone).
// Plugins go through the plugins area's installer, skills into its skill index, themes into
// `appearance.customThemes` through the settings writer; MCP servers come from the MCP area once
// it hands over an installer (`useMcpInstaller`); until then MCP items answer `capability_missing`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  isSettingKey,
  marketInstallSchema,
  marketKindSchema,
  marketPreviewSchema,
  marketRatingSchema,
  marketSearchSchema,
  type MarketItemKind,
} from '@nova/shared';
import {
  Marketplace,
  MarketSources,
  PetMarketInstaller,
  PluginCatalogs,
  PluginMarketInstaller,
  SAMPLE_CATALOG_ID,
  SAMPLE_CATALOG_PUBLIC_KEY,
  SkillMarketInstaller,
  ThemeMarketInstaller,
  managedRestrictions,
  type AuditSink,
  type ExtensionInstaller,
  type MarketCatalogConfig,
  type MarketInstaller,
  type MarketPolicy,
  type PluginCatalogsOptions,
  type PluginService,
  type SkillIndex,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface MarketArea extends HubArea {
  service: Marketplace;
  /** Installed pets (`appearance.pet` choices once wave 2 extends it). */
  pets: PetMarketInstaller;
  /**
   * The MCP area's installer for MCP registry entries and bundles (kind `mcp`): the MCP area
   * implements MarketInstaller over its bundle installer; null leaves MCP items uninstallable.
   */
  useMcpInstaller(installer: MarketInstaller | null): void;
  /**
   * The SDK area's extension installer (`sdk.service`): `.novax` items and plugins holding
   * `.nova-plugin/extension.json` install through it, so the extension records its publisher and
   * its own verdict; null installs them as plain plugins.
   */
  useExtensionInstaller(installer: ExtensionInstaller | null): void;
  useAudit(audit: AuditSink): void;
}

export interface MarketDeps {
  /** The plugins area's installer and skill index (`plugins.service`, `plugins.index`). */
  plugins: { service: PluginService; index: SkillIndex };
  /**
   * Write a global setting the way `PATCH /api/v1/settings` does (a managed lock refuses with
   * `policy_denied`); installing a theme writes `appearance.customThemes`.
   */
  writeSetting: (
    accountId: string,
    key: 'appearance.customThemes',
    value: unknown,
  ) => Promise<void>;
  audit?: AuditSink;
  /** The built-in sample catalog folder; null for none (tests). */
  sampleCatalogDir?: string | null;
  /** Fetch and Git for remote and Git catalogs (tests replace them). */
  catalogs?: Pick<PluginCatalogsOptions, 'fetch' | 'git' | 'gitCommand'>;
  now?: () => Date;
}

const DEFAULT_SAMPLE_DIR = fileURLToPath(new URL('../../../examples/catalog/', import.meta.url));
const ALL_KINDS: readonly MarketItemKind[] = ['plugin', 'skill', 'theme', 'pet', 'mcp'];
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.webp': 'image/webp',
};

const itemParams = z.object({
  catalogId: z.string().min(1).max(40),
  kind: marketKindSchema,
  id: z.string().min(1).max(200),
});
const shotParams = itemParams.extend({ n: z.coerce.number().int().min(0).max(7) });
const installedParams = z.object({ kind: marketKindSchema, id: z.string().min(1).max(200) });
const petFileParams = z.object({ id: z.string().min(1).max(200), '*': z.string().min(1).max(300) });

export function setupMarket(ctx: HubContext, deps: MarketDeps): Promise<MarketArea> {
  const log = ctx.log.child('market');
  let audit: AuditSink | null = deps.audit ?? null;
  const sampleDir =
    deps.sampleCatalogDir === undefined ? DEFAULT_SAMPLE_DIR : deps.sampleCatalogDir;
  const work = join(ctx.dataDir, 'cache', 'market');
  const backupsDir = join(work, 'backups');
  // A key another area has not defined reads as its safe value (fail closed).
  const setting = async (key: string): Promise<unknown> =>
    isSettingKey(key) ? ctx.setting(key) : undefined;

  const sources = new MarketSources({
    catalogs: new PluginCatalogs({ cacheDir: join(work, 'sources'), ...deps.catalogs }),
  });
  const pets = new PetMarketInstaller({ dir: join(ctx.dataDir, 'market', 'pets'), backupsDir });
  const pluginInstaller = new PluginMarketInstaller({
    service: deps.plugins.service,
    db: ctx.db,
    backupsDir,
    novaVersion: ctx.config.version,
  });
  const installers: Partial<Record<MarketItemKind, MarketInstaller>> = {
    plugin: pluginInstaller,
    skill: new SkillMarketInstaller({
      index: deps.plugins.index,
      userDir: join(ctx.dataDir, 'skills'),
      backupsDir,
    }),
    theme: new ThemeMarketInstaller({
      read: async () => (await ctx.setting('appearance.customThemes')).map((t) => ({ ...t })),
      write: (accountId, themes) => deps.writeSetting(accountId, 'appearance.customThemes', themes),
    }),
    pet: pets,
  };

  const restrictions = async () => managedRestrictions(await setting('managed.restrict'));
  const policy: MarketPolicy = {
    unverifiedAllowed: async () =>
      (await restrictions()).unverifiedInstall('an unverified item') === null,
    sideloadEnabled: async () => (await setting('market.allowSideload')) !== false,
    allowedKinds: async () => {
      const v = await setting('market.allowedKinds');
      return Array.isArray(v) ? (v as MarketItemKind[]) : ALL_KINDS;
    },
    itemRefused: async (kind, id) => (kind === 'plugin' ? (await restrictions()).plugin(id) : null),
  };

  async function catalogConfigs(): Promise<MarketCatalogConfig[]> {
    const out: MarketCatalogConfig[] = [];
    if (sampleDir && existsSync(join(sampleDir, 'catalog.json')))
      out.push({
        id: SAMPLE_CATALOG_ID,
        name: 'Sample catalog',
        location: sampleDir,
        builtin: true,
        publisherKey: SAMPLE_CATALOG_PUBLIC_KEY,
      });
    for (const c of await ctx.setting('plugins.catalogs'))
      if (!out.some((x) => x.id === c.id))
        out.push({
          id: c.id,
          name: c.name,
          location: c.location,
          ...(c.publisherKey ? { publisherKey: c.publisherKey } : {}),
          ...(c.commit ? { commit: c.commit } : {}),
        });
    return out;
  }

  const service = new Marketplace({
    db: ctx.db,
    sources,
    catalogConfigs,
    trustedPublishers: async () => {
      const v = await setting('plugins.trustedPublishers');
      return Array.isArray(v) ? (v as { name: string; key: string }[]) : [];
    },
    installers,
    workDir: work,
    policy,
    events: ctx.events,
    // Late-bound: the ops area's audit sink may arrive after setup.
    audit: { append: (r) => (audit ? audit.append(r) : Promise.resolve()) },
    log,
    ...(deps.now ? { now: deps.now } : {}),
  });

  // A changed catalog list is read again (remote indexes are cached for a few minutes).
  const offSettings = ctx.events.bus.subscribe('settings.changed', (e) => {
    if (e.payload.key === 'plugins.catalogs' || e.payload.key === 'plugins.trustedPublishers')
      sources.forget();
  });
  const sweep = setInterval(() => service.sweep(), 60_000);
  sweep.unref();

  ctx.diagnostics.add('market', async () => ({
    catalogs: (await catalogConfigs()).length,
    pets: pets.pets().length,
    mcpInstaller: installers.mcp !== undefined,
  }));

  function register(app: FastifyInstance): void {
    app.get('/api/v1/market/catalogs', async (req) => {
      await ctx.accountOf(req);
      return { items: await service.catalogs() };
    });

    app.get('/api/v1/market/items', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.search(accountId, marketSearchSchema.parse(req.query)) };
    });

    app.get('/api/v1/market/items/:catalogId/:kind/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = itemParams.parse(req.params);
      return service.item(accountId, p.catalogId, p.kind, p.id);
    });

    app.get('/api/v1/market/items/:catalogId/:kind/:id/screenshots/:n', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const p = shotParams.parse(req.params);
      const shot = await service.screenshot(accountId, p.catalogId, p.kind, p.id, p.n);
      void reply
        .header('content-type', shot.contentType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'");
      return reply.send(Buffer.from(shot.bytes));
    });

    app.post('/api/v1/market/preview', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.preview(accountId, marketPreviewSchema.parse(req.body));
    });

    app.post('/api/v1/market/install', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const view = await service.install(accountId, marketInstallSchema.parse(req.body));
      void reply.status(201);
      return view;
    });

    app.get('/api/v1/market/installed', async (req) => ({
      items: await service.installed(await ctx.accountOf(req)),
    }));

    app.delete('/api/v1/market/installed/:kind/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = installedParams.parse(req.params);
      await service.remove(accountId, p.kind, p.id);
      return { ok: true };
    });

    app.get('/api/v1/market/ratings', async (req) => ({
      items: await service.ratings(await ctx.accountOf(req)),
    }));

    app.put('/api/v1/market/ratings', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.rate(accountId, marketRatingSchema.parse(req.body));
    });

    app.delete('/api/v1/market/ratings/:kind/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = installedParams.parse(req.params);
      await service.unrate(accountId, p.kind, p.id);
      return { ok: true };
    });

    app.get('/api/v1/market/pets', async (req) => {
      await ctx.accountOf(req);
      return { items: pets.pets() };
    });

    // A pet's frames, for the companion overlay: images inside the installed pet's folder only.
    app.get('/api/v1/market/pets/:id/files/*', async (req, reply) => {
      await ctx.accountOf(req);
      const p = petFileParams.parse(req.params);
      const type = IMAGE_TYPES[extname(p['*']).toLowerCase()];
      if (!type) throw new NovaError('not_found', 'not a pet frame');
      const pet = pets.pets().find((x) => x.id === p.id);
      const listed = Object.values(pet?.states ?? {}).some((s) => s.frames.includes(p['*']));
      if (!pet || !listed) throw new NovaError('not_found', 'not a pet frame');
      const file = join(pets.folder(p.id), ...p['*'].split('/'));
      if (!existsSync(file) || !statSync(file).isFile())
        throw new NovaError('not_found', 'not a pet frame');
      void reply
        .header('content-type', type)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=3600');
      return reply.send(readFileSync(file));
    });
  }

  return Promise.resolve({
    service,
    pets,
    useExtensionInstaller(installer: ExtensionInstaller | null) {
      pluginInstaller.useExtensions(installer);
    },
    useMcpInstaller(installer: MarketInstaller | null) {
      if (installer) installers.mcp = installer;
      else delete installers.mcp;
    },
    useAudit(a: AuditSink) {
      audit = a;
    },
    register,
    close() {
      clearInterval(sweep);
      offSettings();
      service.close();
      return Promise.resolve();
    },
  });
}
