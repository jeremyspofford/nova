// The marketplace (FR-049; docs/14 §5, docs/08 §7; ADR-097 D2, D4): browse and search every
// catalog source, preview an item (its artifact fetched, staged in the Hub's own folder, checked
// and inspected), install it, update it with the permission diff, remove it, and rate it.
//
// Verification: a catalog whose signature is invalid, or that pins a key and is not signed, is
// refused outright, and so is a bundle whose signature does not match its files. An item is
// Verified when its catalog index is signed by a key the catalog pins or a trusted publisher, the
// index lists its checksum and the artifact matches it, and (for a `.novax` bundle) the bundle is
// signed by a key in the trusted publishers: the catalog never vouches for a bundle's signer, the
// same rule the extension installer applies. An extension shipped as a folder or zip is never
// Verified. Anything else is Unverified: it installs only with the explicit sideload
// confirmation, never when managed policy forbids unverified installs or the owner turned
// sideloading off, and stays labelled Unverified. An untrusted signer is shown by its key's
// fingerprint, never by the name a catalog claims for it.
//
// Installs and removals run one at a time. An update that adds or changes a permission needs the
// diff's hash echoed back, and an extension update by another publisher (or none) needs
// `acceptPublisherChange`. A failed install puts back what it replaced (each installer's
// snapshot) and is audited; nothing about installs or ratings leaves the Hub.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type MarketCatalogView,
  type MarketInstallView,
  type MarketItemDetail,
  type MarketItemKind,
  type MarketItemView,
  type MarketPermissionDiff,
  type MarketPermissionLine,
  type MarketPreview,
  type MarketPublisher,
  type MarketRatingView,
  type MarketUnverifiedReason,
  type marketInstallSchema,
  type marketPreviewSchema,
  type marketRatingSchema,
  type marketSearchSchema,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { z } from 'zod';
import type { EventSink } from '../events.ts';
import { copyTree, walkTree } from '../plugins/paths.ts';
import type { AuditSink } from '../tools/types.ts';
import {
  compareVersions,
  expectedChecksum,
  pickMarketEntry,
  type MarketIndexEntry,
} from './catalog-index.ts';
import { isExtensionFolder } from '../sdk/manifest.ts';
import type { MarketInspection, MarketInstaller, StagedArtifact } from './installers.ts';
import { verifyBundle, type BundleCheck } from '../sdk/bundle.ts';
import { readArchive, writeArchive } from './archive.ts';
import {
  diffNeedsAcceptance,
  mcpPermissionLines,
  permissionDiff,
  pluginPermissionLines,
} from './permissions.ts';
import {
  folderDigest,
  publisherView,
  sha256Hex,
  verifyCatalogIndex,
  type CatalogSignatureCheck,
  type TrustedPublisherKey,
} from './signing.ts';
import {
  marketCatalogKind,
  type CatalogRead,
  type FetchedArtifact,
  type MarketCatalogConfig,
  type MarketSources,
} from './sources.ts';

const { marketInstall, marketRating } = schema;
type InstallRow = typeof marketInstall.$inferSelect;
type RatingRow = typeof marketRating.$inferSelect;

/** Previews expire after 30 minutes, like plugin previews (hub-api M4). */
export const MARKET_PREVIEW_TTL_MS = 30 * 60_000;
const MAX_PREVIEWS = 50;
const SCREENSHOT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
/** Where each kind's root is found inside an unpacked archive. */
const ROOT_MARKER: Partial<Record<MarketItemKind, string>> = {
  plugin: '.nova-plugin/plugin.json',
  skill: 'SKILL.md',
  pet: 'pet.json',
};

export type MarketSearchRequest = z.input<typeof marketSearchSchema>;
export type MarketPreviewRequest = z.infer<typeof marketPreviewSchema>;
export type MarketInstallRequestBody = z.input<typeof marketInstallSchema>;
export type MarketRatingRequest = z.infer<typeof marketRatingSchema>;

/** What policy allows (managed policy, D4, and the owner's own market settings). */
export interface MarketPolicy {
  /** Managed policy's `restrict.unverifiedInstalls`: false forbids every Unverified install. */
  unverifiedAllowed(): Promise<boolean>;
  /** The owner's `market.allowSideload`: false refuses Unverified installs too. */
  sideloadEnabled(): Promise<boolean>;
  /** `market.allowedKinds`. */
  allowedKinds(): Promise<readonly MarketItemKind[]>;
  /** Managed policy's allow and deny lists (`restrict.plugins`): why this item is refused. */
  itemRefused?(kind: MarketItemKind, id: string): Promise<string | null>;
}

