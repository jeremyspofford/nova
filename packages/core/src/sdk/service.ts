// Extensions (FR-117; docs/14 §4-§5, docs/26 §3; ADR-097 D1-D3): install a `.novax` bundle (or a
// folder on the Hub), verify its signature, show what it may do, and run it. An extension is a
// plugin: the plugin installer places its folder and registers its skills, roles, MCP servers and
// hooks; this service adds the SDK part: the signature record, the worker that runs its code
// (host.ts), the SDK hooks (trusted by a hash over their definition and the bundle digest), its
// tools as `ext:<id>/<name>`, its panels for the MCP Apps area and its secrets.
//
// A bundle whose signature does not match its contents is refused. One that is unsigned or signed
// by a key the owner has not trusted installs only with the explicit sideload confirmation and
// stays Unverified; managed policy may refuse it outright. `nova dev` reloads a local extension in
// one request (always unverified). Undeclared access turns the extension off and tells the owner.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  EXTENSION_BUNDLE_MAX_BYTES,
  NovaError,
  uuidv7,
  type DevExtensionRequest,
  type ExtensionCommandResult,
  type ExtensionContributionsView,
  type ExtensionHookView,
  type ExtensionPreviewView,
  type ExtensionPublisherView,
  type ExtensionSignature,
  type ExtensionSource,
  type ExtensionStatus,
  type ExtensionView,
  type InstallExtensionRequest,
  type PluginPreview,
  type PluginSource,
  type ToolDescriptor,
  type TrustedPublisher,
} from '@nova/shared';
import { isWithin } from '@nova/security';
import { secretRef, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { PluginPermissionSource, PluginPermissions } from '../extensions/types.ts';
import { hookRef, hookStatus, type DiscoveredHook, type HookStore } from '../hooks/store.ts';
import type { HookMcpClient } from '../hooks/handlers.ts';
import { ManagedRestrictions, NO_RESTRICTIONS, managedDenied } from '../managed/restrictions.ts';
import type { PluginHookChange, PluginService } from '../plugins/service.ts';
import type { PluginManifest } from '../plugins/types.ts';
import type {
  AuditSink,
  Notifier,
  ToolDefinition,
  ToolGate,
  ToolResult,
  ToolSourceProvider,
} from '../tools/types.ts';
import {
  EXTENSION_MANIFEST_PATH,
  checkFiles,
  extractBundle,
  folderBundleFiles,
  packBundle,
  verifyBundle,
  type BundleCheck,
} from './bundle.ts';
import { extensionPermissionLines, extensionPermissionDiff } from './describe.ts';
import {
  ExtensionHost,
  toToolResult,
  type ExtensionEgress,
  type ExtensionHostOptions,
  type ExtensionSpec,
} from './host.ts';
import { publisherFingerprint } from './keys.ts';
import {
  extensionHookDefinition,
  extensionHookHash,
  extensionHookTool,
  extensionToolName,
  fsScopes,
  isExtensionFolder,
  loadExtensionFolder,
  parseExtensionManifest,
  parseExtensionToolName,
  readPanelHtml,
  type ExtensionManifest,
  type ExtensionPanel,
  type LoadedExtension,
} from './manifest.ts';

const { extensionInstall, pluginInstall } = schema;
type Row = typeof extensionInstall.$inferSelect;

/** Previews expire after 30 minutes, like plugin previews. */
export const EXTENSION_PREVIEW_TTL_MS = 30 * 60_000;
const MAX_PREVIEWS = 20;
const COMMAND_ARGS_MAX = 64 * 1024;
/** The plugin installer's own Unverified note: this service gives its own verdict instead. */
const PLUGIN_UNVERIFIED = 'Unverified:';

export interface ExtensionSettings {
  /** `sdk.enabled`: extensions run at all. */
  enabled(): Promise<boolean>;
  /** `plugins.trustedPublishers`. */
  trustedPublishers(): Promise<TrustedPublisher[]>;
  /** `network.egressMode` and `network.egressDeny` (managed values included); none: no ceiling. */
  egress?(): Promise<{ mode: 'off' | 'limited' | 'allowlist'; deny: string[] }>;
}

/** Managed policy's say on an install (D4: `unverifiedInstalls`, `extensions`); null allows it. */
export interface ExtensionInstallPolicy {
  installProblem(input: {
    accountId: string;
    extensionId: string;
    verified: boolean;
    publisherKey: string | null;
  }): Promise<string | null>;
}

/** One panel a running extension registered, for the MCP Apps area (FR-198, docs/14 §4.2). */
export interface ExtensionUi {
  extensionId: string;
  entryPoints: {
    kind: 'global' | 'thread' | 'file';
    resource: string;
    title?: string;
    extensions?: string[];
  }[];
  network: string[];
  domains: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] };
  read(uri: string): Promise<{ ok: true; html: string } | { ok: false; message: string }>;
}

export interface ExtensionServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  dataDir: string;
  plugins: PluginService;
  settings: ExtensionSettings;
  events?: EventSink;
  audit?: AuditSink;
  notifier?: Notifier;
  log?: Logger;
  /** The hooks area's store: SDK hooks are rows with source `extension` (FR-197). */
  hookStore?: HookStore | null;
  policy?: ExtensionInstallPolicy | null;
  /** Managed policy's restrictions (D4): refused extensions do not install, start or run. */
  managed?: (() => Promise<ManagedRestrictions>) | null;
  /** Keys trusted by Nova itself (the built-in sample catalog's publisher). */
  builtinPublishers?: TrustedPublisher[];
  /** Runtime options (tests: fetch, limits, timeouts). */
  host?: Partial<Omit<ExtensionHostOptions, 'secrets' | 'hubDataDir'>>;
  novaVersion?: string;
  previewTtlMs?: number;
  now?: () => Date;
}

/**
 * Where an install came from, for its plugin row and audit entry (the marketplace passes its
 * catalog and origin). The signature verdict is never part of it: this service checks the bundle.
 */
export interface ExtensionProvenance {
  source?: PluginSource;
  origin?: string;
  /** Recorded in the audit: a catalog id, `rollback`, … */
  via?: string;
}

/** What a rollback puts back: the previous bundle's own bytes and how it was installed. */
interface InstalledState {
  bytes: Uint8Array;
  enabled: boolean;
  dev: boolean;
  source: PluginSource;
  origin: string;
  /** Hooks (SDK and plugin) trusted at the time, at their hashes. */
  trust: { id: string; contentHash: string }[];
}

