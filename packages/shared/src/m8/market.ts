// M8 marketplace (FR-049; docs/14 §5, docs/08 §7; ADR-097 D2): catalogs (the built-in sample
// catalog, folders on the Hub, Git catalogs pinned to a commit and remote catalogs over HTTPS),
// each with a signed index; items of five kinds; install, update with a permission diff, and
// remove; ratings kept on the Hub. Views and zod requests for /api/v1/market.
import { z } from 'zod';
import { idSchema } from '../api.ts';

/** The marketplace tabs (docs/14 §5). `mcp` holds registry entries and MCP bundles (FR-199). */
export const MARKET_KINDS = ['plugin', 'skill', 'theme', 'pet', 'mcp'] as const;
export type MarketItemKind = (typeof MARKET_KINDS)[number];

/** Where a catalog lives: shipped with Nova, a folder on the Hub, a Git repository, an https URL. */
export type MarketCatalogKind = 'builtin' | 'local' | 'git' | 'url';

/**
 * A catalog index's signature (D2: `"nova-catalog-v1\n" + sha256(index bytes)`, Ed25519):
 * `verified` by a key the catalog pins or a trusted publisher; `untrusted` when the signature is
 * good but the key is not trusted; `unsigned` without a signature file; `invalid` when the
 * signature does not verify, is damaged or comes from another key than the pinned one. An
 * `invalid` catalog is refused: nothing is listed or installed from it.
 */
export type MarketCatalogSignature = 'verified' | 'untrusted' | 'unsigned' | 'invalid';

export interface MarketPublisher {
  /**
   * The owner's name for a trusted key; null otherwise. A name a catalog claims for a key is
   * never shown as the publisher's.
   */
  name: string | null;
  /** base64url of the raw 32-byte Ed25519 public key. */
  key: string;
  /** First 16 hex characters of SHA-256 over the raw key, grouped for reading aloud. */
  fingerprint: string;
  /** In the trusted publishers, or the key this catalog pins. */
  trusted: boolean;
}

export interface MarketCatalogView {
  id: string;
  name: string;
  location: string;
  kind: MarketCatalogKind;
  signature: MarketCatalogSignature;
  publisher: MarketPublisher | null;
  /** The Git commit the index was read at (Git catalogs). */
  commit: string | null;
  items: number;
  /** Why the catalog could not be read or was refused. */
  error: string | null;
}

/**
 * One thing an item may do, in plain words (docs/14 §5 card: "This plugin can access: network →
 * api.github.com"). `key` is stable across versions so two lists can be compared.
 */
export interface MarketPermissionLine {
  key: string;
  kind:
    | 'network'
    | 'fs'
    | 'secret'
    | 'tool'
    | 'action_default'
    | 'hooks_answer_asks'
    | 'browser_extension'
    | 'ui_domain'
    | 'ui_entry'
    | 'hook'
    | 'role'
    | 'mcp_server'
    | 'program'
    | 'skill_tools'
    // An extension's own lines (FR-117), as the extension installer words them.
    | 'command'
    | 'panel'
    | 'event'
    | 'plugin';
  text: string;
  /** What can change between versions under the same key (a tool's default, a hook's command). */
  detail: string | null;
}

/** A permission diff on update (docs/14 §5): new, gone and changed lines, with its hash. */
export interface MarketPermissionDiff {
  fromVersion: string;
  toVersion: string;
  added: MarketPermissionLine[];
  removed: MarketPermissionLine[];
  changed: { key: string; text: string; before: string | null; after: string | null }[];
  /** SHA-256 over the canonical diff; the install request echoes it to accept the diff. */
  hash: string;
}

export interface MarketRatingView {
  kind: MarketItemKind;
  itemId: string;
  stars: number;
  review: string | null;
  updatedAt: string;
  /** Ratings stay on the Hub: no rating service exists, so nothing is ever sent. */
  shared: false;
}

export interface MarketItemView {
  catalogId: string;
  kind: MarketItemKind;
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  publisher: MarketPublisher | null;
  categories: string[];
  /**
   * The catalog vouches for the item (its index is signed by a trusted key and lists a checksum
   * for it). The artifact itself is checked again before install.
   */
  verified: boolean;
  /** The permissions the catalog lists for the item; the preview shows the item's own. */
  permissions: MarketPermissionLine[];
  screenshots: number;
  homepage: string | null;
  installedVersion: string | null;
  updateAvailable: boolean;
  rating: MarketRatingView | null;
}

export interface MarketItemDetail extends MarketItemView {
  versions: string[];
  changelog: { version: string; date: string | null; notes: string }[];
  components: {
    hooks: { id: string; event: string }[];
    roles: string[];
    browserExtensions: string[];
    uiEntryPoints: { kind: string; title: string | null }[];
  };
  sha256: string | null;
  commit: string | null;
}

/** One side of an extension's change of publisher (the extension installer's view of a key). */
export interface MarketPublisherSide {
  key: string | null;
  name: string | null;
  fingerprint: string | null;
  trusted: boolean;
}

/**
 * Why an item is Unverified (docs/08 §7). A bundle whose signature does not match its contents is
 * not Unverified but refused (`validation` `{reason: bundle_invalid}`), like a catalog whose index
 * signature is bad (`{reason: catalog_signature_invalid}`).
 */
