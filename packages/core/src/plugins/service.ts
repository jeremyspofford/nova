// The plugin installer (FR-045, docs/08 §3.2, docs/26 §3): preview without side effects, install
// into `<dataDir>/plugins/<id>/<version>/`, update by replacing the previous version atomically,
// enable, disable and uninstall. An install registers the plugin's skills (commands converted to
// skills), sub-agent roles, MCP servers (`mcp_server` rows with source `plugin`) and hooks
// (handed to the hooks area, which owns trust). Declared permissions are recorded and enforced
// by the policy gate through `forTool`; they are never trusted as a grant.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import {
  NovaError,
  uuidv7,
  type CatalogEntryView,
  type CatalogView,
  type HookView,
  type installPluginSchema,
  type PluginPreview,
  type PluginSource,
  type PluginView,
  type pluginSourceSchema,
  type ToolDescriptor,
} from '@nova/shared';
import { secretRef, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { PluginPermissionSource, PluginPermissions } from '../extensions/types.ts';
import type { AuditSink } from '../tools/types.ts';
import { type CatalogConfig, type PluginCatalogs } from './catalog.ts';
import { renderFrontmatter } from './frontmatter.ts';
import { expandPluginRoot } from './hook-hash.ts';
import {
  COMMANDS_DIR,
  compareSemver,
  loadPluginFolder,
  loadPluginHooks,
  serverNameFor,
  type LoadedPlugin,
  type LoadedPluginServer,
} from './manifest.ts';
import { copyTree, treeDigest, walkTree } from './paths.ts';
import type { SkillIndex } from './skills.ts';
import type {
  PluginApprovalDefault,
  PluginHookConfig,
  PluginManifest,
  PluginMcpServerConfig,
  PluginRegistrations,
  PluginSkillEntry,
  PluginUiEntryPoint,
} from './types.ts';

const { agentRole, mcpServer, pluginInstall } = schema;
type InstallRow = typeof pluginInstall.$inferSelect;
export type PluginServerRow = typeof mcpServer.$inferSelect;
export type PluginSourceRequest = z.infer<typeof pluginSourceSchema>;
export type InstallPluginRequest = z.input<typeof installPluginSchema>;

/** Previews expire after 30 minutes (hub-api M4). */
export const PLUGIN_PREVIEW_TTL_MS = 30 * 60_000;
const MAX_PREVIEWS = 50;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/** Starts and stops a plugin's MCP servers (the Hub's MCP manager). */
export interface PluginServerHost {
  /** The row was created or changed: (re)connect it, or stop it when it is disabled. */
  apply(row: PluginServerRow): Promise<void>;
  /** The row was deleted: disconnect and forget the server. */
  remove(serverId: string): Promise<void>;
}

/** One hook a plugin brings, for the hooks area (FR-197). */
export interface PluginHookDefinition {
  /** `hook:<pluginId>.<hookId>` (docs/08 §8). */
  id: string;
  pluginId: string;
  /** As written in the plugin (hook-config.json#/$defs/hook); `${pluginRoot}` not expanded. */
  hook: PluginHookConfig;
  /** `sha256:…` over the definition and the scripts it runs inside the plugin folder. */
  contentHash: string;
  /** The installed plugin folder: relative paths and `${pluginRoot}` resolve against it. */
  root: string;
  pluginEnabled: boolean;
  /** The manifest lets this plugin's hooks answer eligible asks (`permissions.hooks.answersAsks`). */
  answersAsks: boolean;
  /** The plugin's network permission; its hooks stay within it. */
  network: string[];
}

export interface PluginHookChange {
  accountId: string;
  pluginId: string;
  change: 'installed' | 'updated' | 'enabled' | 'disabled' | 'removed';
  /** Hooks the user trusted on the install screen, whose hash matched the installed hook. */
  trust: { id: string; contentHash: string }[];
}

export interface PluginHookSource {
  /** Every installed plugin's hooks with their current content hashes (re-read from disk). */
  list(accountId: string): Promise<PluginHookDefinition[]>;
  /** Called after an install, update, enable, disable or uninstall. */
  onChange(listener: (change: PluginHookChange) => void | Promise<void>): () => void;
}

interface ServerPlan {
  rows: PluginServerRow[];
  removed: PluginServerRow[];
  /** Vault entries created for new servers (removed again if the install fails). */
  newSecrets: string[];
  /** Vault entries of env names an existing server no longer has. */
  staleSecrets: string[];
}

/** A plugin's UI entry point with what the MCP Apps host needs to serve it (FR-198). */
export interface PluginUiEntry {
  pluginId: string;
  kind: PluginUiEntryPoint['kind'];
  resource: string;
  title: string;
  extensions: string[];
  /** The plugin's MCP servers, in manifest order; one of them serves the resource. */
  serverIds: string[];
  /** `permissions.ui` domain lists, to intersect with `network` for the iframe CSP. */
  connectDomains: string[];
  resourceDomains: string[];
  network: string[];
}

export interface PluginServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  dataDir: string;
  catalogs: PluginCatalogs;
  /** The catalogs in settings plus the built-in sample one. */
  catalogConfigs: () => Promise<CatalogConfig[]>;
  servers?: PluginServerHost;
  skills?: SkillIndex;
  events?: EventSink;
  audit?: AuditSink;
  /** The Hub version, for `engines.nova`. */
  novaVersion?: string;
  /**
   * The folder holding Nova's own Node packages. Node plugin servers get it as NODE_PATH, so a
   * server can require the MCP SDK Nova ships instead of bundling it.
   */
  nodePath?: string | null;
  /** How many of a plugin's hooks are not trusted now; wired to the hooks area. */
  hookTrust?: (accountId: string, pluginId: string) => Promise<number | null>;
  previewTtlMs?: number;
  log?: Logger;
  now?: () => Date;
}