interface PreviewRecord {
  id: string;
  accountId: string;
  staging: string;
  origin: string;
  dev: boolean;
  /** The bundle as received (a folder packed as an unsigned bundle), kept once it installs. */
  bytes: Uint8Array;
  provenance: ExtensionProvenance;
  check: Omit<BundleCheck, 'files'>;
  loaded: LoadedExtension;
  plugin: PluginPreview;
  expiresAt: number;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class ExtensionService {
  readonly host: ExtensionHost;
  readonly #o: ExtensionServiceOptions;
  readonly #db: NovaDatabase;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #previews = new Map<string, PreviewRecord>();
  /** Extensions this service is changing: plugin change notices about them are its own. */
  readonly #busy = new Set<string>();
  readonly #pendingNotices = new Map<string, ReturnType<typeof setImmediate>>();
  #hooks: HookStore | null;
  #managed: (() => Promise<ManagedRestrictions>) | null;
  #policy: ExtensionInstallPolicy | null;
  #notifier: Notifier | null;
  #chain: Promise<unknown> = Promise.resolve();
  #unlisten: () => void;
  #closed = false;

  constructor(opts: ExtensionServiceOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#log = opts.log ?? new Logger({ module: 'core.sdk', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#hooks = opts.hookStore ?? null;
    this.#policy = opts.policy ?? null;
    this.#notifier = opts.notifier ?? null;
    this.host = new ExtensionHost({
      ...opts.host,
      secrets: opts.secrets,
      hubDataDir: opts.dataDir,
      ...(opts.audit ? { audit: opts.audit } : {}),
      ...(opts.events ? { events: opts.events } : {}),
      log: this.#log,
      onViolation: (accountId, extensionId, what) => this.#violation(accountId, extensionId, what),
      onChange: (accountId, extensionId) => this.#contributionsChanged(accountId, extensionId),
      egress: () => this.#egress(),
    });
    this.#managed = opts.managed ?? null;
    this.#unlisten = opts.plugins.hooks.onChange((c) => this.#onPluginChange(c));
  }

  /** Wire the hooks area's store (SDK hooks become rows with source `extension`). */
  useHookStore(store: HookStore | null): void {
    this.#hooks = store;
  }

  /** Wire managed policy's restrictions (D4); `reapplyPolicy` after a change. */
  useManaged(managed: (() => Promise<ManagedRestrictions>) | null): void {
    this.#managed = managed;
  }

  /** The restrictions now; a reader that fails is a policy that fails closed. */
  async #restrictions(): Promise<ManagedRestrictions> {
    if (!this.#managed) return NO_RESTRICTIONS;
    try {
      return await this.#managed();
    } catch (err) {
      this.#log.warn('managed policy unreadable for extensions', { err });
      return new ManagedRestrictions({
        layers: [],
        failClosed: 'the managed policy could not be read',
      });
    }
  }

  /**
   * Why managed policy refuses this extension (D4, FR-106), or null: a policy that cannot be read,
   * its id among the refused extensions or plugins, or an unverified bundle while unverified
   * installs are refused. `verified` is the live verdict (its key still trusted).
   */
  async #refusal(id: string, verified: boolean): Promise<string | null> {
    const m = await this.#restrictions();
    if (m.failClosed)
      return `Extensions are off: your organization's managed policy could not be read (${m.failClosed})`;
    return (
      m.extension(id) ??
      m.plugin(id) ??
      (verified ? null : m.unverifiedInstall('an unverified extension'))
    );
  }

  async #liveVerified(row: Row): Promise<boolean> {
    if (row.signature !== 'verified' || !row.publisherKey) return false;
    return (await this.#trusted()).some((t) => t.key === row.publisherKey);
  }

