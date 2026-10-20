// What the marketplace installs, kind by kind (FR-049; docs/14 §2.2, §2.3, §5; docs/08 §3-§4).
// Each installer reads a staged artifact (`inspect`: what it is and what it may do), says what is
// installed now under an id from any source (`installed`, so an update shows a diff even for a
// plugin installed from a folder), captures what an install would replace (`snapshot`, whose
// function puts it back when an install fails), installs and removes. Plugins go through the
// plugin installer (FR-045), skills into the user's skills as imports (FR-046), themes into
// `appearance.customThemes` (FR-011), pets into `<dataDir>/market/pets` (FR-012); MCP servers come
// from the Hub's MCP area through the same interface.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { contracts, type Validator } from '@nova/contracts';
import {
  NovaError,
  SAFE_THEME_VALUE,
  uuidv7,
  type MarketItemKind,
  type MarketPermissionLine,
  type ExtensionPermissionLine,
  type MarketPetView,
  type MarketPreview,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { loadPluginFolder, PLUGIN_MANIFEST_PATH } from '../plugins/manifest.ts';
import { isExtensionFolder } from '../sdk/manifest.ts';
import type { ExtensionService } from '../sdk/service.ts';
import { copyTree, listFiles, realInside, walkTree } from '../plugins/paths.ts';
import { pluginHookId, type PluginService } from '../plugins/service.ts';
import { readSkillFolder } from '../plugins/skill-file.ts';
import type { SkillIndex } from '../plugins/skills.ts';
import type { PluginManifest } from '../plugins/types.ts';
import type { ArtifactFormat, MarketIndexEntry } from './catalog-index.ts';
import { pluginPermissionLines, skillPermissionLines } from './permissions.ts';

const { pluginInstall } = schema;

/**
 * An artifact after staging: a folder in the Hub's own staging area, file bytes, or a server. A
 * `.novax` has both: its unpacked folder and its signed bytes.
 */
export interface StagedArtifact {
  format: ArtifactFormat;
  dir: string | null;
  bytes: Uint8Array | null;
  server: { transport: 'http' | 'sse'; url: string } | null;
}

export interface MarketInspection {
  /** The id the artifact itself declares; it must be the catalog entry's. */
  id: string;
  /** The version it declares, when the format has one. */
  version: string | null;
  name: string | null;
  permissions: MarketPermissionLine[];
  details: Record<string, unknown>;
  warnings: string[];
  /** Kept with the preview and handed back at install (the plugin installer's preview id). */
  handle?: string;
  /** An extension update by another publisher (or none), from the extension installer. */
  publisherChange?: MarketPreview['publisherChange'];
}

export interface MarketInstalledState {
  version: string | null;
  permissions: MarketPermissionLine[];
}

export interface MarketInstallRequest {
  accountId: string;
  entry: MarketIndexEntry;
  artifact: StagedArtifact;
  inspection: MarketInspection;
  verified: boolean;
  /** The key that vouched for it (the bundle's or the catalog's), for the audit. */
  publisher: string | null;
  catalogId: string;
  /** `<catalogId>/<id>@<version>[#commit]`. */
  origin: string;
  enable: boolean;
  trustHooks?: { id: string; contentHash: string }[];
  userConfig?: Record<string, unknown>;
  /** The owner accepted the preview's change of publisher. */
  acceptPublisherChange?: boolean;
}

export interface MarketInstaller {
  readonly kind: MarketItemKind;
  inspect(
    accountId: string,
    artifact: StagedArtifact,
    entry: MarketIndexEntry,
  ): Promise<MarketInspection>;
  /** What is installed under `id` now, from any source; null when nothing is. */
  installed(accountId: string, id: string): Promise<MarketInstalledState | null>;
  /** Ids installed now with their versions (null when the kind keeps none), for listings. */
  list(accountId: string): Promise<Map<string, string | null>>;
  /** Capture what an install of `id` would replace; the function puts it back. */
  snapshot(accountId: string, id: string): Promise<() => Promise<void>>;
  install(req: MarketInstallRequest): Promise<void>;
  remove(accountId: string, id: string): Promise<void>;
}

function needDir(a: StagedArtifact, what: string): string {
  if (!a.dir) throw new NovaError('validation', `${what} must be a folder or a zip archive`);
  return a.dir;
}

function needBytes(a: StagedArtifact, what: string): Uint8Array {
  if (!a.bytes) throw new NovaError('validation', `${what} must be a file`);
  return a.bytes;
}

/** Copy a folder to a fresh backup path under `backupsDir`, skipping `skip(rel)` entries. */
function backup(
  src: string,
  backupsDir: string,
  skip: (rel: string) => boolean = () => false,
): string {
  const to = join(backupsDir, uuidv7());
  copyTree(
    walkTree(src).filter((e) => !skip(e.path)),
    to,
  );
  return to;
}

// ---- plugins ----------------------------------------------------------------------------------

/** A plugin's permission lines from its manifest and hooks (installed or staged). */
export function pluginLines(
  m: PluginManifest,
  hooks: { id: string; event: string; command: string | null }[],
  roles: string[],
): MarketPermissionLine[] {
  return pluginPermissionLines({
    permissions: m.permissions,
    mcpServers: m.mcpServers ?? {},
    hooks,
    roles,
    browserExtensions: (m.browserExtensions ?? []).map((b) => b.id),
    uiEntryPoints: (m.ui?.entryPoints ?? []).map((e) => ({
      kind: e.kind,
      resource: e.resource,
      title: e.title ?? null,
    })),
  });
}

export interface PluginInstallerOptions {
  service: PluginService;
  db: NovaDatabase;
  backupsDir: string;
  novaVersion?: string;
}

/** The extension installer (the SDK area's service): extensions install through it (FR-117). */
export type ExtensionInstaller = Pick<
  ExtensionService,
  'preview' | 'install' | 'get' | 'uninstall' | 'snapshot'
>;

/** The line kinds the marketplace knows; another kind an installer sends counts as `plugin`. */
// Every kind, listed once: adding one to the union without listing it here fails to compile.
const KNOWN_KINDS: Record<MarketPermissionLine['kind'], true> = {
  network: true,
  fs: true,
  secret: true,
  tool: true,
  action_default: true,
  hooks_answer_asks: true,
  browser_extension: true,
  ui_domain: true,
  ui_entry: true,
  hook: true,
  role: true,
  mcp_server: true,
  program: true,
  skill_tools: true,
  command: true,
  panel: true,
  event: true,
  plugin: true,
};
const LINE_KINDS = new Set<string>(Object.keys(KNOWN_KINDS));

/** Every kind the extension installer sends is a marketplace kind (checked when compiling). */
type ExtensionKindsFit = ExtensionPermissionLine['kind'] extends MarketPermissionLine['kind']
  ? true
  : never;
export const EXTENSION_KINDS_FIT: ExtensionKindsFit = true;

/**
 * The extension installer's lines as marketplace lines. The detail is what the diff compares
 * under one key: the installer's own `detail` when it gives one, else the line's wording and
 * whether it is sensitive, so a tool that goes from read to execute, or a default from ask to
 * allow, under the same key still shows as a change that needs accepting.
 */
export function extensionLines(
  lines: readonly {
    key: string;
    kind: string;
    text: string;
    sensitive?: boolean;
    detail?: string | null;
  }[],
): MarketPermissionLine[] {
  return lines.map((l) => ({
    key: l.key,
    kind: LINE_KINDS.has(l.kind) ? (l.kind as MarketPermissionLine['kind']) : 'plugin',
    text: l.text,
    detail: l.detail ?? `${l.text}${l.sensitive ? ' (sensitive)' : ''}`,
  }));
}

/**
 * Plugins (FR-045) through the plugin installer: its preview validates the staged folder and
 * holds its digest, so what installs is what was checked. The marketplace has already decided
 * verification and the sideload confirmation; the install hands the verdict, the source and the
 * origin over as the plugin installer's provenance, so the row, its audit entry and managed
 * policy (which refuses unverified installs when it says so) all see the same verdict.
 *
 * An extension (a plugin with `.nova-plugin/extension.json`, FR-117) goes through the extension
 * installer once it is wired (`useExtensions`): it checks the bundle's signature itself, records
 * the publisher and runs the extension. Its permission lines are the extension installer's.
 */
export class PluginMarketInstaller implements MarketInstaller {
  readonly kind = 'plugin' as const;
  readonly #o: PluginInstallerOptions;
  #ext: ExtensionInstaller | null = null;

  constructor(opts: PluginInstallerOptions) {
    this.#o = opts;
  }

  /** Wire the extension installer (the SDK area's service); null installs extensions as plugins. */
  useExtensions(ext: ExtensionInstaller | null): void {
    this.#ext = ext;
  }

  async #extension(accountId: string, id: string) {
    if (!this.#ext) return null;
    try {
      return await this.#ext.get(accountId, id);
    } catch (err) {
      if (err instanceof NovaError && err.code === 'not_found') return null;
      throw err;
    }
  }

  async #inspectExtension(
    ext: ExtensionInstaller,
    accountId: string,
    artifact: StagedArtifact,
    entry: MarketIndexEntry,
  ): Promise<MarketInspection> {
    // A bundle is checked from its signed bytes; a folder is read as it is (and is unsigned).
    const source = artifact.bytes
      ? {
          kind: 'upload' as const,
          bundle: Buffer.from(artifact.bytes).toString('base64'),
          fileName: `${entry.id}-${entry.version}.novax`,
        }
      : { kind: 'path' as const, path: needDir(artifact, 'an extension') };
    const p = await ext.preview(accountId, source);
    return {
      id: p.id,
      version: p.version,
      name: p.name,
      permissions: extensionLines(p.permissions),
      details: {
        extension: {
          api: p.api,
          verified: p.verified,
          publisher: p.publisher,
          digest: p.digest,
        },
        hooks: p.hooks,
        pluginHooks: p.pluginHooks,
      },
      // The extension installer's own Unverified note is replaced by the marketplace's verdict.
      warnings: p.warnings.filter((w) => !w.startsWith('Unverified:')),
      handle: p.previewId,
      publisherChange: p.publisherChange ?? null,
    };
  }

  async inspect(
    accountId: string,
    artifact: StagedArtifact,
    entry: MarketIndexEntry,
  ): Promise<MarketInspection> {
    const dir = needDir(artifact, 'a plugin');
    if (this.#ext && isExtensionFolder(dir))
      return this.#inspectExtension(this.#ext, accountId, artifact, entry);
    const loaded = loadPluginFolder(
      dir,
      this.#o.novaVersion ? { novaVersion: this.#o.novaVersion } : {},
    );
    const preview = await this.#o.service.preview(accountId, { kind: 'path', path: dir });
    const m = loaded.manifest;
    const hooks = loaded.hooks.map((h) => ({
      id: pluginHookId(m.id, h.hook.id),
      event: h.hook.event,
      command: hookCommand(h.hook.handler),
    }));
    return {
      id: m.id,
      version: m.version,
      name: m.name,
      permissions: pluginLines(
        m,
        hooks,
        loaded.roles.map((r) => r.key),
      ),
      details: {
        hooks: preview.hooks,
        mcpServers: preview.mcpServers,
        skills: preview.skills,
        roles: loaded.roles.map((r) => r.key),
        uiEntryPoints: loaded.uiEntryPoints,
      },
      // The plugin installer's own Unverified note is replaced by the marketplace's verdict.
      warnings: preview.warnings.filter((w) => !w.startsWith('Unverified:')),
      handle: preview.previewId,
    };
  }

  async #row(accountId: string, id: string) {
    const [row] = await this.#o.db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.pluginId, id)));
    return row ?? null;
  }

  async installed(accountId: string, id: string): Promise<MarketInstalledState | null> {
    const ext = await this.#extension(accountId, id);
    if (ext) return { version: ext.version, permissions: extensionLines(ext.permissions) };
    const row = await this.#row(accountId, id);
    if (!row) return null;
    const m = JSON.parse(row.manifestJson) as PluginManifest;
    const reg = JSON.parse(row.registrationsJson) as { roles?: string[] };
    const hooks = (await this.#o.service.hooks.list(accountId))
      .filter((h) => h.pluginId === id)
      .map((h) => ({ id: h.id, event: h.hook.event, command: hookCommand(h.hook.handler) }));
    return { version: row.version, permissions: pluginLines(m, hooks, reg.roles ?? []) };
  }

  async list(accountId: string): Promise<Map<string, string | null>> {
    return new Map((await this.#o.service.list(accountId)).map((p) => [p.id, p.version]));
  }

  async snapshot(accountId: string, id: string): Promise<() => Promise<void>> {
    const row = await this.#row(accountId, id);
    if (!row) {
      // Nothing to put back but an uninstall of what a failed install left behind.
      return async () => {
        if (await this.#extension(accountId, id)) await this.#ext?.uninstall(accountId, id);
        else if (await this.#row(accountId, id)) await this.#o.service.uninstall(accountId, id);
      };
    }
    if (this.#ext && (await this.#extension(accountId, id))) {
      // The extension installer keeps the installed bundle's own bytes: a rollback checks its
      // signature again, so a verified extension comes back verified (ADR-097 D2).
      const restore = await this.#ext.snapshot(accountId, id);
      return async () => {
        const now = await this.#row(accountId, id);
        // The extension installer rolls back its own failures: only a row that moved on is put back.
        if (now && now.updatedAt === row.updatedAt && now.version === row.version) return;
        await restore?.();
      };
    }
    // Converted commands are written again at install, and a plugin may not ship that folder.
    const copy = backup(row.installPath, this.#o.backupsDir, (rel) =>
      rel.startsWith('.nova-plugin/commands/'),
    );
    return async () => {
      try {
        const now = await this.#row(accountId, id);
        // The plugin installer rolls back its own failures: put the copy back only when the
        // row moved on (the failure came after the plugin committed).
        if (now && now.updatedAt === row.updatedAt && now.version === row.version) return;
        const p = await this.#o.service.preview(accountId, { kind: 'path', path: copy });
        const verified = row.signature === 'verified';
        await this.#o.service.install(
          accountId,
          {
            previewId: p.previewId,
            enable: row.enabled,
            ...(verified ? {} : { confirmSideload: true }),
          },
          { verified, source: row.source, origin: row.origin, via: 'rollback' },
        );
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    };
  }

  async install(req: MarketInstallRequest): Promise<void> {
    if (!req.inspection.handle) throw new NovaError('request_expired', 'preview the plugin again');
    if ('extension' in req.inspection.details) {
      if (!this.#ext) throw new NovaError('capability_missing', 'extensions are not available');
      await this.#ext.install(
        req.accountId,
        {
          previewId: req.inspection.handle,
          enable: req.enable,
          // The owner confirmed the sideload in the marketplace when it is not verified.
          ...(req.verified ? {} : { confirmSideload: true }),
          ...(req.trustHooks ? { trustHooks: req.trustHooks } : {}),
          // The owner accepted another publisher (or none) in the marketplace preview.
          ...(req.acceptPublisherChange ? { acceptPublisherChange: true } : {}),
        },
        // Where it came from; the signature verdict stays the extension installer's.
        { source: 'catalog', origin: req.origin, via: req.catalogId },
      );
      return;
    }
    await this.#o.service.install(
      req.accountId,
      {
        previewId: req.inspection.handle,
        enable: req.enable,
        // An Unverified item reaches here only after the owner confirmed the sideload.
        ...(req.verified ? {} : { confirmSideload: true }),
        ...(req.trustHooks ? { trustHooks: req.trustHooks } : {}),
      },
      {
        verified: req.verified,
        publisher: req.publisher,
        source: 'catalog',
        origin: req.origin,
        via: req.catalogId,
      },
    );
  }

  async remove(accountId: string, id: string): Promise<void> {
    if (this.#ext && (await this.#extension(accountId, id)))
      await this.#ext.uninstall(accountId, id);
    else await this.#o.service.uninstall(accountId, id);
  }
}

function hookCommand(
  h: { type: 'command'; command: string[] } | { type: 'mcp_tool'; tool: string },
): string {
  return h.type === 'command' ? h.command.join(' ') : `MCP tool ${h.tool}`;
}

// ---- skills -----------------------------------------------------------------------------------

/**
 * Skills (FR-046): a skill folder copied into the user's skills as an import (`skill:import:<name>`),
 * with the marketplace origin as its provenance. An update replaces the folder.
 */
export class SkillMarketInstaller implements MarketInstaller {
  readonly kind = 'skill' as const;
  readonly #index: SkillIndex;
  readonly #userDir: string;
  readonly #backupsDir: string;

  constructor(opts: { index: SkillIndex; userDir: string; backupsDir: string }) {
    this.#index = opts.index;
    this.#userDir = opts.userDir;
    this.#backupsDir = opts.backupsDir;
  }

  inspect(_accountId: string, artifact: StagedArtifact): Promise<MarketInspection> {
    const dir = needDir(artifact, 'a skill');
    const parsed = readSkillFolder(dir);
    if (!parsed.ok) throw new NovaError('validation', `not a valid skill: ${parsed.error}`);
    const s = parsed.skill;
    return Promise.resolve({
      id: s.name,
      version: null,
      name: s.name,
      permissions: skillPermissionLines(s.allowedTools),
      details: {
        description: s.description,
        whenToUse: s.whenToUse,
        allowedTools: s.allowedTools,
        files: listFiles(dir),
      },
      warnings: s.warnings,
    });
  }

  async installed(accountId: string, id: string): Promise<MarketInstalledState | null> {
    try {
      const s = await this.#index.get(accountId, `skill:import:${id}`);
      return { version: null, permissions: skillPermissionLines(s.allowedTools) };
    } catch (err) {
      if (err instanceof NovaError && err.code === 'not_found') return null;
      throw err;
    }
  }

  async list(accountId: string): Promise<Map<string, string | null>> {
    return new Map(
      (await this.#index.views(accountId))
        .filter((s) => s.source === 'import')
        .map((s) => [s.name, null]),
    );
  }

  async snapshot(accountId: string, id: string): Promise<() => Promise<void>> {
    const had = (await this.installed(accountId, id)) !== null;
    const folder = join(this.#userDir, id);
    const copy = had && existsSync(folder) ? backup(folder, this.#backupsDir) : null;
    return async () => {
      try {
        if ((await this.installed(accountId, id)) !== null)
          await this.#index.delete(accountId, `skill:import:${id}`);
        if (copy) await this.#index.importFolder(accountId, copy, { name: id });
      } finally {
        if (copy) rmSync(copy, { recursive: true, force: true });
      }
    };
  }

  async install(req: MarketInstallRequest): Promise<void> {
    const dir = needDir(req.artifact, 'a skill');
    if ((await this.installed(req.accountId, req.entry.id)) !== null)
      await this.#index.delete(req.accountId, `skill:import:${req.entry.id}`);
    await this.#index.importFolder(req.accountId, dir, {
      name: req.entry.id,
      provenance: { market: req.origin, verified: req.verified, version: req.entry.version },
    });
  }

  async remove(accountId: string, id: string): Promise<void> {
    await this.#index.delete(accountId, `skill:import:${id}`);
  }
}

// ---- themes -----------------------------------------------------------------------------------

let themeValidator: Validator | null = null;
const THEME_MAX_BYTES = 64 * 1024;
const MAX_THEMES = 50;

export interface ThemeStore {
  /** `appearance.customThemes` now. */
  read(accountId: string): Promise<Record<string, unknown>[]>;
  /** Write `appearance.customThemes` the way the settings route does (a managed lock refuses). */
  write(accountId: string, themes: Record<string, unknown>[]): Promise<void>;
  /** `appearance.customTheme`: the id of the saved theme in use, or null. */
  inUse(accountId: string): Promise<string | null>;
  /** Set `appearance.customTheme` to null: no saved theme is in use. */
  clearInUse(accountId: string): Promise<void>;
}

/** Themes (FR-011): a theme file (contracts/schemas/theme.json) added to the saved themes. */
export class ThemeMarketInstaller implements MarketInstaller {
  readonly kind = 'theme' as const;
  readonly #store: ThemeStore;

  constructor(store: ThemeStore) {
    this.#store = store;
  }

  inspect(_accountId: string, artifact: StagedArtifact): Promise<MarketInspection> {
    const bytes = needBytes(artifact, 'a theme');
    if (bytes.byteLength > THEME_MAX_BYTES)
      throw new NovaError('validation', 'the theme file is larger than 64 KB');
    let theme: unknown;
    try {
      theme = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new NovaError('validation', 'the theme file is not valid JSON');
    }
    themeValidator ??= contracts().validator('theme.json');
    const v = themeValidator(theme);
    if (!v.ok)
      throw new NovaError(
        'validation',
        `theme.json: ${v.errors[0]?.instancePath || '/'} ${v.errors[0]?.message ?? 'invalid'}`,
      );
    const t = theme as {
      id: string;
      name: string;
      variant: string;
      tokens: Record<string, string>;
      fonts?: Record<string, string>;
    };
    for (const [k, val] of Object.entries({ ...t.tokens, ...t.fonts }))
      // The same rule as the Appearance settings and extension themes (one regex, in shared).
      if (!SAFE_THEME_VALUE.test(val))
        throw new NovaError('validation', `theme.json: the value of ${k} is not a plain CSS value`);
    return Promise.resolve({
      id: t.id,
      version: null,
      name: t.name,
      permissions: [],
      details: { theme: t },
      warnings: [],
    });
  }

  async installed(accountId: string, id: string): Promise<MarketInstalledState | null> {
    const found = (await this.#store.read(accountId)).some((t) => t.id === id);
    return found ? { version: null, permissions: [] } : null;
  }

  async list(accountId: string): Promise<Map<string, string | null>> {
    return new Map(
      (await this.#store.read(accountId))
        .filter((t) => typeof t.id === 'string')
        .map((t) => [t.id as string, null]),
    );
  }

  async snapshot(accountId: string): Promise<() => Promise<void>> {
    const before = await this.#store.read(accountId);
    return () => this.#store.write(accountId, before);
  }

  async install(req: MarketInstallRequest): Promise<void> {
    const theme = (req.inspection.details as { theme: Record<string, unknown> }).theme;
    const themes = (await this.#store.read(req.accountId)).filter((t) => t.id !== req.entry.id);
    if (themes.length >= MAX_THEMES)
      throw new NovaError('validation', `you have ${MAX_THEMES} saved themes; remove one first`);
    await this.#store.write(req.accountId, [...themes, theme]);
  }

  async remove(accountId: string, id: string): Promise<void> {
    const themes = await this.#store.read(accountId);
    if (!themes.some((t) => t.id === id)) throw new NovaError('not_found', 'theme not installed');
    // A removed theme stops being the one in use first, so installing it again later does not
    // quietly bring it back into use.
    if ((await this.#store.inUse(accountId)) === id) await this.#store.clearInUse(accountId);
    await this.#store.write(
      accountId,
      themes.filter((t) => t.id !== id),
    );
  }
}

// ---- pets -------------------------------------------------------------------------------------

export const PET_STATES = ['idle', 'thinking', 'working', 'success', 'error', 'waiting'] as const;
const PET_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const FRAME_TYPES = new Set(['.webp', '.png', '.apng']);
const FRAME_MAX_BYTES = 1024 * 1024;
const PET_MAX_BYTES = 8 * 1024 * 1024;

const petSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(PET_ID),
  name: z.string().min(1).max(100),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    .optional(),
  states: z
    .partialRecord(
      z.enum(PET_STATES),
      z.object({
        frames: z.array(z.string().min(1).max(200)).min(1).max(64),
        fps: z.number().int().min(1).max(30).default(8),
        loop: z.boolean().default(true),
      }),
    )
    .refine((s) => s.idle !== undefined, 'a pet needs an idle state'),
});

/** Read and check a pet folder (docs/14 §2.3): `pet.json` and WebP/PNG/APNG frames inside it. */
export function readPetFolder(dir: string): MarketPetView {
  const file = join(dir, 'pet.json');
  if (!existsSync(file)) throw new NovaError('validation', 'the pet has no pet.json');
  if (statSync(file).size > 64 * 1024) throw new NovaError('validation', 'pet.json is too large');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new NovaError('validation', 'pet.json is not valid JSON');
  }
  const r = petSchema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new NovaError(
      'validation',
      `pet.json: ${i?.path.join('.') || '/'} ${i?.message ?? 'invalid'}`,
    );
  }
  let total = 0;
  const states: MarketPetView['states'] = {};
  for (const [state, s] of Object.entries(r.data.states)) {
    if (!s) continue;
    for (const f of s.frames) {
      if (!FRAME_TYPES.has(extname(f).toLowerCase()))
        throw new NovaError('validation', `pet frame ${f} must be WebP, PNG or APNG`);
      const st = statSync(realInside(dir, f, 'pet frame'));
      if (!st.isFile() || st.size > FRAME_MAX_BYTES)
        throw new NovaError('validation', `pet frame ${f} is missing or larger than 1 MB`);
      total += st.size;
    }
    states[state] = { frames: s.frames, fps: s.fps, loop: s.loop };
  }
  if (total > PET_MAX_BYTES) throw new NovaError('validation', 'the pet is larger than 8 MB');
  return { id: r.data.id, name: r.data.name, version: r.data.version ?? '0.0.0', states };
}

/**
 * Pets (FR-012): a pet folder placed in `<dataDir>/market/pets/<id>` (swapped in atomically).
 * Picking an installed pet is the Appearance setting's (wave 2 extends `appearance.pet`).
 */
export class PetMarketInstaller implements MarketInstaller {
  readonly kind = 'pet' as const;
  readonly #dir: string;
  readonly #backupsDir: string;

  constructor(opts: { dir: string; backupsDir: string }) {
    this.#dir = opts.dir;
    this.#backupsDir = opts.backupsDir;
  }

  /** Installed pets, for the API and the Appearance page. */
  pets(): MarketPetView[] {
    if (!existsSync(this.#dir)) return [];
    const out: MarketPetView[] = [];
    for (const name of readdirSync(this.#dir).sort()) {
      if (name.startsWith('.')) continue;
      try {
        out.push(readPetFolder(join(this.#dir, name)));
      } catch {
        // A damaged pet folder is left out.
      }
    }
    return out;
  }

  /** The folder of an installed pet (its frames are served from there). */
  folder(id: string): string {
    if (!PET_ID.test(id)) throw new NovaError('validation', 'invalid pet id');
    const dir = join(this.#dir, id);
    if (!existsSync(dir)) throw new NovaError('not_found', 'pet not installed');
    return dir;
  }

  inspect(_accountId: string, artifact: StagedArtifact): Promise<MarketInspection> {
    const pet = readPetFolder(needDir(artifact, 'a pet'));
    return Promise.resolve({
      id: pet.id,
      version: pet.version === '0.0.0' ? null : pet.version,
      name: pet.name,
      permissions: [],
      details: { states: Object.keys(pet.states) },
      warnings: [],
    });
  }

  installed(_accountId: string, id: string): Promise<MarketInstalledState | null> {
    const dir = join(this.#dir, id);
    if (!PET_ID.test(id) || !existsSync(dir)) return Promise.resolve(null);
    let version: string | null;
    try {
      version = readPetFolder(dir).version;
    } catch {
      version = null;
    }
    return Promise.resolve({ version: version === '0.0.0' ? null : version, permissions: [] });
  }

  list(): Promise<Map<string, string | null>> {
    return Promise.resolve(
      new Map(this.pets().map((p) => [p.id, p.version === '0.0.0' ? null : p.version])),
    );
  }

  snapshot(_accountId: string, id: string): Promise<() => Promise<void>> {
    const dir = join(this.#dir, id);
    const copy = existsSync(dir) ? backup(dir, this.#backupsDir) : null;
    return Promise.resolve(() => {
      rmSync(dir, { recursive: true, force: true });
      if (copy) {
        mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
        renameSync(copy, dir);
      }
      return Promise.resolve();
    });
  }

  install(req: MarketInstallRequest): Promise<void> {
    const src = needDir(req.artifact, 'a pet');
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const dir = join(this.#dir, req.entry.id);
    const staging = join(this.#dir, `.staging-${uuidv7()}`);
    const previous = join(this.#dir, `.previous-${uuidv7()}`);
    cpSync(src, staging, { recursive: true });
    const had = existsSync(dir);
    if (had) renameSync(dir, previous);
    try {
      renameSync(staging, dir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      if (had) renameSync(previous, dir);
      throw err;
    }
    if (had) rmSync(previous, { recursive: true, force: true });
    return Promise.resolve();
  }

  remove(_accountId: string, id: string): Promise<void> {
    rmSync(this.folder(id), { recursive: true, force: true });
    return Promise.resolve();
  }
}

/** The manifest path inside a plugin folder (the stager finds the plugin root by it). */
export const PLUGIN_MARKER = PLUGIN_MANIFEST_PATH;
