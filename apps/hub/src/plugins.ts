// Plugins, catalogs, skills and slash commands (FR-045, FR-046, FR-049 stub; docs/08 §3-§4, §7;
// hub-api M4). The installer and the skill index live in @nova/core; this area wires them to the
// database, the vault, the MCP manager (a plugin's servers are `mcp_server` rows with source
// `plugin`) and the routes. The built-in sample catalog is `<repo>/examples/catalog` when present.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSkillSchema, idSchema, installPluginSchema, pluginSourceSchema } from '@nova/shared';
import {
  PluginCatalogs,
  PluginService,
  SkillIndex,
  managedRestrictions,
  type AuditSink,
  type CatalogConfig,
  type PluginCatalogsOptions,
  type PluginHookSource,
  type PluginPermissionSource,
  type PluginServerRow,
  type SkillCatalogProvider,
} from '@nova/core';
import type { McpServerConfig } from '@nova/mcp';
import type { HubArea, HubContext } from './hub-context.ts';
import type { HubMcpArea } from './mcp.ts';

export interface PluginsArea extends HubArea {
  skills: SkillCatalogProvider;
  permissions: PluginPermissionSource;
  /** The installer (the import area installs plugins disabled through it, FR-200). */
  service: PluginService;
  /** The skill index (the import area creates imported skills through it). */
  index: SkillIndex;
  /**
   * Plugin hooks with their content hashes, for the hooks area, which owns trust (FR-197). Its
   * `onChange` carries the hooks the user trusted on the install screen.
   */
  hooks: PluginHookSource;
  /**
   * Wire the hooks area's count of a plugin's untrusted hooks (its `untrustedPluginHooks`) into
   * PluginView.status; until then the hooks trusted on the install screen decide it.
   */
  useHookTrust(fn: (accountId: string, pluginId: string) => Promise<number | null>): void;
  /** The validated manifests of enabled plugins, for the MCP Apps area's UI entry points. */
  enabledManifests(
    accountId: string,
  ): Promise<{ pluginId: string; manifest: Record<string, unknown> }[]>;
  /** The UI entry points of enabled plugins with the server ids that serve them (FR-198). */
  uiEntryPoints: PluginService['uiEntryPoints'];
  /** A plugin server's manifest `defaultApproval`, for the gate's per-server defaults (FR-048). */
  serverDefault(accountId: string, serverId: string): Promise<'allow' | 'ask' | 'deny' | null>;
}

export interface PluginsDeps {
  audit: AuditSink;
  mcp: HubMcpArea;
  /** The built-in sample catalog folder; null for none (tests). */
  sampleCatalogDir?: string | null;
  /** Skills shipped with Nova. */
  builtinSkillsDir?: string | null;
  /** Fetch and Git for URL and Git catalogs (tests replace them). */
  catalogs?: Pick<PluginCatalogsOptions, 'fetch' | 'git' | 'gitCommand'>;
}

export const SAMPLE_CATALOG_ID = 'nova-sample';
const DEFAULT_SAMPLE_DIR = fileURLToPath(new URL('../../../examples/catalog/', import.meta.url));
const DEFAULT_BUILTIN_SKILLS = fileURLToPath(
  new URL('../../../packages/core/skills/', import.meta.url),
);

const params = z.object({ id: z.string().min(1).max(300) });
const projectQuery = z.object({ projectId: idSchema.optional() });
const enabledBody = z.object({ enabled: z.boolean() });
const previewBody = z.object({ source: pluginSourceSchema });
const catalogQuery = z.object({ q: z.string().max(200).default('') });

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The manager's config for a stored plugin server (the same reading as the MCP area's). */
export function pluginServerConfig(row: PluginServerRow): McpServerConfig {
  const c = parseJson<Record<string, unknown>>(row.configJson, {});
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: parseJson<string[]>(row.argsJson, []),
    url: row.url,
    env: parseJson<Record<string, string>>(row.envRefJson, {}),
    headers: {},
    enabled: row.enabled,
    startupTimeoutMs: typeof c.startupTimeoutMs === 'number' ? c.startupTimeoutMs : 30_000,
    toolTimeoutMs: typeof c.toolTimeoutMs === 'number' ? c.toolTimeoutMs : 60_000,
    enabledTools: Array.isArray(c.enabledTools) ? (c.enabledTools as string[]) : null,
    disabledTools: Array.isArray(c.disabledTools) ? (c.disabledTools as string[]) : [],
  };
}

/**
 * The `node_modules` folder Nova's own packages resolve from, for NODE_PATH of Node plugin
 * servers (the sample plugin requires the MCP server SDK from there); null when not found.
 */
export function novaNodeModules(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@modelcontextprotocol/server');
    const parts = entry.split(sep);
    const i = parts.lastIndexOf('node_modules');
    return i > 0 ? parts.slice(0, i + 1).join(sep) : null;
  } catch {
    return null;
  }
}