  /** The egress ceiling for `nova.net.fetch`: the settings, narrowed by every managed layer. */
  async #egress(): Promise<ExtensionEgress> {
    const m = await this.#restrictions();
    if (m.failClosed) return { mode: 'off', deny: [], allow: [], failClosed: m.failClosed };
    const rank = { off: 0, limited: 1, allowlist: 2 } as const;
    let mode: ExtensionEgress['mode'] = 'allowlist';
    const narrow = (next: ExtensionEgress['mode']) => {
      if (rank[next] < rank[mode]) mode = next;
    };
    const deny: string[] = [];
    if (this.#o.settings.egress) {
      const s = await this.#o.settings.egress();
      narrow(s.mode);
      deny.push(...s.deny);
    }
    const allow: string[][] = [];
    for (const l of m.layers) {
      if (l.egress?.mode) narrow(l.egress.mode);
      deny.push(...(l.egress?.deny ?? []));
      if (l.egress?.allow) allow.push([...l.egress.allow]);
    }
    return { mode, deny, allow, failClosed: null };
  }

  /** Wire managed policy's install check (U, D4). */
  useInstallPolicy(policy: ExtensionInstallPolicy | null): void {
    this.#policy = policy;
  }

  useNotifier(notifier: Notifier | null): void {
    this.#notifier = notifier;
  }

  get extensionsDir(): string {
    return join(this.#o.dataDir, 'extensions');
  }

  /** The extension's own data folder (`${extensionData}`). */
  dataFolder(accountId: string, extensionId: string): string {
    return this.#inside(join(this.extensionsDir, 'data'), accountId, extensionId);
  }

  /**
   * `<root>/<segments>` when it stays strictly inside `root` and every segment is one folder name,
   * else `validation`: a crafted id (an imported row) never reaches another folder (M8 data review
   * #2).
   */
  #inside(root: string, ...segments: string[]): string {
    const base = resolve(root);
    const abs = resolve(base, ...segments);
    const plain = segments.every(
      (s) => s.length > 0 && s !== '.' && s !== '..' && !/[/\\\0]/.test(s),
    );
    if (!plain || abs === base || !isWithin(base, abs))
      throw new NovaError('validation', 'refusing a path outside the extensions folder', {
        details: { reason: 'unsafe_path' },
      });
    return abs;
  }

  async #trusted(): Promise<TrustedPublisher[]> {
    const own = await this.#o.settings.trustedPublishers();
    return [...(this.#o.builtinPublishers ?? []), ...own];
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  // ---- reads ------------------------------------------------------------------------------------

  async #rows(accountId: string): Promise<Row[]> {
    const rows = await this.#db.orm
      .select()
      .from(extensionInstall)
      .where(eq(extensionInstall.accountId, accountId));
    return rows.sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1));
  }

  async #row(accountId: string, extensionId: string): Promise<Row | null> {
    const [row] = await this.#db.orm
      .select()
      .from(extensionInstall)
      .where(
        and(eq(extensionInstall.accountId, accountId), eq(extensionInstall.pluginId, extensionId)),
      );
    return row ?? null;
  }

  async #pluginRow(accountId: string, extensionId: string) {
    const [row] = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.pluginId, extensionId)));
    return row ?? null;
  }

  async #mustRow(accountId: string, extensionId: string): Promise<Row> {
    const row = await this.#row(accountId, extensionId);
    if (!row) throw new NovaError('not_found', 'extension not found');
    return row;
  }

  async list(accountId: string): Promise<ExtensionView[]> {
    const out: ExtensionView[] = [];
    for (const r of await this.#rows(accountId)) out.push(await this.#view(r));
    return out;
  }

  async get(accountId: string, extensionId: string): Promise<ExtensionView> {
    return this.#view(await this.#mustRow(accountId, extensionId));
  }

  #manifest(row: Row): ExtensionManifest {
    return parseExtensionManifest(parseJson<unknown>(row.manifestJson, null));
  }

  #publisher(key: string | null, trusted: readonly TrustedPublisher[]): ExtensionPublisherView {
    const t = key ? trusted.find((x) => x.key === key) : undefined;
    return {
      key,
      name: t?.name ?? null,
      fingerprint: key ? publisherFingerprint(key) : null,
      trusted: t !== undefined,
    };
  }

  async #view(row: Row): Promise<ExtensionView> {
    const manifest = this.#manifest(row);
    const plugin = await this.#pluginRow(row.accountId, row.pluginId);
    const pluginManifest = plugin
      ? parseJson<PluginManifest>(plugin.manifestJson, { permissions: {} } as PluginManifest)
      : ({ permissions: {} } as PluginManifest);
    const trusted = await this.#trusted();
    const publisher = this.#publisher(row.publisherKey, trusted);
    const enabled = plugin?.enabled ?? false;
    const host = this.host.status(row.accountId, row.pluginId);
    const refused = enabled
      ? await this.#refusal(row.pluginId, await this.#liveVerified(row))
      : null;
    let status: ExtensionStatus;
    if (!enabled) status = 'disabled';
    else if (refused) status = 'stopped';
    else if (!(await this.#o.settings.enabled())) status = 'stopped';
    else status = host.status;
    const reg = this.host.registrations(row.accountId, row.pluginId);
    const secrets: { name: string; set: boolean }[] = [];
    for (const name of manifest.permissions.secrets ?? [])
      secrets.push({
        name,
        set: await this.#o.secrets.has(secretRef('extension', row.pluginId, name)),
      });
    return {
      id: row.pluginId,
      name: pluginManifest.name ?? row.pluginId,
      version: row.version,
      description: pluginManifest.description ?? null,
      api: row.api,
      signature: row.signature,
      // Verified while its key is still trusted (removing a trusted key unverifies it).
      verified: row.signature === 'verified' && publisher.trusted,
      publisher,
      digest: row.digest,
      enabled,
      status,
      error: refused ?? host.error ?? row.lastError,
      permissions: extensionPermissionLines(manifest, pluginManifest),
      hooks: this.#hookViews(row, manifest),
      registered: {
        commands: reg?.commands.size ?? 0,
        panels: reg?.panels.size ?? 0,
        tools: reg?.tools.size ?? 0,
        hooks: reg?.hooks.size ?? 0,
        themes: reg?.themes.size ?? 0,
        keybindings: reg?.keybindings.size ?? 0,
        menus: reg?.menus.size ?? 0,
        statusItems: reg?.status.size ?? 0,
        events: reg?.events.size ?? 0,
      },
      secrets,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
    };
  }

  #hookViews(row: Row, manifest: ExtensionManifest): ExtensionHookView[] {
    const rows = this.#hooks?.available()
      ? this.#hooks
          .list(row.accountId)
          .filter((h) => h.source === 'extension' && h.pluginId === row.pluginId)
      : [];
    return (manifest.permissions.hooks ?? []).map((h) => {
      const stored = rows.find((r) => r.key === h.id);
      return {
        id: hookRef({ source: 'extension', pluginId: row.pluginId, projectId: null, key: h.id }),
        event: h.event,
        matcher: h.matcher === undefined ? null : [h.matcher].flat().join(', '),
        contentHash: extensionHookHash(row.pluginId, h, row.digest),
        failClosed:
          h.failClosed === true || h.event === 'tool.pre' || h.event === 'permission.request',
        timeoutMs: h.timeoutMs ?? 30_000,
        status: stored ? hookStatus(stored) : 'needs_trust',
      };
    });
  }

  // ---- preview ----------------------------------------------------------------------------------

  #sweep(): void {
    const now = this.#now().getTime();
    for (const [id, p] of this.#previews)
      if (p.expiresAt <= now) {
        this.#previews.delete(id);
        rmSync(p.staging, { recursive: true, force: true });
      }
  }

  /** Read a source into a checked bundle; a signature that does not match is refused here. */
  async #read(
    accountId: string,
    source: ExtensionSource,
  ): Promise<{ check: BundleCheck; origin: string; bytes: Uint8Array }> {
    const trusted = await this.#trusted();
    let check: BundleCheck;
    let origin: string;
    let bytes: Uint8Array;
    if (source.kind === 'upload') {
      bytes = Buffer.from(source.bundle, 'base64');
      if (bytes.length > EXTENSION_BUNDLE_MAX_BYTES)
        throw new NovaError('validation', 'the bundle is larger than 32 MB');
      check = verifyBundle(bytes, { trusted });
      origin = `upload:${(source.fileName ?? 'extension.novax').replace(/[^\w.-]/g, '_').slice(0, 100)}`;
    } else {
      let real: string;
      try {
        real = realpathSync(source.path);
      } catch {
        throw new NovaError('validation', `not found on the Hub: ${source.path}`);
      }
      if (statSync(real).isDirectory()) {
        const files = folderBundleFiles(real);
        check = checkFiles(files, null, trusted);
        bytes = packBundle(files).bytes;
      } else {
        if (statSync(real).size > EXTENSION_BUNDLE_MAX_BYTES)
          throw new NovaError('validation', 'the bundle is larger than 32 MB');
        bytes = readFileSync(real);
        check = verifyBundle(bytes, { trusted });
      }
      origin = real;
    }
    if (check.status === 'invalid') {
      await this.#audit(accountId, 'extension.refused', '(unknown)', {
        origin,
        reason: check.reason,
        digest: check.digest,
      });
      throw new NovaError(
        'validation',
        `This bundle was refused: ${check.message ?? 'its signature does not match'}.`,
        {
          details: { reason: 'signature_invalid', why: check.reason },
        },
      );
    }
    if (!check.files.has(EXTENSION_MANIFEST_PATH))
      throw new NovaError('validation', `not an extension: ${EXTENSION_MANIFEST_PATH} is missing`, {
        details: { reason: 'not_an_extension' },
      });
    return { check, origin, bytes };
  }

  /**
   * Check a bundle and say what installing it would do; nothing is installed. `provenance` says
   * where it came from (the marketplace's catalog), for the plugin row and the audit.
   */
  preview(
    accountId: string,
    source: ExtensionSource,
    provenance: ExtensionProvenance = {},
  ): Promise<ExtensionPreviewView> {
    return this.#preview(accountId, source, false, provenance);
  }

  async #preview(
    accountId: string,
    source: ExtensionSource,
    dev: boolean,
    provenance: ExtensionProvenance = {},
  ): Promise<ExtensionPreviewView> {
    this.#sweep();
    const { check, origin, bytes } = await this.#read(accountId, source);
    const id = uuidv7();
    const staging = join(this.extensionsDir, '.staging', id);
    extractBundle(check.files, staging);
    let loaded: LoadedExtension;
    let plugin: PluginPreview;
    try {
      loaded = loadExtensionFolder(
        staging,
        this.#o.novaVersion ? { novaVersion: this.#o.novaVersion } : {},
      );
      this.#checkScopes(accountId, loaded);
      plugin = await this.#o.plugins.preview(accountId, { kind: 'path', path: staging });
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    if (this.#previews.size >= MAX_PREVIEWS) {
      const oldest = [...this.#previews.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest) {
        this.#previews.delete(oldest.id);
        rmSync(oldest.staging, { recursive: true, force: true });
      }
    }
    const { files: _files, ...summary } = check;
    const rec: PreviewRecord = {
      id,
      accountId,
      staging,
      origin,
      dev,
      bytes,
      provenance: { ...provenance },
      check: summary,
      loaded,
      plugin,
      expiresAt: this.#now().getTime() + (this.#o.previewTtlMs ?? EXTENSION_PREVIEW_TTL_MS),
    };
    this.#previews.set(id, rec);
    return this.#previewView(rec);
  }

  /** A filesystem scope inside the Hub's own data is refused at install (docs/12 §7.2). */
  #checkScopes(accountId: string, loaded: LoadedExtension): void {
    const id = loaded.plugin.manifest.id;
    for (const s of fsScopes(loaded.manifest, {
      data: this.dataFolder(accountId, id),
      root: loaded.root,
    }))
      if (
        s.declared.startsWith('/') &&
        (s.path === this.#o.dataDir ||
          s.path.startsWith(`${this.#o.dataDir}/`) ||
          this.#o.dataDir.startsWith(`${s.path}/`))
      )
        throw new NovaError(
          'validation',
          `extension.json permissions.fs: ${s.declared} would reach the Hub's own data`,
          {
            details: { reason: 'fs_scope_refused' },
          },
        );
  }

  async #previewView(rec: PreviewRecord): Promise<ExtensionPreviewView> {
    const m = rec.loaded.manifest;
    const pm = rec.loaded.plugin.manifest;
    const id = pm.id;
    const lines = extensionPermissionLines(m, pm);
    const current = await this.#row(rec.accountId, id);
    let diff: ExtensionPreviewView['diff'] = null;
    if (current) {
      const before = await this.#pluginRow(rec.accountId, id);
      const beforeManifest = before
        ? parseJson<PluginManifest>(before.manifestJson, { permissions: {} } as PluginManifest)
        : ({ permissions: {} } as PluginManifest);
      diff = extensionPermissionDiff(
        extensionPermissionLines(this.#manifest(current), beforeManifest),
        lines,
      );
    }
    const verified = rec.check.status === 'verified' && !rec.dev;
    const trusted = await this.#trusted();
    const signature: ExtensionSignature = rec.dev ? 'dev' : verified ? 'verified' : 'unverified';
    const sideloadReason = verified
      ? null
      : rec.dev
        ? 'loaded by nova dev, so it is not verified'
        : (rec.check.message ?? 'the bundle is not verified');
    const warnings = [
      ...(verified
        ? []
        : [`Unverified: ${sideloadReason}. Install it only if you trust where it came from.`]),
      ...rec.loaded.warnings,
      ...rec.plugin.warnings.filter((w) => !w.startsWith(PLUGIN_UNVERIFIED)),
    ];
    if (diff?.added.length)
      warnings.push(`This update asks for more: ${diff.added.map((l) => l.text).join('; ')}.`);
    return {
      previewId: rec.id,
      id,
      name: pm.name,
      version: pm.version,
      description: pm.description ?? null,
      api: m.api,
      signature,
      verified,
      publisher: this.#publisher(rec.check.publisher, trusted),
      digest: rec.check.digest,
      sideloadReason,
      permissions: lines,
      diff,
      hooks: (m.permissions.hooks ?? []).map((h) => ({
        id: hookRef({ source: 'extension', pluginId: id, projectId: null, key: h.id }),
        event: h.event,
        matcher: h.matcher === undefined ? null : [h.matcher].flat().join(', '),
        contentHash: extensionHookHash(id, h, rec.check.digest),
        failClosed:
          h.failClosed === true || h.event === 'tool.pre' || h.event === 'permission.request',
        timeoutMs: h.timeoutMs ?? 30_000,
        status: 'needs_trust',
      })),
      pluginHooks: rec.plugin.hooks.map((h) => ({
        id: h.id,
        event: h.event,
        contentHash: h.contentHash,
      })),
      warnings,
      replaces: current ? { version: current.version } : null,
    };
  }

  // ---- install, update, dev reload ---------------------------------------------------------------

  /** Install a previewed bundle; `provenance` (if given) replaces the preview's. */
  install(
    accountId: string,
    req: InstallExtensionRequest,
    provenance?: ExtensionProvenance,
  ): Promise<ExtensionView> {
    return this.#serial(() => this.#install(accountId, req, false, provenance));
  }

  /**
   * What a rollback needs to put an installed extension back exactly as it is: its bundle's own
   * bytes (so its signature is checked again and a verified extension comes back verified), its
   * switch, where it came from and its trusted hooks. Null when it is not installed. The returned
   * function reinstalls that state (the marketplace calls it when an update fails after it
   * committed).
   */
  async snapshot(accountId: string, id: string): Promise<(() => Promise<void>) | null> {
    const state = await this.#capture(accountId, id);
    if (!state) return null;
    return () =>
      this.#serial(async () => {
        await this.#restore(accountId, id, state);
      });
  }

  /**
   * `nova dev`: check, install or replace, and restart a local extension in one request. Always
   * unverified (the request carries the sideload confirmation); `trustHooks` trusts its hooks at
   * the hashes of this load.
   */
  dev(accountId: string, req: DevExtensionRequest): Promise<ExtensionView> {
    return this.#serial(async () => {
      const preview = await this.#preview(
        accountId,
        { kind: 'upload', bundle: req.bundle, fileName: 'dev.novax' },
        true,
      );
      const trustHooks = req.trustHooks
        ? [
            ...preview.hooks.map((h) => ({ id: h.id, contentHash: h.contentHash })),
            ...preview.pluginHooks.map((h) => ({ id: h.id, contentHash: h.contentHash })),
          ]
        : [];
      return this.#install(
        accountId,
        { previewId: preview.previewId, confirmSideload: true, enable: true, trustHooks },
        true,
      );
    });
  }

  async #install(
    accountId: string,
    req: InstallExtensionRequest,
    dev: boolean,
    provenance?: ExtensionProvenance,
    opts: { rollback: boolean } = { rollback: true },
  ): Promise<ExtensionView> {
    this.#sweep();
    const p = this.#previews.get(req.previewId);
    if (!p || p.accountId !== accountId)
      throw new NovaError('request_expired', 'the extension preview expired; preview it again');
    const pm = p.loaded.plugin.manifest;
    const id = pm.id;
    const trusted = await this.#trusted();
    const verified =
      !p.dev &&
      p.check.status === 'verified' &&
      p.check.publisher !== null &&
      trusted.some((t) => t.key === p.check.publisher);
    const problem = await this.#policy?.installProblem({
      accountId,
      extensionId: id,
      verified,
      publisherKey: p.check.publisher,
    });
    // The service's own check as well: restores and dev reloads pass here too (FR-106).
    const refusal = problem ?? (await this.#refusal(id, verified));
    if (refusal) {
      await this.#audit(accountId, 'extension.refused', id, {
        reason: 'managed',
        problem: refusal,
        verified,
      });
      throw new NovaError('policy_denied', refusal, { details: { reason: 'managed' } });
    }
    if (!verified && req.confirmSideload !== true)
      throw new NovaError(
        'validation',
        'confirm that you want to install an unverified extension',
        {
          details: { field: 'confirmSideload', reason: 'sideload_confirmation_required' },
        },
      );
    const key = `${accountId}\n${id}`;
    const enable = req.enable ?? true;
    const sdkHookIds = new Set(
      (p.loaded.manifest.permissions.hooks ?? []).map((h) =>
        hookRef({ source: 'extension', pluginId: id, projectId: null, key: h.id }),
      ),
    );
    const trust = req.trustHooks ?? [];
    const current = await this.#row(accountId, id);
    const wasRunning = this.host.status(accountId, id).status === 'running';
    const prov = { ...p.provenance, ...provenance };
    const origin = prov.origin ?? p.origin;
    // The previous version's bundle stays until this one has fully succeeded.
    const previous = current && opts.rollback ? await this.#capture(accountId, id) : null;
    this.#busy.add(key);
    try {
      // The plugin installer swaps the folder: the old worker stops first.
      await this.host.stop(accountId, id);
      try {
        await this.#o.plugins.install(
          accountId,
          {
            previewId: p.plugin.previewId,
            // This service asked for the confirmation above when it is not verified.
            confirmSideload: !verified,
            enable,
            trustHooks: trust.filter((t) => !sdkHookIds.has(t.id)),
          },
          // The row and its audit entry record this service's signature check (FR-049).
          {
            verified,
            publisher: p.check.publisher,
            source: prov.source ?? 'local',
            origin,
            via: prov.via ?? (dev ? 'dev' : verified ? 'signed' : 'sideload'),
          },
        );
      } catch (err) {
        if (wasRunning && current) await this.#start(accountId, id).catch(() => undefined);
        throw err;
      }
      try {
        await this.#commit(accountId, id, p, current, {
          verified,
          dev,
          enable,
          trust,
          origin,
          prov,
        });
      } catch (err) {
        // The plugin committed but the rest did not: put back what was there (FR-049 rollback).
        this.#log.warn('extension install failed after it committed; rolling back', {
          extensionId: id,
          err,
        });
        if (opts.rollback) await this.#undo(accountId, id, previous);
        throw err;
      }
      if (enable) await this.#start(accountId, id);
    } finally {
      this.#busy.delete(key);
    }
    return this.get(accountId, id);
  }

  /** The steps after the plugin installed: the row, the hooks, the kept bundle, audit, events. */
  async #commit(
    accountId: string,
    id: string,
    p: PreviewRecord,
    current: Row | null,
    o: {
      verified: boolean;
      dev: boolean;
      enable: boolean;
      trust: { id: string; contentHash: string }[];
      origin: string;
      prov: ExtensionProvenance;
    },
  ): Promise<void> {
    const { verified, dev, enable, trust } = o;
    const pm = p.loaded.plugin.manifest;
    const now = this.#now().toISOString();
    const signature: ExtensionSignature = dev ? 'dev' : verified ? 'verified' : 'unverified';
    const row: Row = {
      id: current?.id ?? uuidv7(),
      accountId,
      pluginId: id,
      version: pm.version,
      api: p.loaded.manifest.api,
      signature,
      publisherKey: p.check.publisher,
      digest: p.check.digest,
      manifestJson: JSON.stringify(p.loaded.manifest),
      lastError: null,
      installedAt: current?.installedAt ?? now,
      updatedAt: now,
    };
    await this.#db.transaction(async () => {
      if (current)
        await this.#db.orm
          .update(extensionInstall)
          .set(row)
          .where(eq(extensionInstall.id, current.id));
      else await this.#db.orm.insert(extensionInstall).values(row);
    });
    this.#previews.delete(p.id);
    rmSync(p.staging, { recursive: true, force: true });
    this.host.clearError(accountId, id);
    await this.#syncHooks(accountId, id, p.loaded.manifest, p.check.digest, enable, trust, 'user');
    // Only now does this version's bundle replace the previous one (a rollback needs it).
    this.#keepBundle(accountId, id, p.bytes);
    await this.#audit(
      accountId,
      dev ? 'extension.dev.reload' : current ? 'extension.update' : 'extension.install',
      id,
      {
        version: pm.version,
        previousVersion: current?.version ?? null,
        signature,
        verified,
        publisher: p.check.publisher,
        digest: p.check.digest,
        sideload: !verified,
        source: o.prov.source ?? 'local',
        origin: o.origin,
        ...(o.prov.via ? { via: o.prov.via } : {}),
        enabled: enable,
        trustedHooks: trust.length,
      },
    );
    await this.#emit(accountId, id, current ? 'updated' : 'installed');
  }

  /** After a failed update: the previous bundle back; after a failed first install: nothing. */
  async #undo(accountId: string, id: string, previous: InstalledState | null): Promise<void> {
    try {
      if (previous) await this.#restore(accountId, id, previous);
      else {
        await this.host.stop(accountId, id);
        if (await this.#pluginRow(accountId, id)) await this.#o.plugins.uninstall(accountId, id);
        await this.#forget(accountId, id, false);
      }
    } catch (err) {
      this.#log.warn('extension rollback failed', { extensionId: id, err });
    }
  }

  /** Where the bundle of the installed version is kept (until the next install succeeds). */
  #bundleFile(accountId: string, id: string): string {
    return this.#inside(join(this.extensionsDir, 'bundles'), accountId, `${id}.novax`);
  }

  #keepBundle(accountId: string, id: string, bytes: Uint8Array): void {
    const file = this.#bundleFile(accountId, id);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${uuidv7()}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** The installed state of an extension, with its kept bundle (or, if none, its files unsigned). */
  async #capture(accountId: string, id: string): Promise<InstalledState | null> {
    const row = await this.#row(accountId, id);
    const plugin = await this.#pluginRow(accountId, id);
    if (!row || !plugin) return null;
    const file = this.#bundleFile(accountId, id);
    const bytes = existsSync(file)
      ? readFileSync(file)
      : packBundle(installedFiles(plugin.installPath)).bytes;
    const trust: { id: string; contentHash: string }[] = [];
    if (this.#hooks?.available()) {
      for (const h of this.#hooks.list(accountId))
        if (
          h.pluginId === id &&
          (h.source === 'extension' || h.source === 'plugin') &&
          h.trustState === 'trusted' &&
          h.trustedHash === h.contentHash
        )
          trust.push({ id: hookRef(h), contentHash: h.contentHash });
    }
    return {
      bytes,
      enabled: plugin.enabled,
      dev: row.signature === 'dev',
      source: plugin.source,
      origin: plugin.origin,
      trust,
    };
  }

  /** Reinstall a captured state; its bytes are checked again like any bundle. */
  async #restore(accountId: string, id: string, state: InstalledState): Promise<void> {
    const preview = await this.#preview(
      accountId,
      {
        kind: 'upload',
        bundle: Buffer.from(state.bytes).toString('base64'),
        fileName: `${id}.novax`,
      },
      state.dev,
      { source: state.source, origin: state.origin, via: 'rollback' },
    );
    await this.#install(
      accountId,
      // The owner confirmed this exact version when it was installed.
      {
        previewId: preview.previewId,
        confirmSideload: true,
        enable: state.enabled,
        trustHooks: state.trust,
      },
      state.dev,
      undefined,
      { rollback: false },
    );
  }

  /** SDK hooks as hook rows (source `extension`): needs_trust unless trusted at this hash. */
  async #syncHooks(
    accountId: string,
    id: string,
    manifest: ExtensionManifest | null,
    digest: string,
    enabled: boolean,
    trust: readonly { id: string; contentHash: string }[],
    by: string,
  ): Promise<void> {
    const store = this.#hooks;
    if (!store?.available()) return;
    const found: DiscoveredHook[] = (manifest?.permissions.hooks ?? []).map((h) => ({
      source: 'extension',
      pluginId: id,
      projectId: null,
      definition: extensionHookDefinition(id, h),
      baseDir: null,
      limits: null,
      contentHash: extensionHookHash(id, h, digest),
      timeoutMs: h.timeoutMs ?? 30_000,
    }));
    const keys = trust
      .map((t) => ({
        key: t.id.startsWith(`hook:${id}.`) ? t.id.slice(`hook:${id}.`.length) : t.id,
        contentHash: t.contentHash,
        by,
      }))
      .filter((t) =>
        found.some((f) => f.definition.id === t.key && f.contentHash === t.contentHash),
      );
    const changes = await store.sync(accountId, { source: 'extension', pluginId: id }, found, keys);
    const rows = store.list(accountId).filter((r) => r.source === 'extension' && r.pluginId === id);
    await store.setEnabled(
      accountId,
      rows.filter((r) => r.enabled !== enabled).map((r) => r.id),
      enabled,
    );
    for (const c of changes)
      await Promise.resolve(
        this.#o.events?.emit({
          name: 'hook.trust.changed',
          actor: 'system',
          accountId,
          payload: { hookId: c.hookId, status: c.status },
        }),
      ).catch(() => undefined);
  }

  // ---- running --------------------------------------------------------------------------------------

  async #spec(accountId: string, id: string): Promise<ExtensionSpec | null> {
    const row = await this.#row(accountId, id);
    const plugin = await this.#pluginRow(accountId, id);
    if (!row || !plugin) return null;
    return {
      accountId,
      extensionId: id,
      version: row.version,
      root: plugin.installPath,
      dataDir: this.dataFolder(accountId, id),
      manifest: this.#manifest(row),
      digest: row.digest,
    };
  }

  /** Start an installed, enabled extension's worker (when the SDK switch is on). */
  async #start(accountId: string, id: string): Promise<void> {
    if (this.#closed || !(await this.#o.settings.enabled())) return;
    const plugin = await this.#pluginRow(accountId, id);
    if (!plugin?.enabled) return;
    const row = await this.#row(accountId, id);
    if (!row) return;
    // Managed policy first: a refused extension never starts (an import or a restore included).
    const refusal = await this.#refusal(id, await this.#liveVerified(row));
    if (refusal) {
      await this.#refuse(accountId, row, refusal);
      return;
    }
    const spec = await this.#spec(accountId, id);
    if (!spec) return;
    // Its hooks run again (a refusal turned them off).
    await this.#syncHooks(accountId, id, spec.manifest, spec.digest, true, [], 'system');
    const r = await this.host.start(spec);
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(extensionInstall)
        .set({ lastError: r.status === 'error' ? r.error : null })
        .where(and(eq(extensionInstall.accountId, accountId), eq(extensionInstall.pluginId, id)));
    });
    await this.#emitStatus(accountId, id);
    if (r.status === 'error')
      this.#log.warn('extension did not start', { extensionId: id, error: r.error });
  }

  /**
   * Managed policy refuses this extension: its worker ends, its hooks stop (an enabled hook of a
   * stopped extension would block every call it guards), and the reason shows on it.
   */
  async #refuse(accountId: string, row: Row, refusal: string): Promise<void> {
    const id = row.pluginId;
    const wasRunning = this.host.status(accountId, id).status !== 'stopped';
    await this.host.stop(accountId, id);
    await this.#syncHooks(accountId, id, this.#manifest(row), row.digest, false, [], 'system');
    if (row.lastError === refusal && !wasRunning) return;
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(extensionInstall)
        .set({ lastError: refusal })
        .where(eq(extensionInstall.id, row.id));
    });
    this.#log.warn('extension refused by managed policy', { extensionId: id, refusal });
    await this.#audit(
      accountId,
      'extension.refused',
      id,
      { reason: 'managed', problem: refusal },
      'system',
    );
    await this.#emitStatus(accountId, id);
  }

  /**
   * Managed policy changed (`managed.policy.changed`) or trusted publishers did: stop every
   * extension it now refuses, and start the ones it allows again.
   */
  reapplyPolicy(): Promise<void> {
    return this.#serial(async () => {
      const rows = await this.#db.orm.select().from(extensionInstall);
      for (const row of rows) {
        if (this.#closed) return;
        try {
          const refusal = await this.#refusal(row.pluginId, await this.#liveVerified(row));
          if (refusal) await this.#refuse(row.accountId, row, refusal);
          else if (this.host.status(row.accountId, row.pluginId).status !== 'running')
            await this.#start(row.accountId, row.pluginId);
        } catch (err) {
          this.#log.warn('extension policy not applied', { extensionId: row.pluginId, err });
        }
      }
    });
  }

  /** Start every installed, enabled extension (Hub start, the SDK switch turned on). */
  async startAll(): Promise<void> {
    if (!(await this.#o.settings.enabled())) return;
    const rows = await this.#db.orm.select().from(extensionInstall);
    for (const r of rows) {
      if (this.#closed) return;
      if (this.host.status(r.accountId, r.pluginId).status === 'running') continue;
      try {
        await this.#start(r.accountId, r.pluginId);
      } catch (err) {
        this.#log.warn('extension start failed', { extensionId: r.pluginId, err });
      }
    }
  }

  /** The SDK switch turned off: every worker stops. */
  async stopAll(): Promise<void> {
    await this.host.stopAll();
    // Their hooks stop too: an enabled hook of a stopped extension would block what it guards.
    for (const row of await this.#db.orm.select().from(extensionInstall))
      await this.#syncHooks(
        row.accountId,
        row.pluginId,
        this.#manifest(row),
        row.digest,
        false,
        [],
        'system',
      );
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unlisten();
    for (const t of this.#pendingNotices.values()) clearImmediate(t);
    this.#pendingNotices.clear();
    await this.host.close();
    for (const p of this.#previews.values()) rmSync(p.staging, { recursive: true, force: true });
    this.#previews.clear();
  }

  // ---- enable, disable, uninstall -------------------------------------------------------------------

  setEnabled(accountId: string, id: string, enabled: boolean, by = 'user'): Promise<ExtensionView> {
    return this.#serial(async () => {
      const row = await this.#mustRow(accountId, id);
      if (enabled) {
        const refusal = await this.#refusal(id, await this.#liveVerified(row));
        if (refusal) throw managedDenied(refusal, { extensionId: id });
      }
      const key = `${accountId}\n${id}`;
      this.#busy.add(key);
      try {
        await this.#o.plugins.setEnabled(accountId, id, enabled);
        await this.#syncHooks(accountId, id, this.#manifest(row), row.digest, enabled, [], by);
        if (enabled) {
          this.host.clearError(accountId, id);
          await this.#start(accountId, id);
        } else {
          await this.host.stop(accountId, id);
          await this.#emitStatus(accountId, id);
        }
        await this.#audit(
          accountId,
          enabled ? 'extension.enable' : 'extension.disable',
          id,
          { by },
          by === 'user' ? 'user' : 'system',
        );
        await this.#emit(accountId, id, enabled ? 'enabled' : 'disabled');
      } finally {
        this.#busy.delete(key);
      }
      return this.get(accountId, id);
    });
  }

  /**
   * Remove the extension: its worker, the plugin (files, servers, roles), its hooks and its
   * secrets; its data folder too when `removeData` (docs/26 §3: user data with confirmation).
   */
  uninstall(accountId: string, id: string, opts: { removeData?: boolean } = {}): Promise<void> {
    return this.#serial(async () => {
      await this.#mustRow(accountId, id);
      const key = `${accountId}\n${id}`;
      this.#busy.add(key);
      try {
        await this.host.stop(accountId, id);
        if (await this.#pluginRow(accountId, id)) await this.#o.plugins.uninstall(accountId, id);
        await this.#forget(accountId, id, opts.removeData === true);
        await this.#audit(accountId, 'extension.uninstall', id, {
          removedData: opts.removeData === true,
        });
        await this.#emit(accountId, id, 'removed');
      } finally {
        this.#busy.delete(key);
      }
    });
  }

  async #forget(accountId: string, id: string, removeData: boolean): Promise<void> {
    await this.#db.transaction(async () => {
      await this.#db.orm
        .delete(extensionInstall)
        .where(and(eq(extensionInstall.accountId, accountId), eq(extensionInstall.pluginId, id)));
    });
    await this.#syncHooks(accountId, id, null, '', false, [], 'system');
    for (const ref of await this.#o.secrets.list(`secret://extension/${id}/`))
      await this.#o.secrets.delete(ref);
    this.host.clearError(accountId, id);
    rmSync(this.#bundleFile(accountId, id), { force: true });
    if (removeData) rmSync(this.dataFolder(accountId, id), { recursive: true, force: true });
  }

  /** An undeclared request (host.ts): deny happened; now turn it off and tell the owner. */
  async #violation(accountId: string, id: string, what: string): Promise<void> {
    if (this.#closed || !(await this.#row(accountId, id))) return;
    this.#log.warn('extension turned off after an undeclared request', { extensionId: id, what });
    try {
      await this.setEnabled(accountId, id, false, 'system');
    } catch (err) {
      this.#log.warn('could not turn the extension off', { err, extensionId: id });
    }
    await this.#notifier
      ?.notify({
        accountId,
        kind: 'error',
        title: `Extension ${id} was turned off`,
        body: `It asked for ${what}, which it did not declare.`,
        href: '/settings/extensions',
        dedupeKey: `extension-violation:${id}`,
      })
      .catch((err: unknown) => this.#log.warn('extension notification failed', { err }));
  }

  /** The plugins area changed a plugin outside this service (its own routes, an import). */
  async #onPluginChange(c: PluginHookChange): Promise<void> {
    const key = `${c.accountId}\n${c.pluginId}`;
    if (this.#busy.has(key) || this.#closed) return;
    await this.#serial(async () => {
      const row = await this.#row(c.accountId, c.pluginId);
      if (c.change === 'removed') {
        if (!row) return;
        await this.host.stop(c.accountId, c.pluginId);
        await this.#forget(c.accountId, c.pluginId, false);
        await this.#emit(c.accountId, c.pluginId, 'removed');
        return;
      }
      if (c.change === 'enabled' || c.change === 'disabled') {
        if (!row) return;
        const enabled = c.change === 'enabled';
        await this.#syncHooks(
          c.accountId,
          c.pluginId,
          this.#manifest(row),
          row.digest,
          enabled,
          [],
          'user',
        );
        if (enabled) await this.#start(c.accountId, c.pluginId);
        else {
          await this.host.stop(c.accountId, c.pluginId);
          await this.#emitStatus(c.accountId, c.pluginId);
        }
        return;
      }
      // Installed or updated through the plugins area: adopt it as an unverified extension.
      await this.#adopt(c.accountId, c.pluginId, row);
    });
  }

  async #adopt(accountId: string, id: string, row: Row | null): Promise<void> {
    const plugin = await this.#pluginRow(accountId, id);
    if (!plugin) return;
    await this.host.stop(accountId, id);
    if (!isExtensionFolder(plugin.installPath)) {
      if (row) await this.#forget(accountId, id, false);
      return;
    }
    let loaded: LoadedExtension;
    try {
      loaded = loadExtensionFolder(plugin.installPath);
      this.#checkScopes(accountId, loaded);
    } catch (err) {
      this.#log.warn('installed plugin has an invalid extension.json', { pluginId: id, err });
      if (row) await this.#forget(accountId, id, false);
      return;
    }
    const files = installedFiles(plugin.installPath);
    const digest = checkFiles(files, null, []).digest;
    const now = this.#now().toISOString();
    const next: Row = {
      id: row?.id ?? uuidv7(),
      accountId,
      pluginId: id,
      version: plugin.version,
      api: loaded.manifest.api,
      signature: 'unverified',
      publisherKey: null,
      digest,
      manifestJson: JSON.stringify(loaded.manifest),
      lastError: null,
      installedAt: row?.installedAt ?? now,
      updatedAt: now,
    };
    await this.#db.transaction(async () => {
      if (row)
        await this.#db.orm
          .update(extensionInstall)
          .set(next)
          .where(eq(extensionInstall.id, row.id));
      else await this.#db.orm.insert(extensionInstall).values(next);
    });
    await this.#syncHooks(accountId, id, loaded.manifest, digest, plugin.enabled, [], 'user');
    this.#keepBundle(accountId, id, packBundle(files).bytes);
    await this.#audit(accountId, row ? 'extension.update' : 'extension.install', id, {
      version: plugin.version,
      signature: 'unverified',
      via: 'plugins',
      digest,
    });
    await this.#emit(accountId, id, row ? 'updated' : 'installed');
    if (plugin.enabled) await this.#start(accountId, id);
  }

  // ---- commands, status items, secrets -----------------------------------------------------------

  /** Run an extension's command (the command palette, a menu or a status item). */
  async runCommand(
    accountId: string,
    id: string,
    commandId: string,
    args: unknown,
  ): Promise<ExtensionCommandResult> {
    await this.#mustRow(accountId, id);
    const reg = this.host.registrations(accountId, id);
    if (!reg?.commands.has(commandId))
      throw new NovaError('not_found', `the command ${commandId} is not available`);
    let size: number;
    try {
      size = JSON.stringify(args ?? null).length;
    } catch {
      throw new NovaError('validation', 'the arguments are not JSON');
    }
    if (size > COMMAND_ARGS_MAX)
      throw new NovaError('validation', 'the arguments are larger than 64 KiB');
    const r = await this.host.invoke(accountId, id, 'command', commandId, args ?? null, {
      origin: 'user',
    });
    await this.#audit(accountId, 'extension.command.run', id, {
      command: commandId,
      ok: r.ok,
      ...(r.ok ? {} : { error: r.error.code }),
    });
    return r.ok
      ? { ok: true, result: r.value, error: null }
      : { ok: false, result: null, error: r.error };
  }

  /** A click on a status item: its command, or its own click handler. */
  async clickStatus(
    accountId: string,
    id: string,
    itemId: string,
  ): Promise<ExtensionCommandResult> {
    const reg = this.host.registrations(accountId, id);
    const item = reg?.status.get(itemId);
    if (!item) throw new NovaError('not_found', 'status item not found');
    if (item.command) return this.runCommand(accountId, id, item.command, null);
    if (!item.clickable) return { ok: true, result: null, error: null };
    const r = await this.host.invoke(accountId, id, 'status', itemId, null, { origin: 'user' });
    return r.ok
      ? { ok: true, result: r.value, error: null }
      : { ok: false, result: null, error: r.error };
  }

  async setSecret(accountId: string, id: string, name: string, value: string): Promise<void> {
    const row = await this.#mustRow(accountId, id);
    if (!(this.#manifest(row).permissions.secrets ?? []).includes(name))
      throw new NovaError('validation', `${id} does not declare the secret ${name}`);
    await this.#o.secrets.put(secretRef('extension', id, name), value);
    await this.#audit(accountId, 'extension.secret.set', id, { name }, 'user', 'secret');
  }

  async deleteSecret(accountId: string, id: string, name: string): Promise<void> {
    await this.#mustRow(accountId, id);
    await this.#o.secrets.delete(secretRef('extension', id, name));
    await this.#audit(accountId, 'extension.secret.delete', id, { name }, 'user', 'secret');
  }

  // ---- what running extensions add -------------------------------------------------------------

  contributions(accountId: string): ExtensionContributionsView {
    const out: ExtensionContributionsView = {
      commands: [],
      panels: [],
      themes: [],
      keybindings: [],
      menus: [],
      statusItems: [],
    };
    for (const { spec, reg } of this.host.running(accountId)) {
      const extensionId = spec.extensionId;
      for (const c of reg.commands.values())
        out.commands.push({ extensionId, id: c.id, title: c.title });
      for (const p of reg.panels.values())
        out.panels.push({
          extensionId,
          id: p.id,
          title: p.title,
          resource: p.resource,
          entryPoint: p.entryPoint,
          extensions: p.extensions ?? [],
        });
      for (const theme of reg.themes.values()) out.themes.push({ extensionId, theme });
      for (const k of reg.keybindings.values())
        out.keybindings.push({
          extensionId,
          command: extensionToolName(extensionId, k.command),
          key: k.key,
          when: k.when,
        });
      for (const m of reg.menus.values())
        out.menus.push({ extensionId, where: m.where, items: m.items });
      for (const s of reg.status.values())
        out.statusItems.push({ extensionId, id: s.id, text: s.text, command: s.command });
    }
    return out;
  }

  /** Registered panels of running extensions, for the MCP Apps area (served from the bundle). */
  uiPanels(accountId: string): ExtensionUi[] {
    const out: ExtensionUi[] = [];
    for (const { spec, reg } of this.host.running(accountId))
      for (const panel of reg.panels.values()) out.push(this.#ui(spec, panel));
    return out;
  }

  #ui(spec: ExtensionSpec, panel: ExtensionPanel & { title: string }): ExtensionUi {
    return {
      extensionId: spec.extensionId,
      entryPoints: [
        {
          kind: panel.entryPoint,
          resource: panel.resource,
          title: panel.title,
          ...(panel.entryPoint === 'file' ? { extensions: panel.extensions ?? [] } : {}),
        },
      ],
      network: spec.manifest.permissions.network ?? [],
      domains: {
        ...(panel.connectDomains ? { connectDomains: panel.connectDomains } : {}),
        ...(panel.resourceDomains ? { resourceDomains: panel.resourceDomains } : {}),
        ...(panel.frameDomains ? { frameDomains: panel.frameDomains } : {}),
      },
      read: (uri) => {
        if (uri !== panel.resource)
          return Promise.resolve({ ok: false, message: `${uri} is not this panel's resource` });
        try {
          return Promise.resolve({ ok: true, html: readPanelHtml(spec.root, panel) });
        } catch (err) {
          return Promise.resolve({
            ok: false,
            message: err instanceof Error ? err.message : 'unreadable',
          });
        }
      },
    };
  }

  // ---- tools, permissions and hooks for the rest of the Hub ------------------------------------

  /** The tools of running extensions, `ext:<id>/<name>` (D3); the gate decides every call. */
  readonly tools: ToolSourceProvider = {
    source: 'plugin',
    list: (accountId) => Promise.resolve(this.#toolDefinitions(accountId)),
  };

  #toolDefinitions(accountId: string): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const { spec, reg } of this.host.running(accountId)) {
      const extensionId = spec.extensionId;
      for (const t of reg.tools.values()) {
        const descriptor: ToolDescriptor = {
          name: extensionToolName(extensionId, t.name),
          title: t.title,
          description: t.description,
          source: 'plugin',
          pluginId: extensionId,
          inputSchema: t.inputSchema,
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          annotations: { ...t.annotations, action: t.action },
          loading: 'deferrable',
        };
        out.push({
          descriptor,
          handler: async (args, ctx): Promise<ToolResult> => {
            const r = await this.host.invoke(
              accountId,
              extensionId,
              'tool',
              t.name,
              args ?? {},
              {
                threadId: ctx.threadId,
                turnId: ctx.turnId,
                callId: ctx.callId,
                projectId: ctx.projectId,
                origin: ctx.origin,
              },
              { signal: ctx.signal, timeoutMs: 60_000 },
            );
            return r.ok ? toToolResult(r.value) : { ok: false, error: r.error };
          },
        });
      }
    }
    return out;
  }

  /**
   * The gate's view of plugin permissions with extensions added: an `ext:` tool's permissions
   * come from its extension.json (its declared tools with their action class and default, its
   * hosts); its hook tools are reads the plugin allows. Everything else goes to `base`.
   */
  permissionSource(base: PluginPermissionSource): PluginPermissionSource {
    return {
      forTool: async (accountId, tool) => {
        const parsed = parseExtensionToolName(tool.name);
        if (!parsed) return base.forTool(accountId, tool);
        return this.#permissions(accountId, parsed.extensionId);
      },
    };
  }

  async #permissions(accountId: string, id: string): Promise<PluginPermissions> {
    const row = await this.#row(accountId, id);
    const empty: PluginPermissions = {
      pluginId: id,
      network: [],
      fs: [],
      tools: {},
      actionDefaults: {},
      hooksAnswerAsks: false,
    };
    if (!row) return empty;
    const m = this.#manifest(row);
    const plugin = await this.#pluginRow(accountId, id);
    const pm = plugin
      ? parseJson<PluginManifest>(plugin.manifestJson, { permissions: {} } as PluginManifest)
      : null;
    const tools: PluginPermissions['tools'] = {};
    for (const [name, t] of Object.entries(m.permissions.tools ?? {}))
      tools[extensionToolName(id, name)] = {
        action: t.action,
        ...(t.default ? { default: t.default } : {}),
      };
    for (const h of m.permissions.hooks ?? [])
      tools[extensionHookTool(id, h.id)] = { action: 'read', default: 'allow' };
    return {
      pluginId: id,
      network: m.permissions.network ?? [],
      fs: [],
      tools,
      actionDefaults: {
        ...(pm?.permissions.actionDefaults ?? {}),
        ...(m.permissions.actionDefaults ?? {}),
      },
      // An SDK hook never answers asks (only managed, user and declared plugin hooks may).
      hooksAnswerAsks: false,
    };
  }

  /**
   * The gate the hooks area uses (hooks/handlers.ts checks an `mcp_tool` handler's tool). Running
   * a trusted SDK hook is not a tool call: like a command hook, it runs because the owner trusted
   * it by hash, and what its code may reach is limited by the extension's declared permissions
   * (host.ts). So a hook-origin check of a registered SDK hook's own hook tool is allowed here,
   * without the floors meant for a model's calls; everything else goes to `base` unchanged.
   */
  hookGate(base: ToolGate): ToolGate {
    return {
      check: async (req, signal) => {
        const p = parseExtensionToolName(req.tool.name);
        if (
          req.origin === 'hook' &&
          p?.hook &&
          this.host.registrations(req.accountId, p.extensionId)?.hooks.has(p.hook)
        ) {
          // A refused extension's hook gets no allow here (and is not handed to the base gate).
          const row = await this.#row(req.accountId, p.extensionId);
          const refusal = row
            ? await this.#refusal(p.extensionId, await this.#liveVerified(row))
            : 'the extension is not installed';
          if (refusal) {
            await this.#audit(
              req.accountId,
              'extension.hook.refused',
              p.extensionId,
              { hook: p.hook, callId: req.callId, problem: refusal },
              'system',
            );
            return { effect: 'deny', reason: refusal, tier: 'pre_approvable', stop: false };
          }
          await this.#audit(
            req.accountId,
            'extension.hook.run',
            p.extensionId,
            { hook: p.hook, callId: req.callId },
            'system',
          );
          return { effect: 'allow', reason: 'a trusted extension hook', tier: 'pre_approvable' };
        }
        return base.check(req, signal);
      },
      preview: (req) => base.preview(req),
    };
  }

  /**
   * Hooks reach an SDK hook through its hook tool, as an `mcp_tool` handler (hooks/handlers.ts):
   * the hooks area keeps trust, timeouts, fail-closed and audit; this finds and calls the handler
   * in the extension's worker. Other names go to `base` (the MCP manager).
   */
  hookClient(base: HookMcpClient | null): HookMcpClient {
    return {
      find: (accountId, name) => {
        const p = parseExtensionToolName(name);
        if (!p) return base?.find(accountId, name) ?? null;
        if (!p.hook || !this.host.registrations(accountId, p.extensionId)?.hooks.has(p.hook))
          return null;
        return {
          name,
          title: `Hook ${p.hook} of ${p.extensionId}`,
          description: `The ${p.hook} hook of the extension ${p.extensionId}.`,
          source: 'plugin',
          pluginId: p.extensionId,
          inputSchema: { type: 'object' },
          annotations: { readOnly: true, action: 'read' },
        };
      },
      call: async (accountId, name, args, opts) => {
        const p = parseExtensionToolName(name);
        if (!p) {
          if (!base)
            return {
              ok: false,
              error: { code: 'mcp.tool_not_found', message: `no connected MCP tool ${name}` },
            };
          return base.call(accountId, name, args, opts);
        }
        if (!p.hook)
          return { ok: false, error: { code: 'not_found', message: `${name} is not a hook` } };
        const r = await this.host.invoke(
          accountId,
          p.extensionId,
          'hook',
          p.hook,
          args,
          {},
          {
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
          },
        );
        if (!r.ok) return { ok: false, error: r.error };
        const value = r.value === null || r.value === undefined ? {} : r.value;
        return {
          ok: true,
          content: [{ type: 'text', text: JSON.stringify(value) }],
          meta: { structuredContent: value },
        };
      },
    };
  }

  // ---- events and audit -----------------------------------------------------------------------------

  /** Registrations changed: one `extension.contributions.changed` per extension and tick. */
  #contributionsChanged(accountId: string, id: string): void {
    const key = `${accountId}\n${id}`;
    if (this.#pendingNotices.has(key) || this.#closed) return;
    const t = setImmediate(() => {
      this.#pendingNotices.delete(key);
      try {
        this.#o.events?.emitEphemeral({
          name: 'extension.contributions.changed',
          actor: 'system',
          accountId,
          payload: { extensionId: id },
        });
      } catch (err) {
        this.#log.warn('extension event failed', { err });
      }
    });
    this.#pendingNotices.set(key, t);
  }

  async #emitStatus(accountId: string, id: string): Promise<void> {
    const s = this.host.status(accountId, id);
    await Promise.resolve(
      this.#o.events?.emit({
        name: 'extension.status.changed',
        actor: 'system',
        accountId,
        payload: { extensionId: id, status: s.status, error: s.error },
      }),
    ).catch((err: unknown) => this.#log.warn('extension event failed', { err }));
  }

  async #emit(accountId: string, id: string, change: string): Promise<void> {
    await Promise.resolve(
      this.#o.events?.emit({
        name: 'extension.changed',
        actor: 'user',
        accountId,
        payload: { extensionId: id, change },
      }),
    ).catch((err: unknown) => this.#log.warn('extension event failed', { err }));
  }

  async #audit(
    accountId: string,
    action: string,
    id: string,
    detail: Record<string, unknown>,
    actor = 'user',
    kind: 'plugin' | 'secret' = 'plugin',
  ): Promise<void> {
    await this.#o.audit
      ?.append({ accountId, actor, kind, action, resource: `ext:${id}`, detail })
      .catch((err: unknown) => this.#log.warn('extension audit failed', { err }));
  }

  /** For GET /diagnostics. */
  diagnostics(): { installed: number; running: number; previews: number } {
    const rows = this.#db.raw
      .prepare('SELECT account_id AS accountId, plugin_id AS pluginId FROM extension_install')
      .all() as { accountId: string; pluginId: string }[];
    return {
      installed: rows.length,
      running: rows.filter((r) => this.host.status(r.accountId, r.pluginId).status === 'running')
        .length,
      previews: this.#previews.size,
    };
  }
}

/**
 * The files of an installed extension as a bundle would hold them: the folder the plugin installer
 * writes converted commands into is left out (a plugin may not bring it, docs/08 §3.1).
 */
function installedFiles(root: string): Map<string, Uint8Array> {
  const files = folderBundleFiles(root);
  for (const path of [...files.keys()])
    if (path.startsWith('.nova-plugin/commands/')) files.delete(path);
  return files;
}