interface PreviewRecord {
  id: string;
  accountId: string;
  source: PluginSource;
  origin: string;
  loaded: LoadedPlugin;
  digest: string;
  expiresAt: number;
}

/** `hook:<pluginId>.<hookId>`. */
export function pluginHookId(pluginId: string, hookId: string): string {
  return `hook:${pluginId}.${hookId}`;
}

function matcherText(m: PluginHookConfig['matcher']): string | null {
  if (m === undefined) return null;
  return Array.isArray(m) ? m.join(', ') : m;
}

/** A plugin hook as the install screen and the hooks list show it (status before trust). */
export function pluginHookView(
  pluginId: string,
  hook: PluginHookConfig,
  contentHash: string,
): HookView {
  return {
    id: pluginHookId(pluginId, hook.id),
    source: 'plugin',
    pluginId,
    event: hook.event as HookView['event'],
    matcher: matcherText(hook.matcher),
    handler:
      hook.handler.type === 'command'
        ? { type: 'command', command: hook.handler.command }
        : { type: 'mcp_tool', tool: hook.handler.tool },
    timeoutMs: hook.handler.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    contentHash,
    status: 'needs_trust',
    enabled: hook.enabled ?? true,
    lastRun: null,
  };
}

function registrationsOf(row: InstallRow): PluginRegistrations {
  const empty: PluginRegistrations = {
    servers: {},
    skills: [],
    roles: [],
    hooks: [],
    trustedHooks: [],
    uiEntryPoints: 0,
    digest: '',
  };
  try {
    return { ...empty, ...(JSON.parse(row.registrationsJson) as Partial<PluginRegistrations>) };
  } catch {
    return empty;
  }
}

function manifestOf(row: InstallRow): PluginManifest {
  return JSON.parse(row.manifestJson) as PluginManifest;
}

/**
 * The manifest as stored in `plugin_install`: every server env and header value replaced by the
 * vault reference it became, so a literal secret in plugin.json never reaches the database.
 */
function withVaultRefs(m: PluginManifest, rows: PluginServerRow[]): PluginManifest {
  if (!m.mcpServers) return m;
  const servers: Record<string, PluginMcpServerConfig> = {};
  for (const [key, c] of Object.entries(m.mcpServers)) {
    const row = rows.find(
      (r) =>
        (JSON.parse(r.configJson ?? '{}') as { pluginServerKey?: string }).pluginServerKey === key,
    );
    const refs = JSON.parse(row?.envRefJson ?? '{}') as Record<string, string>;
    const ref = (name: string, v: string) => (v.startsWith('secret://') ? v : (refs[name] ?? ''));
    const map = (o: Record<string, string>, name: (k: string) => string) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ref(name(k), v)]));
    servers[key] = {
      ...c,
      ...(c.env ? { env: map(c.env, (k) => k) } : {}),
      ...(c.headers ? { headers: map(c.headers, (k) => k.replace(/-/g, '_')) } : {}),
    };
  }
  return { ...m, mcpServers: servers };
}

/** The tool's own name segment: `mcp:<server>.<tool>` → `<tool>`, `plugin:<id>.<tool>` → `<tool>`. */
function toolSegment(name: string, pluginId?: string): string {
  if (pluginId && name.startsWith(`plugin:${pluginId}.`))
    return name.slice(`plugin:${pluginId}.`.length);
  if (name.startsWith('mcp:')) return name.slice(name.indexOf('.') + 1);
  return name;
}

export class PluginService implements PluginPermissionSource {
  readonly #db: NovaDatabase;
  readonly #o: PluginServiceOptions;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #previews = new Map<string, PreviewRecord>();
  readonly #listeners = new Set<(c: PluginHookChange) => void | Promise<void>>();
  /** Installs, updates, switches and uninstalls run one at a time (they move folders). */
  #chain: Promise<unknown> = Promise.resolve();
  readonly hooks: PluginHookSource;