export const OPEN_MARKET_POLICY: MarketPolicy = {
  unverifiedAllowed: () => Promise.resolve(true),
  sideloadEnabled: () => Promise.resolve(true),
  allowedKinds: () => Promise.resolve(['plugin', 'skill', 'theme', 'pet', 'mcp']),
};

export interface MarketplaceOptions {
  db: NovaDatabase;
  sources: MarketSources;
  /** Every catalog: the built-in one (pinned key) first, then the owner's `plugins.catalogs`. */
  catalogConfigs: () => Promise<MarketCatalogConfig[]>;
  /** `plugins.trustedPublishers` (D2). */
  trustedPublishers: () => Promise<TrustedPublisherKey[]>;
  installers: Partial<Record<MarketItemKind, MarketInstaller>>;
  /** Staged artifacts and backups (`<dataDir>/cache/market`). */
  workDir: string;
  policy?: MarketPolicy;
  events?: EventSink;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  previewTtlMs?: number;
}

interface PreviewRecord {
  id: string;
  accountId: string;
  catalogId: string;
  entry: MarketIndexEntry;
  artifact: StagedArtifact;
  inspection: MarketInspection;
  verified: boolean;
  reasons: MarketUnverifiedReason[];
  publisher: MarketPublisher | null;
  sha256: string | null;
  commit: string | null;
  diff: MarketPermissionDiff | null;
  /** What was installed when the preview was made (an install between them is a conflict). */
  before: string;
  expiresAt: number;
}

interface ListingContext {
  trusted: TrustedPublisherKey[];
  records: Map<string, InstallRow>;
  installed: Map<string, string | null>;
  ratings: Map<string, MarketRatingView>;
}

interface CatalogState {
  config: MarketCatalogConfig;
  read: CatalogRead | null;
  check: CatalogSignatureCheck | null;
  error: string | null;
}

function refused(reason: string, message: string, extra: Record<string, unknown> = {}): NovaError {
  return new NovaError('policy_denied', message, { details: { reason, ...extra } });
}

function stateKey(
  s: { version: string | null; permissions: MarketPermissionLine[] } | null,
): string {
  if (!s) return 'none';
  return JSON.stringify([s.version, s.permissions.map((l) => [l.key, l.detail])]);
}