export function setupPlugins(ctx: HubContext & PluginsDeps): Promise<PluginsArea> {
  const { db, events, audit, accountOf, mcp } = ctx;
  const log = ctx.log.child('plugins');
  const sampleDir = ctx.sampleCatalogDir === undefined ? DEFAULT_SAMPLE_DIR : ctx.sampleCatalogDir;
  const builtinDir =
    ctx.builtinSkillsDir === undefined ? DEFAULT_BUILTIN_SKILLS : ctx.builtinSkillsDir;

  const index = new SkillIndex({
    db,
    userDir: join(ctx.dataDir, 'skills'),
    builtinDir: builtinDir && existsSync(builtinDir) ? builtinDir : null,
    events,
    log: log.child('skills'),
  });

  async function catalogConfigs(): Promise<CatalogConfig[]> {
    const out: CatalogConfig[] = [];
    if (sampleDir && existsSync(join(sampleDir, 'catalog.json')))
      out.push({ id: SAMPLE_CATALOG_ID, name: 'Sample catalog', location: sampleDir });
    for (const c of await ctx.setting('plugins.catalogs'))
      if (!out.some((x) => x.id === c.id)) out.push(c);
    return out;
  }

  const service = new PluginService({
    db,
    secrets: ctx.secrets,
    dataDir: ctx.dataDir,
    catalogs: new PluginCatalogs({
      cacheDir: join(ctx.dataDir, 'cache', 'plugins'),
      ...ctx.catalogs,
    }),
    catalogConfigs,
    servers: {
      // A server managed policy refuses (or of a plugin it refuses) is not started (FR-106).
      apply: async (row) => {
        const managed = managedRestrictions(await ctx.setting('managed.restrict'));
        const refused =
          (row.pluginId ? managed.plugin(row.pluginId) : null) ??
          managed.mcpServer({
            name: row.name,
            source: row.source,
            transport: row.transport,
            deviceId: row.deviceId,
          });
        const config = pluginServerConfig(row);
        await mcp.manager.update(refused ? { ...config, enabled: false } : config);
      },
      remove: async (id) => {
        await mcp.manager.remove(id);
      },
    },
    skills: index,
    events,
    audit,
    novaVersion: ctx.config.version,
    nodePath: novaNodeModules(),
    // Managed policy (FR-106): refused plugins and unverified installs.
    managed: async () => managedRestrictions(await ctx.setting('managed.restrict')),
    log,
  });

  function register(app: FastifyInstance): void {
    // ---- plugins ----------------------------------------------------------------------------
    app.get('/api/v1/plugins', async (req) => ({
      items: await service.list(await accountOf(req)),
    }));

    app.post('/api/v1/plugins/preview', async (req) => {
      const accountId = await accountOf(req);
      const body = previewBody.parse(req.body);
      return service.preview(accountId, body.source);
    });

    app.post('/api/v1/plugins', async (req, reply) => {
      const accountId = await accountOf(req);
      const body = installPluginSchema.parse(req.body);
      const view = await service.install(accountId, body);
      void reply.status(201);
      return view;
    });

    app.patch('/api/v1/plugins/:id', async (req) => {
      const accountId = await accountOf(req);
      const { id } = params.parse(req.params);
      const body = enabledBody.parse(req.body ?? {});
      return service.setEnabled(accountId, id, body.enabled);
    });

    app.delete('/api/v1/plugins/:id', async (req) => {
      const accountId = await accountOf(req);
      await service.uninstall(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    app.get('/api/v1/plugins/catalogs', async (req) => {
      await accountOf(req);
      return { items: await service.catalogViews() };
    });

    app.get('/api/v1/plugins/catalog', async (req) => {
      const accountId = await accountOf(req);
      const q = catalogQuery.parse(req.query);
      return { items: await service.catalogEntries(accountId, q.q) };
    });

    // ---- skills and slash commands ------------------------------------------------------------
    app.get('/api/v1/skills', async (req) => {
      const accountId = await accountOf(req);
      const q = projectQuery.parse(req.query);
      return { items: await index.views(accountId, q.projectId ?? null) };
    });

    app.post('/api/v1/skills', async (req, reply) => {
      const accountId = await accountOf(req);
      const body = createSkillSchema.parse(req.body);
      const view = await index.create(accountId, body);
      void reply.status(201);
      return view;
    });

    app.get('/api/v1/skills/:id', async (req) => {
      const accountId = await accountOf(req);
      return index.get(accountId, params.parse(req.params).id);
    });

    app.patch('/api/v1/skills/:id', async (req) => {
      const accountId = await accountOf(req);
      const { id } = params.parse(req.params);
      const body = enabledBody.parse(req.body ?? {});
      return index.setEnabled(accountId, id, body.enabled);
    });

    app.delete('/api/v1/skills/:id', async (req) => {
      const accountId = await accountOf(req);
      await index.delete(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    app.get('/api/v1/slash-commands', async (req) => {
      const accountId = await accountOf(req);
      const q = projectQuery.parse(req.query);
      return { items: await index.slashCommands(accountId, q.projectId ?? null) };
    });
  }

  return Promise.resolve({
    skills: index,
    permissions: service,
    service,
    index,
    hooks: service.hooks,
    useHookTrust: (fn) => service.useHookTrust(fn),
    enabledManifests: (accountId) => service.enabledManifests(accountId),
    uiEntryPoints: (accountId) => service.uiEntryPoints(accountId),
    serverDefault: (accountId, serverId) => service.serverDefault(accountId, serverId),
    register,
    close: () => Promise.resolve(),
  });
}