  constructor(opts: PluginServiceOptions) {
    this.#db = opts.db;
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.plugins', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.hooks = {
      list: (accountId) => this.#hookDefinitions(accountId),
      onChange: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  /** Wire the hooks area's trust state into PluginView.status. */
  useHookTrust(fn: (accountId: string, pluginId: string) => Promise<number | null>): void {
    this.#o.hookTrust = fn;
  }

  get pluginsDir(): string {
    return join(this.#o.dataDir, 'plugins');
  }

  // ---- reads --------------------------------------------------------------------------------

  async list(accountId: string): Promise<PluginView[]> {
    const rows = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(eq(pluginInstall.accountId, accountId));
    rows.sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1));
    const out: PluginView[] = [];
    for (const r of rows) out.push(await this.#view(r));
    return out;
  }

  async get(accountId: string, pluginId: string): Promise<PluginView> {
    return this.#view(await this.#row(accountId, pluginId));
  }

  async #row(accountId: string, pluginId: string): Promise<InstallRow> {
    const [row] = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.pluginId, pluginId)));
    if (!row) throw new NovaError('not_found', 'plugin not found');
    return row;
  }

  async #view(row: InstallRow): Promise<PluginView> {
    const m = manifestOf(row);
    const reg = registrationsOf(row);
    let untrusted: number | null = null;
    if (reg.hooks.length && this.#o.hookTrust) {
      try {
        untrusted = await this.#o.hookTrust(row.accountId, row.pluginId);
      } catch (err) {
        this.#log.warn('hook trust lookup failed', { err, pluginId: row.pluginId });
      }
    }
    untrusted ??= reg.hooks.filter(
      (h) => !reg.trustedHooks.some((t) => t.id === h.id && t.contentHash === h.contentHash),
    ).length;
    const status: PluginView['status'] = row.error
      ? 'error'
      : !row.enabled
        ? 'disabled'
        : untrusted > 0
          ? 'needs_trust'
          : 'ok';
    return {
      id: row.pluginId,
      name: m.name,
      version: row.version,
      description: m.description ?? null,
      author: m.author?.name ?? null,
      source: row.source,
      origin: row.origin,
      enabled: row.enabled,
      verified: row.signature === 'verified',
      permissions: m.permissions as Record<string, unknown>,
      components: {
        skills: reg.skills.filter((s) => s.kind === 'skill').length,
        commands: reg.skills.filter((s) => s.kind === 'command').length,
        agents: reg.roles.length,
        hooks: reg.hooks.length,
        mcpServers: Object.keys(reg.servers).length,
        uiEntryPoints: reg.uiEntryPoints,
      },
      status,
      error: row.error,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
    };
  }

  /** The roles plugins brought (M5 sub-agents read these). */
  async roles(accountId: string): Promise<(typeof agentRole.$inferSelect)[]> {
    return this.#db.orm.select().from(agentRole).where(eq(agentRole.accountId, accountId));
  }

  /** The validated manifests of the account's enabled plugins, by plugin id (FR-198 entry points). */
  async enabledManifests(
    accountId: string,
  ): Promise<{ pluginId: string; manifest: Record<string, unknown> }[]> {
    const rows = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.enabled, true)));
    return rows
      .sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1))
      .map((r) => ({
        pluginId: r.pluginId,
        manifest: manifestOf(r) as unknown as Record<string, unknown>,
      }));
  }

  /**
   * The UI entry points of enabled plugins (FR-198), with the ids of the plugin's MCP servers
   * that may serve each `ui://` resource, in manifest order.
   */
  async uiEntryPoints(accountId: string): Promise<PluginUiEntry[]> {
    const rows = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.enabled, true)));
    const out: PluginUiEntry[] = [];
    for (const r of rows.sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1))) {
      const m = manifestOf(r);
      const reg = registrationsOf(r);
      const serverIds = Object.keys(m.mcpServers ?? {})
        .map((k) => reg.servers[k])
        .filter((id): id is string => typeof id === 'string');
      for (const e of m.ui?.entryPoints ?? [])
        out.push({
          pluginId: r.pluginId,
          kind: e.kind,
          resource: e.resource,
          title: e.title ?? m.name,
          extensions: e.extensions ?? [],
          serverIds,
          connectDomains: m.permissions.ui?.connectDomains ?? [],
          resourceDomains: m.permissions.ui?.resourceDomains ?? [],
          network: m.permissions.network ?? [],
        });
    }
    return out;
  }

  /** The `defaultApproval` a plugin's manifest set for one of its servers (FR-048); null otherwise. */
  async serverDefault(accountId: string, serverId: string): Promise<PluginApprovalDefault | null> {
    const [s] = await this.#db.orm
      .select()
      .from(mcpServer)
      .where(and(eq(mcpServer.id, serverId), eq(mcpServer.accountId, accountId)));
    if (s?.source !== 'plugin') return null;
    const d = serverConfig(s).defaultApproval;
    return d === 'allow' || d === 'ask' || d === 'deny' ? d : null;
  }

  // ---- catalogs -----------------------------------------------------------------------------

  async catalogViews(): Promise<CatalogView[]> {
    return (await this.#o.catalogConfigs()).map((c) => this.#o.catalogs.view(c));
  }

  /** Entries across every catalog that can be read now, filtered by `q`; unreadable ones are skipped. */
  async catalogEntries(accountId: string, q = ''): Promise<CatalogEntryView[]> {
    const installed = new Map((await this.list(accountId)).map((p) => [p.id, p.version]));
    const needle = q.trim().toLowerCase();
    const out: CatalogEntryView[] = [];
    for (const c of await this.#o.catalogConfigs()) {
      let entries;
      try {
        entries = (await this.#o.catalogs.listing(c)).entries;
      } catch (err) {
        this.#log.warn('catalog unreadable', {
          catalogId: c.id,
          err: err instanceof Error ? err.message : err,
        });
        continue;
      }
      for (const e of entries) {
        const hay = `${e.id} ${e.name} ${e.description ?? ''}`.toLowerCase();
        if (needle && !hay.includes(needle)) continue;
        out.push({
          catalogId: c.id,
          pluginId: e.id,
          name: e.name,
          version: e.version,
          description: e.description ?? null,
          verified: false,
          installedVersion: installed.get(e.id) ?? null,
        });
      }
    }
    return out;
  }

  // ---- preview ------------------------------------------------------------------------------

  /** Validate a plugin and say what installing it would do; nothing is installed or registered. */
  async preview(accountId: string, source: PluginSourceRequest): Promise<PluginPreview> {
    this.#sweepPreviews();
    const { root, kind, origin } = await this.#locate(source);
    const loaded = loadPluginFolder(
      root,
      this.#o.novaVersion ? { novaVersion: this.#o.novaVersion } : {},
    );
    const digest = treeDigest(walkTree(root));
    const [current] = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(
        and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.pluginId, loaded.manifest.id)),
      );
    const warnings = [
      'Unverified: catalog and plugin signatures are checked once the marketplace ships (FR-049). Install only plugins you trust.',
      ...loaded.warnings,
    ];
    if (current && compareSemver(loaded.manifest.version, current.version) < 0)
      warnings.push(`This is an older version than the installed ${current.version}.`);
    for (const s of loaded.servers) {
      if (s.config.auth)
        warnings.push(`Server ${s.key}: \`auth\` is not used for plugin servers yet; use headers.`);
      if (s.config.oauth)
        warnings.push(
          `Server ${s.key}: OAuth sign-in for plugin servers is set up in Settings after install.`,
        );
    }
    const id = uuidv7();
    if (this.#previews.size >= MAX_PREVIEWS) {
      const oldest = [...this.#previews.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest) this.#previews.delete(oldest.id);
    }
    this.#previews.set(id, {
      id,
      accountId,
      source: kind,
      origin,
      loaded,
      digest,
      expiresAt: this.#now().getTime() + (this.#o.previewTtlMs ?? PLUGIN_PREVIEW_TTL_MS),
    });
    return {
      previewId: id,
      manifest: loaded.manifest as unknown as Record<string, unknown>,
      permissions: loaded.manifest.permissions as Record<string, unknown>,
      hooks: loaded.hooks.map((h) => pluginHookView(loaded.manifest.id, h.hook, h.contentHash)),
      mcpServers: loaded.servers.map((s) => ({
        name: serverNameFor(s.key),
        transport: s.config.transport,
        command: s.config.command ?? null,
        url: s.config.url ?? null,
      })),
      skills: loaded.skills.map((s) => ({ name: s.name, description: s.description })),
      verified: false,
      warnings,
      replaces: current ? { version: current.version } : null,
    };
  }

  #sweepPreviews(): void {
    const now = this.#now().getTime();
    for (const [id, p] of this.#previews) if (p.expiresAt <= now) this.#previews.delete(id);
  }

  async #locate(
    source: PluginSourceRequest,
  ): Promise<{ root: string; kind: PluginSource; origin: string }> {
    switch (source.kind) {
      case 'path': {
        let root: string;
        try {
          root = realpathSync(source.path);
        } catch {
          throw new NovaError('validation', `plugin folder not found: ${source.path}`);
        }
        if (!statSync(root).isDirectory())
          throw new NovaError('validation', 'the plugin path is not a folder');
        return { root, kind: 'local', origin: root };
      }
      case 'catalog': {
        const c = (await this.#o.catalogConfigs()).find((x) => x.id === source.catalogId);
        if (!c) throw new NovaError('not_found', `catalog ${source.catalogId} not found`);
        const r = await this.#o.catalogs.resolve(c, source.pluginId, source.version);
        return { root: r.root, kind: 'catalog', origin: r.origin };
      }
      case 'git': {
        const clone = await this.#o.catalogs.cloneGit(source.url, source.ref);
        return { root: clone.dir, kind: 'git', origin: `${source.url}#${clone.commit}` };
      }
    }
  }

  // ---- install and update -------------------------------------------------------------------

  install(accountId: string, req: InstallPluginRequest): Promise<PluginView> {
    return this.#serial(() => this.#install(accountId, req));
  }

  async #install(accountId: string, req: InstallPluginRequest): Promise<PluginView> {
    this.#sweepPreviews();
    const p = this.#previews.get(req.previewId);
    if (!p || p.accountId !== accountId)
      throw new NovaError(
        'request_expired',
        'the plugin preview expired; preview the plugin again',
      );
    // No plugin is signed by a trusted publisher yet (FR-049), so each install is a sideload
    // and needs the explicit confirmation (docs/08 §7, §11).
    if (req.confirmSideload !== true)
      throw new NovaError('validation', 'confirm that you want to install an unverified plugin', {
        details: { field: 'confirmSideload', reason: 'sideload_confirmation_required' },
      });
    const loaded = p.loaded;
    const m = loaded.manifest;
    if (!existsSync(loaded.root))
      throw new NovaError('conflict', 'the plugin folder is gone; preview the plugin again');
    const entries = walkTree(loaded.root);
    if (treeDigest(entries) !== p.digest)
      throw new NovaError('conflict', 'the plugin changed after the preview; preview it again');
    const enable = req.enable ?? true;
    const [current] = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.pluginId, m.id)));
    const prevReg = registrationsOrEmpty(current);
    const pluginDir = join(this.pluginsDir, m.id);
    const installDir = join(pluginDir, m.version);
    const staging = join(pluginDir, `.staging-${uuidv7()}`);
    const backup = join(pluginDir, `.previous-${uuidv7()}`);
    mkdirSync(pluginDir, { recursive: true, mode: 0o700 });

    // 1. Files: copy, convert commands, then swap the version folder in.
    const skills: PluginSkillEntry[] = [];
    try {
      copyTree(entries, staging);
      for (const s of loaded.skills) {
        if (s.kind === 'skill') {
          skills.push({
            name: s.name,
            description: s.description,
            kind: 'skill',
            path: s.sourcePath,
          });
          continue;
        }
        const rel = `${COMMANDS_DIR}/${s.name}`;
        const dir = join(staging, ...rel.split('/'));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // The command body becomes SKILL.md; its front-matter keeps the command's own keys.
        const fm: Record<string, unknown> = {
          ...s.frontmatter,
          name: s.name,
          description: s.description,
        };
        writeFileSync(join(dir, 'SKILL.md'), renderFrontmatter(fm) + s.body, { mode: 0o600 });
        skills.push({ name: s.name, description: s.description, kind: 'command', path: rel });
      }
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    const replacedSameVersion = existsSync(installDir);
    if (replacedSameVersion) renameSync(installDir, backup);
    try {
      renameSync(staging, installDir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      if (replacedSameVersion) renameSync(backup, installDir);
      throw err;
    }
    const rollbackFiles = () => {
      rmSync(installDir, { recursive: true, force: true });
      if (replacedSameVersion) renameSync(backup, installDir);
    };

    // 2. MCP servers: rows (ids kept per manifest key across updates) and their env in the vault.
    const now = this.#now().toISOString();
    let plan: ServerPlan;
    try {
      plan = await this.#planServers(
        accountId,
        m.id,
        loaded.servers,
        prevReg.servers,
        installDir,
        enable,
        now,
      );
    } catch (err) {
      rollbackFiles();
      throw err;
    }
    const hooks = loaded.hooks.map((h) => ({
      id: pluginHookId(m.id, h.hook.id),
      contentHash: h.contentHash,
    }));
    const trust = (req.trustHooks ?? [])
      .filter((t) =>
        hooks.some(
          (h) =>
            (h.id === t.id || h.id === pluginHookId(m.id, t.id)) && h.contentHash === t.contentHash,
        ),
      )
      .map((t) => ({
        id: t.id.startsWith('hook:') ? t.id : pluginHookId(m.id, t.id),
        contentHash: t.contentHash,
      }));
    const registrations: PluginRegistrations = {
      servers: Object.fromEntries(plan.rows.map((r) => [serverKeyOf(r), r.id])),
      skills,
      roles: loaded.roles.map((r) => r.key),
      hooks,
      // Trust carries over for hooks whose hash did not change (docs/08 §3.2).
      trustedHooks: [
        ...trust,
        ...prevReg.trustedHooks.filter(
          (t) =>
            hooks.some((h) => h.id === t.id && h.contentHash === t.contentHash) &&
            !trust.some((x) => x.id === t.id),
        ),
      ],
      uiEntryPoints: loaded.uiEntryPoints.length,
      digest: p.digest,
    };
    const row: InstallRow = {
      id: current?.id ?? uuidv7(),
      accountId,
      pluginId: m.id,
      version: m.version,
      source: p.source,
      origin: p.origin,
      manifestJson: JSON.stringify(withVaultRefs(m, plan.rows)),
      signature: 'unverified',
      installPath: installDir,
      registrationsJson: JSON.stringify(registrations),
      enabled: enable,
      error: null,
      installedAt: current?.installedAt ?? now,
      updatedAt: now,
    };

    // 3. One transaction for every row the plugin owns.
    try {
      await this.#db.transaction(async () => {
        if (current)
          await this.#db.orm.update(pluginInstall).set(row).where(eq(pluginInstall.id, current.id));
        else await this.#db.orm.insert(pluginInstall).values(row);
        await this.#db.orm
          .delete(agentRole)
          .where(and(eq(agentRole.accountId, accountId), eq(agentRole.pluginId, m.id)));
        for (const r of loaded.roles) {
          await this.#db.orm.insert(agentRole).values({
            id: uuidv7(),
            accountId,
            roleKey: r.key,
            pluginId: m.id,
            name: r.name,
            description: r.description,
            toolsJson: JSON.stringify(r.tools),
            modelHint: r.modelHint,
            instructions: r.instructions,
            sourcePath: r.sourcePath,
            createdAt: now,
            updatedAt: now,
          });
        }
        for (const s of plan.removed)
          await this.#db.orm.delete(mcpServer).where(eq(mcpServer.id, s.id));
        for (const s of plan.rows) {
          const [exists] = await this.#db.orm
            .select({ id: mcpServer.id })
            .from(mcpServer)
            .where(eq(mcpServer.id, s.id));
          if (exists) {
            const { id: _id, createdAt: _c, lastStatus: _s, lastError: _e, ...rest } = s;
            await this.#db.orm.update(mcpServer).set(rest).where(eq(mcpServer.id, s.id));
          } else await this.#db.orm.insert(mcpServer).values(s);
        }
      });
    } catch (err) {
      for (const ref of plan.newSecrets) await this.#o.secrets.delete(ref).catch(() => undefined);
      rollbackFiles();
      if (err instanceof Error && /UNIQUE/i.test(err.message))
        throw new NovaError('conflict', 'an MCP server name of this plugin is taken; try again');
      throw err;
    }

    // 4. After commit: old files go, servers (re)start, everyone hears about it.
    this.#previews.delete(p.id);
    if (replacedSameVersion) rmSync(backup, { recursive: true, force: true });
    if (current && current.installPath !== installDir)
      await this.#removeFolderIfUnused(current.installPath);
    this.#sweepStale(pluginDir, installDir);
    for (const s of plan.removed) {
      await this.#stopServer(s.id);
      await this.#deleteServerSecrets(s.id);
    }
    for (const ref of plan.staleSecrets) await this.#o.secrets.delete(ref);
    for (const s of plan.rows) this.#applyServer(s);
    const change = current ? 'updated' : 'installed';
    await this.#o.events?.emit({
      name: current ? 'plugin.updated' : 'plugin.installed',
      actor: 'user',
      accountId,
      payload: { pluginId: m.id, version: m.version },
    });
    await this.#record(accountId, current ? 'plugin.update' : 'plugin.install', m.id, {
      version: m.version,
      previousVersion: current?.version ?? null,
      source: p.source,
      origin: p.origin,
      verified: false,
      enabled: enable,
      servers: plan.rows.map((r) => r.name),
      hooks: hooks.length,
      trustedHooks: registrations.trustedHooks.length,
    });
    await this.#notify({ accountId, pluginId: m.id, change, trust: registrations.trustedHooks });
    return this.#view(row);
  }

  /** Server rows for an install: ids and names kept per key, env values moved to the vault. */
  async #planServers(
    accountId: string,
    pluginId: string,
    servers: LoadedPluginServer[],
    previous: Record<string, string>,
    installDir: string,
    enable: boolean,
    now: string,
  ): Promise<ServerPlan> {
    const all = await this.#db.orm
      .select()
      .from(mcpServer)
      .where(eq(mcpServer.accountId, accountId));
    const mine = all.filter((r) => r.source === 'plugin' && r.pluginId === pluginId);
    const taken = new Set(
      all.filter((r) => !(r.source === 'plugin' && r.pluginId === pluginId)).map((r) => r.name),
    );
    const rows: PluginServerRow[] = [];
    const newSecrets: string[] = [];
    const staleSecrets: string[] = [];
    const keep = new Set<string>();
    try {
      for (const s of servers) {
        const c = s.config;
        const existing = mine.find((r) => r.id === previous[s.key]);
        const id = existing?.id ?? uuidv7();
        keep.add(id);
        let name = existing?.name ?? serverNameFor(s.key);
        if (!existing) {
          // A colliding name is renamed (docs/08 §8): `<key>-2`, `<key>-3`, …
          const base = name;
          for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 36)}-${n}`;
        }
        taken.add(name);
        const expand = (v: string) => expandPluginRoot(v, installDir);
        const literal: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.env ?? {})) literal[k] = expand(v);
        if (c.transport !== 'stdio')
          for (const [k, v] of Object.entries(c.headers ?? {})) literal[k.replace(/-/g, '_')] = v;
        const command = c.command ? expand(c.command) : null;
        if (
          c.transport === 'stdio' &&
          command &&
          /^node(\.exe)?$/.test(basename(command)) &&
          this.#o.nodePath &&
          !literal.NODE_PATH
        )
          literal.NODE_PATH = this.#o.nodePath;
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(literal)) {
          if (v.startsWith('secret://')) {
            env[k] = v;
            continue;
          }
          const ref = secretRef('mcp', id, 'env', k);
          await this.#o.secrets.put(ref, v);
          if (!existing) newSecrets.push(ref);
          env[k] = ref;
        }
        // Values of env names the new version dropped leave the vault after the commit.
        if (existing) {
          const kept = new Set(Object.values(env));
          for (const ref of await this.#o.secrets.list(`secret://mcp/${id}/env/`))
            if (!kept.has(ref)) staleSecrets.push(ref);
        }
        rows.push({
          id,
          accountId,
          name,
          transport: c.transport,
          command: c.transport === 'stdio' ? command : null,
          argsJson: JSON.stringify((c.args ?? []).map(expand)),
          url: c.transport === 'stdio' ? null : (c.url ?? null),
          envRefJson: JSON.stringify(env),
          configJson: JSON.stringify({
            startupTimeoutMs: c.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
            toolTimeoutMs: c.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
            enabledTools: c.enabledTools ?? null,
            disabledTools: c.disabledTools ?? [],
            defaultApproval: c.defaultApproval ?? null,
            ...(c.required !== undefined ? { required: c.required } : {}),
            ...(c.deferred !== undefined ? { deferred: c.deferred } : {}),
            ...(c.policy ? { policy: c.policy } : {}),
            pluginServerKey: s.key,
            pluginServerEnabled: c.enabled ?? true,
          }),
          source: 'plugin',
          pluginId,
          deviceId: null,
          bundleManifestJson: null,
          signatureStatus: null,
          bundleSha256: null,
          installRecordJson: null,
          enabled: enable && (c.enabled ?? true),
          lastStatus: existing?.lastStatus ?? null,
          lastError: existing?.lastError ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      }
    } catch (err) {
      for (const ref of newSecrets) await this.#o.secrets.delete(ref).catch(() => undefined);
      throw err;
    }
    return { rows, removed: mine.filter((r) => !keep.has(r.id)), newSecrets, staleSecrets };
  }

  // ---- enable, disable, uninstall -----------------------------------------------------------

  setEnabled(accountId: string, pluginId: string, enabled: boolean): Promise<PluginView> {
    return this.#serial(() => this.#setEnabled(accountId, pluginId, enabled));
  }

  async #setEnabled(accountId: string, pluginId: string, enabled: boolean): Promise<PluginView> {
    const row = await this.#row(accountId, pluginId);
    const now = this.#now().toISOString();
    const servers = await this.#servers(accountId, pluginId);
    const next = servers.map((s) => ({
      ...s,
      enabled: enabled && serverWanted(s),
      updatedAt: now,
    }));
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(pluginInstall)
        .set({ enabled, updatedAt: now })
        .where(eq(pluginInstall.id, row.id));
      for (const s of next)
        await this.#db.orm
          .update(mcpServer)
          .set({ enabled: s.enabled, updatedAt: now })
          .where(eq(mcpServer.id, s.id));
    });
    // Disabling waits for the servers to stop; enabling connects in the background.
    for (const s of next) {
      if (enabled) this.#applyServer(s);
      else
        await this.#o.servers
          ?.apply(s)
          .catch((err: unknown) => this.#log.warn('server stop failed', { err }));
    }
    if (row.enabled !== enabled) {
      await this.#o.events?.emit({
        name: 'plugin.updated',
        actor: 'user',
        accountId,
        payload: { pluginId, version: row.version },
      });
      await this.#record(accountId, enabled ? 'plugin.enable' : 'plugin.disable', pluginId, {
        version: row.version,
      });
      await this.#notify({
        accountId,
        pluginId,
        change: enabled ? 'enabled' : 'disabled',
        trust: [],
      });
    }
    return this.#view({ ...row, enabled, updatedAt: now });
  }

  /** Remove everything the plugin added: servers and their secrets, roles, skill state, files. */
  uninstall(accountId: string, pluginId: string): Promise<void> {
    return this.#serial(() => this.#uninstall(accountId, pluginId));
  }

  async #uninstall(accountId: string, pluginId: string): Promise<void> {
    const row = await this.#row(accountId, pluginId);
    const servers = await this.#servers(accountId, pluginId);
    for (const s of servers) await this.#stopServer(s.id);
    await this.#db.transaction(async () => {
      if (servers.length)
        await this.#db.orm.delete(mcpServer).where(
          inArray(
            mcpServer.id,
            servers.map((s) => s.id),
          ),
        );
      await this.#db.orm
        .delete(agentRole)
        .where(and(eq(agentRole.accountId, accountId), eq(agentRole.pluginId, pluginId)));
      await this.#db.orm.delete(pluginInstall).where(eq(pluginInstall.id, row.id));
    });
    for (const s of servers) await this.#deleteServerSecrets(s.id);
    await this.#o.skills?.forgetPlugin(accountId, pluginId);
    const others = await this.#db.orm
      .select({ id: pluginInstall.id })
      .from(pluginInstall)
      .where(eq(pluginInstall.pluginId, pluginId));
    if (!others.length) rmSync(join(this.pluginsDir, pluginId), { recursive: true, force: true });
    await this.#o.events?.emit({
      name: 'plugin.removed',
      actor: 'user',
      accountId,
      payload: { pluginId, version: row.version },
    });
    await this.#record(accountId, 'plugin.uninstall', pluginId, {
      version: row.version,
      servers: servers.map((s) => s.name),
    });
    await this.#notify({ accountId, pluginId, change: 'removed', trust: [] });
  }

  // ---- permissions (FR-045, FR-048) ---------------------------------------------------------

  /**
   * The confirmed permissions of the plugin that owns a tool: by `pluginId`, or by the MCP server
   * it installed (`serverId`). The tool's own entry is also keyed by its canonical name, so the
   * gate can read `tools[tool.name]` whichever form the manifest used.
   */
  async forTool(accountId: string, tool: ToolDescriptor): Promise<PluginPermissions | null> {
    let pluginId = tool.pluginId ?? null;
    if (!pluginId && tool.serverId) {
      const [s] = await this.#db.orm
        .select({ pluginId: mcpServer.pluginId, source: mcpServer.source })
        .from(mcpServer)
        .where(and(eq(mcpServer.id, tool.serverId), eq(mcpServer.accountId, accountId)));
      if (s?.source === 'plugin') pluginId = s.pluginId;
    }
    if (!pluginId) return null;
    const [row] = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.pluginId, pluginId)));
    if (!row) return null;
    const perms = manifestOf(row).permissions;
    const tools: PluginPermissions['tools'] = { ...(perms.tools ?? {}) };
    if (!tools[tool.name]) {
      const own = toolSegment(tool.name, pluginId);
      const match = Object.entries(perms.tools ?? {}).find(
        ([k]) => k === own || toolSegment(k, pluginId) === own,
      );
      if (match) tools[tool.name] = match[1];
    }
    return {
      pluginId,
      network: perms.network ?? [],
      fs: perms.fs ?? [],
      tools,
      actionDefaults: perms.actionDefaults ?? {},
      hooksAnswerAsks: perms.hooks?.answersAsks === true,
    };
  }

  // ---- hooks handover (FR-197) --------------------------------------------------------------

  async #hookDefinitions(accountId: string): Promise<PluginHookDefinition[]> {
    const rows = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(eq(pluginInstall.accountId, accountId));
    const out: PluginHookDefinition[] = [];
    for (const r of rows.sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1))) {
      const m = manifestOf(r);
      let hooks;
      try {
        // Re-read from disk: an edited hook file or script gets a new hash and needs trust again.
        hooks = loadPluginHooks(r.installPath, m);
      } catch (err) {
        this.#log.warn('plugin hooks unreadable', {
          pluginId: r.pluginId,
          err: err instanceof Error ? err.message : err,
        });
        continue;
      }
      for (const h of hooks)
        out.push({
          id: pluginHookId(r.pluginId, h.hook.id),
          pluginId: r.pluginId,
          hook: h.hook,
          contentHash: h.contentHash,
          root: r.installPath,
          pluginEnabled: r.enabled,
          answersAsks: m.permissions.hooks?.answersAsks === true,
          network: m.permissions.network ?? [],
        });
    }
    return out;
  }

  async #notify(change: PluginHookChange): Promise<void> {
    for (const l of this.#listeners) {
      try {
        await l(change);
      } catch (err) {
        this.#log.warn('plugin change listener failed', { err });
      }
    }
  }

  // ---- helpers --------------------------------------------------------------------------------

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #servers(accountId: string, pluginId: string): Promise<PluginServerRow[]> {
    return this.#db.orm
      .select()
      .from(mcpServer)
      .where(
        and(
          eq(mcpServer.accountId, accountId),
          eq(mcpServer.source, 'plugin'),
          eq(mcpServer.pluginId, pluginId),
        ),
      );
  }

  #applyServer(row: PluginServerRow): void {
    this.#o.servers?.apply(row).catch((err: unknown) => {
      this.#log.warn('plugin server update failed', { serverId: row.id, err });
    });
  }

  async #stopServer(id: string): Promise<void> {
    try {
      await this.#o.servers?.remove(id);
    } catch (err) {
      this.#log.warn('plugin server stop failed', { serverId: id, err });
    }
  }

  async #deleteServerSecrets(id: string): Promise<void> {
    for (const ref of await this.#o.secrets.list(`secret://mcp/${id}/`))
      await this.#o.secrets.delete(ref);
  }

  async #removeFolderIfUnused(path: string): Promise<void> {
    const users = await this.#db.orm
      .select({ id: pluginInstall.id })
      .from(pluginInstall)
      .where(eq(pluginInstall.installPath, path));
    if (!users.length) rmSync(path, { recursive: true, force: true });
  }

  /** Leftover staging and backup folders from an interrupted install. */
  #sweepStale(pluginDir: string, keep: string): void {
    try {
      for (const n of readdirSync(pluginDir))
        if (
          (n.startsWith('.staging-') || n.startsWith('.previous-')) &&
          join(pluginDir, n) !== keep
        )
          rmSync(join(pluginDir, n), { recursive: true, force: true });
    } catch {
      // nothing to sweep
    }
  }

  async #record(
    accountId: string,
    action: string,
    pluginId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      // Plugin changes are configuration changes (docs/12 §11).
      kind: 'settings',
      action,
      resource: `plugin:${pluginId}`,
      detail,
    });
  }
}

function registrationsOrEmpty(row: InstallRow | undefined): PluginRegistrations {
  return row
    ? registrationsOf(row)
    : {
        servers: {},
        skills: [],
        roles: [],
        hooks: [],
        trustedHooks: [],
        uiEntryPoints: 0,
        digest: '',
      };
}

function serverConfig(row: PluginServerRow): Record<string, unknown> {
  try {
    return JSON.parse(row.configJson ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function serverKeyOf(row: PluginServerRow): string {
  const k = serverConfig(row).pluginServerKey;
  return typeof k === 'string' ? k : row.name;
}

/** The manifest's own `enabled: false` keeps a server off while its plugin is enabled. */
function serverWanted(row: PluginServerRow): boolean {
  return serverConfig(row).pluginServerEnabled !== false;
}