export class Marketplace {
  readonly #o: MarketplaceOptions;
  readonly #db: NovaDatabase;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #policy: MarketPolicy;
  readonly #previews = new Map<string, PreviewRecord>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(opts: MarketplaceOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#log = opts.log ?? new Logger({ module: 'core.market', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#policy = opts.policy ?? OPEN_MARKET_POLICY;
    // Staged artifacts do not survive a restart.
    rmSync(join(opts.workDir, 'staging'), { recursive: true, force: true });
    rmSync(join(opts.workDir, 'backups'), { recursive: true, force: true });
  }

  get backupsDir(): string {
    return join(this.#o.workDir, 'backups');
  }

  // ---- catalogs ---------------------------------------------------------------------------------

  async #state(c: MarketCatalogConfig, trusted: TrustedPublisherKey[]): Promise<CatalogState> {
    try {
      const read = await this.#o.sources.read(c);
      const check = verifyCatalogIndex(read.indexBytes, read.signature, {
        pinned: c.publisherKey ?? null,
        trusted,
      });
      return { config: c, read, check, error: check.status === 'invalid' ? check.reason : null };
    } catch (err) {
      return {
        config: c,
        read: null,
        check: null,
        error: err instanceof Error ? err.message : 'unreadable',
      };
    }
  }

  async #states(catalogId?: string): Promise<CatalogState[]> {
    const trusted = await this.#o.trustedPublishers();
    const out: CatalogState[] = [];
    for (const c of await this.#o.catalogConfigs())
      if (!catalogId || c.id === catalogId) out.push(await this.#state(c, trusted));
    return out;
  }

  async #usable(
    catalogId: string,
    accountId: string,
  ): Promise<CatalogState & { read: CatalogRead; check: CatalogSignatureCheck }> {
    const [s] = await this.#states(catalogId);
    if (!s) throw new NovaError('not_found', `catalog ${catalogId} not found`);
    if (!s.read || !s.check)
      throw new NovaError(
        'validation',
        `${s.config.name} could not be read: ${s.error ?? 'error'}`,
      );
    if (s.check.status === 'invalid') {
      await this.#audit(
        accountId,
        'market.refuse',
        `catalog:${catalogId}`,
        {
          reason: 'catalog_signature_invalid',
          why: s.check.reason,
        },
        'denied',
      );
      throw new NovaError(
        'validation',
        `${s.config.name} is refused: ${s.check.reason ?? 'bad signature'}`,
        {
          details: { reason: 'catalog_signature_invalid', catalogId },
        },
      );
    }
    return s as CatalogState & { read: CatalogRead; check: CatalogSignatureCheck };
  }

  async catalogs(): Promise<MarketCatalogView[]> {
    return (await this.#states()).map((s) => ({
      id: s.config.id,
      name: s.config.name,
      location: s.config.location,
      kind: marketCatalogKind(s.config),
      signature: s.check?.status ?? 'unsigned',
      publisher: s.check?.publisher ?? null,
      commit: s.read?.commit ?? null,
      items: s.check?.status === 'invalid' ? 0 : (s.read?.index.entries.length ?? 0),
      error: s.error,
    }));
  }

  // ---- browse -----------------------------------------------------------------------------------

  async search(accountId: string, req: MarketSearchRequest = {}): Promise<MarketItemView[]> {
    const needle = (req.q ?? '').trim().toLowerCase();
    const ctx = await this.#listingContext(accountId);
    const out: MarketItemView[] = [];
    for (const s of await this.#states(req.catalogId)) {
      if (!s.read || !s.check || s.check.status === 'invalid') continue;
      const latest = new Map<string, MarketIndexEntry>();
      for (const e of s.read.index.entries) {
        if (req.kind && e.kind !== req.kind) continue;
        const k = `${e.kind}\n${e.id}`;
        const have = latest.get(k);
        if (!have || compareVersions(e.version, have.version) > 0) latest.set(k, e);
      }
      for (const e of latest.values()) {
        const hay =
          `${e.id} ${e.name} ${e.description ?? ''} ${e.author ?? ''} ${(e.categories ?? []).join(' ')}`.toLowerCase();
        if (needle && !hay.includes(needle)) continue;
        out.push(this.#itemView(s, e, ctx));
      }
    }
    return out.sort((a, b) =>
      a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind < b.kind ? -1 : 1,
    );
  }

  async item(
    accountId: string,
    catalogId: string,
    kind: MarketItemKind,
    id: string,
  ): Promise<MarketItemDetail> {
    const s = await this.#usable(catalogId, accountId);
    const all = s.read.index.entries.filter((e) => e.kind === kind && e.id === id);
    const e = pickMarketEntry(all, kind, id);
    if (!e) throw new NovaError('not_found', `${id} is not in ${s.config.name}`);
    const ctx = await this.#listingContext(accountId);
    return {
      ...this.#itemView(s, e, ctx),
      versions: all.map((x) => x.version).sort((a, b) => compareVersions(b, a)),
      changelog: (e.changelog ?? []).map((c) => ({
        version: c.version,
        date: c.date ?? null,
        notes: c.notes,
      })),
      components: {
        hooks: e.components?.hooks ?? [],
        roles: e.components?.roles ?? [],
        browserExtensions: e.components?.browserExtensions ?? [],
        uiEntryPoints: (e.components?.uiEntryPoints ?? []).map((u) => ({
          kind: u.kind,
          title: u.title ?? null,
        })),
      },
      sha256: expectedChecksum(e),
      commit: e.commit ?? s.read.commit,
    };
  }

  /** A screenshot the catalog lists for an item (PNG, JPEG or WebP, at most 2 MB). */
  async screenshot(
    accountId: string,
    catalogId: string,
    kind: MarketItemKind,
    id: string,
    n: number,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const s = await this.#usable(catalogId, accountId);
    const e = pickMarketEntry(s.read.index.entries, kind, id);
    const rel = e?.screenshots?.[n];
    if (!rel) throw new NovaError('not_found', 'screenshot not found');
    const contentType = SCREENSHOT_TYPES[extname(rel).toLowerCase()];
    if (!contentType) throw new NovaError('validation', 'screenshots must be PNG, JPEG or WebP');
    return { bytes: await this.#o.sources.file(s.read, rel), contentType };
  }

  async #listingContext(accountId: string): Promise<ListingContext> {
    const records = new Map(
      (await this.#records(accountId)).map((r) => [`${r.kind}\n${r.itemId}`, r]),
    );
    const installed = new Map<string, string | null>();
    for (const [kind, inst] of Object.entries(this.#o.installers)) {
      try {
        for (const [id, v] of await inst.list(accountId)) installed.set(`${kind}\n${id}`, v);
      } catch (err) {
        this.#log.warn('installed items unreadable', {
          kind,
          err: err instanceof Error ? err.message : err,
        });
      }
    }
    const ratings = new Map(
      (await this.#ratingRows(accountId)).map((r) => [`${r.kind}\n${r.itemId}`, ratingView(r)]),
    );
    return { trusted: await this.#o.trustedPublishers(), records, installed, ratings };
  }

  #itemView(s: CatalogState, e: MarketIndexEntry, ctx: ListingContext): MarketItemView {
    const key = `${e.kind}\n${e.id}`;
    const record = ctx.records.get(key) ?? null;
    const present = ctx.installed.has(key);
    const installedVersion = present ? (ctx.installed.get(key) ?? record?.version ?? null) : null;
    const updateAvailable =
      present &&
      ((installedVersion !== null && compareVersions(e.version, installedVersion) > 0) ||
        // Same version, other bytes: a moved Git ref or a republished item (docs/08 §7).
        (record !== null &&
          record.catalogId === s.config.id &&
          record.version === e.version &&
          !!expectedChecksum(e) &&
          !!record.sha256 &&
          expectedChecksum(e) !== record.sha256));
    const catalogVerified = s.check?.status === 'verified';
    return {
      catalogId: s.config.id,
      kind: e.kind,
      id: e.id,
      name: e.name,
      version: e.version,
      description: e.description ?? null,
      // The item's own author only: who signed it is the publisher line, which is trust-aware.
      author: e.author ?? null,
      publisher: e.publisher?.key
        ? publisherView(e.publisher.key, ctx.trusted)
        : (s.check?.publisher ?? null),
      categories: e.categories ?? [],
      verified: catalogVerified && (!!expectedChecksum(e) || (!!e.server && !e.path && !e.url)),
      permissions: declaredLines(e),
      screenshots: e.screenshots?.length ?? 0,
      homepage: e.homepage ?? null,
      installedVersion: present ? (installedVersion ?? e.version) : null,
      updateAvailable,
      rating: ctx.ratings.get(key) ?? null,
    };
  }

  // ---- preview ----------------------------------------------------------------------------------

  async preview(accountId: string, req: MarketPreviewRequest): Promise<MarketPreview> {
    this.sweep();
    const installer = this.#o.installers[req.kind];
    if (!installer)
      throw new NovaError(
        'capability_missing',
        `installing ${req.kind} items is not available on this Hub`,
        {
          details: { reason: 'installer_missing', kind: req.kind },
        },
      );
    const s = await this.#usable(req.catalogId, accountId);
    const entry = pickMarketEntry(s.read.index.entries, req.kind, req.id, req.version);
    if (!entry)
      throw new NovaError(
        'not_found',
        `${req.id}${req.version ? `@${req.version}` : ''} is not in ${s.config.name}`,
      );
    const trusted = await this.#o.trustedPublishers();
    const fetched = await this.#o.sources.artifact(s.read, entry);
    const id = uuidv7();
    const dir = join(this.#o.workDir, 'staging', id);
    try {
      const staged = this.#stage(fetched, req.kind, dir, trusted);
      if (staged.bundle?.status === 'invalid') {
        // A bundle whose signature does not match its contents is refused, sideload or not.
        await this.#audit(
          accountId,
          'market.refuse',
          `market:${req.kind}:${entry.id}`,
          {
            reason: 'bundle_invalid',
            why: staged.bundle.message,
          },
          'denied',
        );
        throw new NovaError(
          'validation',
          `${entry.name} is refused: ${staged.bundle.message ?? 'bad signature'}`,
          {
            details: { reason: 'bundle_invalid', bundle: staged.bundle.reason },
          },
        );
      }
      const reasons: MarketUnverifiedReason[] = [];
      if (s.check.status === 'unsigned') reasons.push('catalog_unsigned');
      if (s.check.status === 'untrusted') reasons.push('catalog_untrusted');
      if (staged.artifact.format !== 'registry') {
        const expected = expectedChecksum(entry);
        if (!expected) reasons.push('no_checksum');
        else if (expected !== staged.sha256) reasons.push('checksum_mismatch');
      }
      let publisher = s.check.publisher;
      const inspectionWarnings: string[] = [];
      if (staged.bundle) {
        // A bundle needs its publisher's signature by a key the owner trusts (docs/08 §7), the
        // same rule the extension installer applies, so both give the same verdict.
        const b = staged.bundle;
        if (b.reason === 'unsigned') reasons.push('bundle_unsigned');
        if (b.reason === 'untrusted') reasons.push('bundle_untrusted');
        if (b.publisher) {
          // The name a catalog claims for a key is never shown as the publisher's.
          publisher = publisherView(b.publisher, trusted);
          if (!publisher.trusted)
            inspectionWarnings.push(
              `Signed by a publisher you have not trusted (key ${publisher.fingerprint}); the name the catalog gives it is not checked.`,
            );
        }
      } else if (
        req.kind === 'plugin' &&
        staged.artifact.dir &&
        isExtensionFolder(staged.artifact.dir)
      ) {
        // An extension runs code: only a signed `.novax` can be Verified, never a folder or zip.
        reasons.push('bundle_unsigned');
      }
      const inspection = await installer.inspect(accountId, staged.artifact, entry);
      if (inspection.id !== entry.id)
        throw new NovaError(
          'validation',
          `the item is ${inspection.id}, but the catalog lists it as ${entry.id}`,
        );
      if (inspection.version !== null && inspection.version !== entry.version)
        throw new NovaError(
          'validation',
          `the item is version ${inspection.version}, but the catalog lists ${entry.version}`,
        );
      const installed = await installer.installed(accountId, entry.id);
      const record = await this.#record(accountId, req.kind, entry.id);
      const diff = installed
        ? permissionDiff(
            {
              version: installed.version ?? record?.version ?? 'installed',
              lines: installed.permissions,
            },
            { version: entry.version, lines: inspection.permissions },
          )
        : null;
      const publisherChange = inspection.publisherChange ?? null;
      // A change of publisher is said first (the extension installer's warning leads its list).
      const warnings = publisherChange
        ? [...inspection.warnings, ...inspectionWarnings]
        : [...inspectionWarnings, ...inspection.warnings];
      const declared = declaredLines(entry);
      if (declared.length && !sameKeys(declared, inspection.permissions) && req.kind === 'plugin')
        warnings.push(
          'The catalog lists other permissions than the item declares; the item’s own are shown here.',
        );
      const verified = reasons.length === 0;
      const block = await this.#blocked(req.kind, entry.id, verified);
      if (block.why && block.by === 'managed') warnings.push(block.why);
      const expiresAt = this.#now().getTime() + (this.#o.previewTtlMs ?? MARKET_PREVIEW_TTL_MS);
      if (this.#previews.size >= MAX_PREVIEWS) {
        const oldest = [...this.#previews.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
        if (oldest) this.#drop(oldest.id);
      }
      this.#previews.set(id, {
        id,
        accountId,
        catalogId: s.config.id,
        entry,
        artifact: staged.artifact,
        inspection,
        verified,
        reasons,
        publisher,
        sha256: staged.sha256,
        commit: fetched.commit ?? entry.commit ?? null,
        diff,
        before: stateKey(installed),
        expiresAt,
      });
      return {
        previewId: id,
        catalogId: s.config.id,
        kind: req.kind,
        id: entry.id,
        name: inspection.name ?? entry.name,
        version: entry.version,
        verification: {
          status: verified ? 'verified' : 'unverified',
          reasons,
          publisher,
          // Who vouches, said by name rather than a bare key: the catalog (a pinned key verifies
          // only that catalog's index), and a bundle's own trusted signer.
          vouchedBy: verified
            ? {
                catalog: {
                  id: s.config.id,
                  name: s.config.name,
                  signedWith: s.config.publisherKey ? 'pinned_key' : 'trusted_publisher',
                  publisher: s.check.publisher,
                },
                bundle: staged.bundle?.publisher
                  ? publisherView(staged.bundle.publisher, trusted)
                  : null,
              }
            : null,
        },
        permissions: inspection.permissions,
        diff,
        publisherChange,
        replaces: installed
          ? { version: installed.version ?? record?.version ?? 'installed' }
          : null,
        requires: {
          sideloadConfirmation: !verified,
          permissionAcceptance: diffNeedsAcceptance(diff),
          publisherChangeAcceptance: publisherChange !== null,
        },
        allowed: block.by === null,
        blockedBy: block.by,
        details: inspection.details,
        warnings,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async #blocked(
    kind: MarketItemKind,
    id: string,
    verified: boolean,
  ): Promise<{ by: MarketPreview['blockedBy']; why: string | null }> {
    if (!(await this.#policy.allowedKinds()).includes(kind))
      return { by: 'kind_not_allowed', why: `installing ${kind} items is turned off` };
    const refusedItem = (await this.#policy.itemRefused?.(kind, id)) ?? null;
    if (refusedItem) return { by: 'managed', why: refusedItem };
    if (!verified && !(await this.#policy.unverifiedAllowed()))
      return { by: 'managed', why: 'your organization does not allow installing unverified items' };
    if (!verified && !(await this.#policy.sideloadEnabled()))
      return {
        by: 'sideload_disabled',
        why: 'installing unverified items is turned off in Settings',
      };
    return { by: null, why: null };
  }

  /** Copy or unpack an artifact into the Hub's own staging folder and checksum it there. */
  #stage(
    fetched: FetchedArtifact,
    kind: MarketItemKind,
    dir: string,
    trusted: readonly TrustedPublisherKey[],
  ): {
    artifact: StagedArtifact;
    sha256: string | null;
    bundle: BundleCheck | null;
  } {
    const root = join(dir, 'root');
    if ('server' in fetched)
      return {
        artifact: { format: 'registry', dir: null, bytes: null, server: fetched.server },
        sha256: null,
        bundle: null,
      };
    if ('dir' in fetched) {
      const entries = walkTree(fetched.dir);
      copyTree(entries, root);
      return {
        artifact: { format: fetched.format, dir: root, bytes: null, server: null },
        sha256: folderDigest(root),
        bundle: null,
      };
    }
    const sha256 = sha256Hex(fetched.bytes);
    if (fetched.format === 'novax') {
      const bundle = verifyBundle(fetched.bytes, { trusted });
      if (bundle.status === 'invalid')
        return {
          artifact: { format: 'novax', dir: null, bytes: null, server: null },
          sha256,
          bundle,
        };
      writeArchive(bundle.files, root);
      return {
        artifact: {
          format: 'novax',
          dir: this.#rootOf(root, kind),
          bytes: fetched.bytes,
          server: null,
        },
        sha256,
        bundle,
      };
    }
    if (fetched.format === 'zip') {
      writeArchive(readArchive(fetched.bytes), root);
      return {
        artifact: { format: 'zip', dir: this.#rootOf(root, kind), bytes: null, server: null },
        sha256,
        bundle: null,
      };
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return {
      artifact: { format: fetched.format, dir: null, bytes: fetched.bytes, server: null },
      sha256,
      bundle: null,
    };
  }

  /** The item's root in an unpacked archive: the archive root or its single top folder. */
  #rootOf(root: string, kind: MarketItemKind): string {
    const marker = ROOT_MARKER[kind];
    if (!marker || existsSync(join(root, marker))) return root;
    const tops = readdirSync(root);
    if (tops.length === 1 && existsSync(join(root, tops[0]!, marker))) return join(root, tops[0]!);
    throw new NovaError('validation', `the archive has no ${marker}`);
  }

  // ---- install, update, remove ------------------------------------------------------------------

  install(accountId: string, body: MarketInstallRequestBody): Promise<MarketInstallView> {
    return this.#serial(() => this.#install(accountId, body));
  }

  async #install(accountId: string, body: MarketInstallRequestBody): Promise<MarketInstallView> {
    this.sweep();
    const p = this.#previews.get(body.previewId);
    if (!p || p.accountId !== accountId)
      throw new NovaError('request_expired', 'the preview expired; preview the item again');
    const { entry } = p;
    const kind = entry.kind;
    const installer = this.#o.installers[kind];
    if (!installer)
      throw new NovaError(
        'capability_missing',
        `installing ${kind} items is not available on this Hub`,
      );
    const resource = `market:${kind}:${entry.id}`;
    // Policy is checked again: it may have changed since the preview.
    const block = await this.#blocked(kind, entry.id, p.verified);
    if (block.by) {
      await this.#audit(
        accountId,
        'market.refuse',
        resource,
        { reason: block.by, reasons: p.reasons },
        'denied',
      );
      throw refused(block.by, block.why ?? 'refused by policy');
    }
    if (!p.verified && body.confirmSideload !== true)
      throw new NovaError(
        'validation',
        'this item is not verified; confirm that you want to install it unverified',
        {
          details: {
            field: 'confirmSideload',
            reason: 'sideload_confirmation_required',
            reasons: p.reasons,
          },
        },
      );
    const publisherChange = p.inspection.publisherChange ?? null;
    if (publisherChange && body.acceptPublisherChange !== true)
      throw new NovaError(
        'validation',
        'this update comes from another publisher than the installed version; accept the change to install it (its secrets and data are cleared)',
        {
          details: {
            field: 'acceptPublisherChange',
            reason: 'publisher_change_confirmation_required',
            from: publisherChange.from.key,
            to: publisherChange.to.key,
          },
        },
      );
    if (diffNeedsAcceptance(p.diff) && body.acceptPermissions !== p.diff!.hash)
      throw new NovaError(
        'validation',
        'accept the permission changes of this update to install it',
        {
          details: {
            field: 'acceptPermissions',
            reason: 'permission_diff_not_accepted',
            diffHash: p.diff!.hash,
          },
        },
      );
    const current = await installer.installed(accountId, entry.id);
    if (stateKey(current) !== p.before)
      throw new NovaError(
        'conflict',
        'what is installed changed since the preview; preview the item again',
      );

    const previous = await this.#record(accountId, kind, entry.id);
    const origin = `${p.catalogId}/${entry.id}@${entry.version}${p.commit ? `#${p.commit}` : ''}`;
    const restore = await installer.snapshot(accountId, entry.id);
    const now = this.#now().toISOString();
    const row: InstallRow = {
      id: previous?.id ?? uuidv7(),
      accountId,
      kind,
      itemId: entry.id,
      name: p.inspection.name ?? entry.name,
      version: entry.version,
      catalogId: p.catalogId,
      origin,
      signature: p.verified ? 'verified' : 'unverified',
      publisherKey: p.publisher?.key ?? null,
      sha256: p.sha256,
      commitSha: p.commit,
      permissionsJson: JSON.stringify(p.inspection.permissions),
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };
    try {
      await installer.install({
        accountId,
        entry,
        artifact: p.artifact,
        inspection: p.inspection,
        verified: p.verified,
        publisher: p.publisher?.key ?? null,
        catalogId: p.catalogId,
        origin,
        enable: body.enable ?? true,
        ...(body.trustHooks ? { trustHooks: body.trustHooks } : {}),
        ...(body.userConfig ? { userConfig: body.userConfig } : {}),
        ...(publisherChange ? { acceptPublisherChange: true } : {}),
      });
      await this.#db.transaction(async () => {
        if (previous)
          await this.#db.orm
            .update(marketInstall)
            .set(row)
            .where(eq(marketInstall.id, previous.id));
        else await this.#db.orm.insert(marketInstall).values(row);
      });
    } catch (err) {
      let rolledBack = true;
      try {
        await restore();
      } catch (rerr) {
        rolledBack = false;
        this.#log.error('market rollback failed', {
          kind,
          itemId: entry.id,
          err: rerr instanceof Error ? rerr.message : rerr,
        });
      }
      await this.#audit(
        accountId,
        'market.install.failed',
        resource,
        {
          version: entry.version,
          previousVersion: current?.version ?? previous?.version ?? null,
          rolledBack,
          error: err instanceof Error ? err.message.slice(0, 300) : 'error',
        },
        'failed',
      );
      throw err;
    }
    this.#drop(p.id);
    const update = current !== null;
    await this.#o.events?.emit({
      name: update ? 'market.updated' : 'market.installed',
      actor: 'user',
      accountId,
      payload: {
        kind,
        itemId: entry.id,
        version: entry.version,
        verified: p.verified,
        catalogId: p.catalogId,
      },
    });
    await this.#audit(accountId, update ? 'market.update' : 'market.install', resource, {
      version: entry.version,
      previousVersion: update ? (current.version ?? previous?.version ?? null) : null,
      catalogId: p.catalogId,
      origin,
      verified: p.verified,
      ...(p.verified ? {} : { sideload: true, reasons: p.reasons }),
      publisherKey: p.publisher?.key ?? null,
      sha256: p.sha256,
      ...(publisherChange
        ? { publisherChange: { from: publisherChange.from.key, to: publisherChange.to.key } }
        : {}),
      ...(p.diff
        ? {
            permissionsAdded: p.diff.added.map((l) => l.key),
            permissionsChanged: p.diff.changed.map((c) => c.key),
            permissionsRemoved: p.diff.removed.map((l) => l.key),
          }
        : { permissions: p.inspection.permissions.map((l) => l.key) }),
    });
    return installView(row);
  }

  remove(accountId: string, kind: MarketItemKind, id: string): Promise<void> {
    return this.#serial(async () => {
      const installer = this.#o.installers[kind];
      if (!installer)
        throw new NovaError('capability_missing', `${kind} items are not available on this Hub`);
      const record = await this.#record(accountId, kind, id);
      const installed = await installer.installed(accountId, id);
      if (!installed && !record) throw new NovaError('not_found', `${id} is not installed`);
      if (installed) await installer.remove(accountId, id);
      if (record)
        await this.#db.transaction(async () => {
          await this.#db.orm.delete(marketInstall).where(eq(marketInstall.id, record.id));
        });
      await this.#o.events?.emit({
        name: 'market.removed',
        actor: 'user',
        accountId,
        payload: { kind, itemId: id, version: record?.version ?? installed?.version ?? null },
      });
      await this.#audit(accountId, 'market.remove', `market:${kind}:${id}`, {
        version: record?.version ?? installed?.version ?? null,
      });
    });
  }

  async installed(accountId: string): Promise<MarketInstallView[]> {
    return (await this.#records(accountId)).map(installView);
  }

  // ---- ratings (kept on the Hub) ----------------------------------------------------------------

  async rate(accountId: string, req: MarketRatingRequest): Promise<MarketRatingView> {
    const now = this.#now().toISOString();
    const [have] = await this.#db.orm
      .select()
      .from(marketRating)
      .where(
        and(
          eq(marketRating.accountId, accountId),
          eq(marketRating.kind, req.kind),
          eq(marketRating.itemId, req.itemId),
        ),
      );
    const row: RatingRow = {
      id: have?.id ?? uuidv7(),
      accountId,
      kind: req.kind,
      itemId: req.itemId,
      stars: req.stars,
      review: req.review?.trim() || null,
      createdAt: have?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#db.transaction(async () => {
      if (have)
        await this.#db.orm.update(marketRating).set(row).where(eq(marketRating.id, have.id));
      else await this.#db.orm.insert(marketRating).values(row);
    });
    return ratingView(row);
  }

  async unrate(accountId: string, kind: MarketItemKind, itemId: string): Promise<void> {
    await this.#db.transaction(async () => {
      await this.#db.orm
        .delete(marketRating)
        .where(
          and(
            eq(marketRating.accountId, accountId),
            eq(marketRating.kind, kind),
            eq(marketRating.itemId, itemId),
          ),
        );
    });
  }

  async ratings(accountId: string): Promise<MarketRatingView[]> {
    return (await this.#ratingRows(accountId)).map(ratingView);
  }

  // ---- housekeeping -----------------------------------------------------------------------------

  /** Drop expired previews and their staged files. */
  sweep(): void {
    const now = this.#now().getTime();
    for (const [id, p] of this.#previews) if (p.expiresAt <= now) this.#drop(id);
  }

  close(): void {
    for (const id of [...this.#previews.keys()]) this.#drop(id);
  }

  #drop(id: string): void {
    this.#previews.delete(id);
    rmSync(join(this.#o.workDir, 'staging', id), { recursive: true, force: true });
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #records(accountId: string): Promise<InstallRow[]> {
    const rows = await this.#db.orm
      .select()
      .from(marketInstall)
      .where(eq(marketInstall.accountId, accountId));
    return rows.sort((a, b) =>
      a.kind === b.kind ? (a.itemId < b.itemId ? -1 : 1) : a.kind < b.kind ? -1 : 1,
    );
  }

  async #record(
    accountId: string,
    kind: MarketItemKind,
    itemId: string,
  ): Promise<InstallRow | null> {
    const [row] = await this.#db.orm
      .select()
      .from(marketInstall)
      .where(
        and(
          eq(marketInstall.accountId, accountId),
          eq(marketInstall.kind, kind),
          eq(marketInstall.itemId, itemId),
        ),
      );
    return row ?? null;
  }

  async #ratingRows(accountId: string): Promise<RatingRow[]> {
    return this.#db.orm.select().from(marketRating).where(eq(marketRating.accountId, accountId));
  }

  async #audit(
    accountId: string,
    action: string,
    resource: string,
    detail: Record<string, unknown>,
    decision: string | null = null,
  ): Promise<void> {
    try {
      await this.#o.audit?.append({
        accountId,
        actor: 'user',
        kind: 'plugin',
        action,
        resource,
        ...(decision ? { decision } : {}),
        detail,
      });
    } catch (err) {
      this.#log.warn('market audit failed', {
        action,
        err: err instanceof Error ? err.message : err,
      });
    }
  }
}