export const MARKET_UNVERIFIED_REASONS = [
  'catalog_unsigned',
  'catalog_untrusted',
  'no_checksum',
  'checksum_mismatch',
  'bundle_unsigned',
  'bundle_untrusted',
] as const;
export type MarketUnverifiedReason = (typeof MARKET_UNVERIFIED_REASONS)[number];

/**
 * Who vouches for a Verified item (docs/08 §7), so the install dialog can say it rather than a
 * bare key: the catalog that lists it with its checksum, whose index is signed with the key the
 * catalog pins (`pinned_key`, as the built-in catalog is) or by a trusted publisher
 * (`trusted_publisher`, named); and for a `.novax` bundle the trusted publisher whose own
 * signature it carries (the catalog never vouches for a bundle's signer).
 */
export interface MarketVouch {
  catalog: {
    id: string;
    name: string;
    signedWith: 'pinned_key' | 'trusted_publisher';
    /** The key the index is signed with; named only when it is in the trusted publishers. */
    publisher: MarketPublisher | null;
  };
  /** The trusted publisher that signed the bundle; null for an item that is not a bundle. */
  bundle: MarketPublisher | null;
}

export interface MarketPreview {
  previewId: string;
  catalogId: string;
  kind: MarketItemKind;
  id: string;
  name: string;
  version: string;
  verification: {
    status: 'verified' | 'unverified';
    reasons: MarketUnverifiedReason[];
    publisher: MarketPublisher | null;
    /** What vouches for a Verified item; null when it is Unverified. */
    vouchedBy: MarketVouch | null;
  };
  /** The item's own permissions, read from the artifact. */
  permissions: MarketPermissionLine[];
  /** Set on an update: what changes against the installed version. */
  diff: MarketPermissionDiff | null;
  /**
   * An extension update signed by another publisher than the installed one (or by none): who it
   * was and who it is. Installing needs `acceptPublisherChange: true` and clears the extension's
   * secrets and data (FR-117).
   */
  publisherChange: { from: MarketPublisherSide; to: MarketPublisherSide } | null;
  replaces: { version: string } | null;
  requires: {
    /** Unverified: `confirmSideload: true` is needed (and allowed by policy). */
    sideloadConfirmation: boolean;
    /** The diff adds or changes something: `acceptPermissions: diff.hash` is needed. */
    permissionAcceptance: boolean;
    /** `publisherChange` is set: `acceptPublisherChange: true` is needed. */
    publisherChangeAcceptance: boolean;
  };
  /** False when policy refuses the install whatever is confirmed; `blockedBy` says why. */
  allowed: boolean;
  blockedBy: 'managed' | 'sideload_disabled' | 'kind_not_allowed' | null;
  /** Kind-specific preview details (a plugin's hooks, skills and servers; a theme's tokens). */
  details: Record<string, unknown>;
  warnings: string[];
  expiresAt: string;
}

export interface MarketInstallView {
  kind: MarketItemKind;
  itemId: string;
  name: string;
  version: string;
  catalogId: string;
  /** Where it came from: `<catalogId>/<id>@<version>`, plus `#<commit>` for Git. */
  origin: string;
  verified: boolean;
  publisherKey: string | null;
  sha256: string | null;
  commit: string | null;
  permissions: MarketPermissionLine[];
  installedAt: string;
  updatedAt: string;
}

/** An installed pet (docs/14 §2.3): its manifest as validated at install. */
export interface MarketPetView {
  id: string;
  name: string;
  version: string;
  states: Record<string, { frames: string[]; fps: number; loop: boolean }>;
}

// ---- requests ---------------------------------------------------------------------------------

const itemIdSchema = z.string().min(1).max(200);
export const marketKindSchema = z.enum(MARKET_KINDS);

export const marketSearchSchema = z.object({
  q: z.string().max(200).default(''),
  kind: marketKindSchema.optional(),
  catalogId: z.string().max(40).optional(),
});

export const marketPreviewSchema = z.object({
  catalogId: z.string().min(1).max(40),
  kind: marketKindSchema,
  id: itemIdSchema,
  version: z.string().max(50).optional(),
});

export const marketInstallSchema = z.object({
  previewId: idSchema,
  /** Install an Unverified item (docs/14 §5): the explicit sideload confirmation. */
  confirmSideload: z.boolean().optional(),
  /** The `diff.hash` of the preview: accepts the permission changes of an update. */
  acceptPermissions: z.string().max(100).optional(),
  /** Accepts the preview's `publisherChange` (the extension's secrets and data are cleared). */
  acceptPublisherChange: z.boolean().optional(),
  enable: z.boolean().default(true),
  /** Plugin hooks to trust now, with the hashes the preview showed (FR-197). */
  trustHooks: z
    .array(z.object({ id: z.string().max(300), contentHash: z.string().max(200) }))
    .max(50)
    .optional(),
  /** MCP bundles: values for the bundle's settings (FR-199). */
  userConfig: z.record(z.string().max(100), z.unknown()).optional(),
});

export const marketRatingSchema = z.object({
  kind: marketKindSchema,
  itemId: itemIdSchema,
  stars: z.number().int().min(1).max(5),
  review: z.string().max(2000).optional(),
});