/** The permissions a catalog lists for an entry (the card; the preview reads the item's own). */
function declaredLines(e: MarketIndexEntry): MarketPermissionLine[] {
  if (e.kind === 'mcp' && e.server) return mcpPermissionLines(e.server);
  if (!e.permissions && !e.components) return [];
  return pluginPermissionLines({
    ...(e.permissions ? { permissions: e.permissions } : {}),
    hooks: (e.components?.hooks ?? []).map((h) => ({ id: h.id, event: h.event })),
    roles: e.components?.roles ?? [],
    browserExtensions: e.components?.browserExtensions ?? [],
    uiEntryPoints: (e.components?.uiEntryPoints ?? []).map((u) => ({
      kind: u.kind,
      title: u.title ?? null,
    })),
  });
}

function sameKeys(a: readonly MarketPermissionLine[], b: readonly MarketPermissionLine[]): boolean {
  const kinds = new Set([
    'network',
    'fs',
    'secret',
    'tool',
    'action_default',
    'hooks_answer_asks',
    'browser_extension',
    'ui_domain',
  ]);
  const ka = a
    .filter((l) => kinds.has(l.kind))
    .map((l) => l.key)
    .sort();
  const kb = b
    .filter((l) => kinds.has(l.kind))
    .map((l) => l.key)
    .sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function installView(r: InstallRow): MarketInstallView {
  let permissions: MarketPermissionLine[];
  try {
    permissions = JSON.parse(r.permissionsJson) as MarketPermissionLine[];
  } catch {
    permissions = [];
  }
  return {
    kind: r.kind,
    itemId: r.itemId,
    name: r.name,
    version: r.version,
    catalogId: r.catalogId,
    origin: r.origin,
    verified: r.signature === 'verified',
    publisherKey: r.publisherKey,
    sha256: r.sha256,
    commit: r.commitSha,
    permissions,
    installedAt: r.installedAt,
    updatedAt: r.updatedAt,
  };
}

function ratingView(r: RatingRow): MarketRatingView {
  return {
    kind: r.kind,
    itemId: r.itemId,
    stars: r.stars,
    review: r.review,
    updatedAt: r.updatedAt,
    shared: false,
  };
}
