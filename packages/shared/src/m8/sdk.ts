// M8 extension SDK (FR-117; docs/14 §4, docs/26 §3-§5; ADR-097 D1-D3): an extension is a plugin
// folder plus `.nova-plugin/extension.json` (the SDK part: `api: 1`, an entry module and declared
// permissions), shipped as a signed `.novax` bundle. Its handlers run in a worker of their own with
// no ambient authority; what they reach passes the policy engine. Views and zod requests for
// /api/v1/extensions.
import { z } from 'zod';
import { idSchema } from '../api.ts';

/** The SDK API version an extension declares (`extension.json` `api`, `nova.api`). */
export const EXTENSION_API_VERSION = 1;

/** base64url of a raw 32-byte Ed25519 public key (D2). */
export const PUBLISHER_KEY = /^[A-Za-z0-9_-]{43}$/;
export const extensionPublisherKeySchema = z
  .string()
  .regex(PUBLISHER_KEY, 'expected base64url of a raw 32-byte Ed25519 public key');

/** A publisher the owner trusts (`plugins.trustedPublishers`). */
export const trustedPublisherSchema = z.object({
  name: z.string().min(1).max(100),
  key: extensionPublisherKeySchema,
});
export type TrustedPublisher = z.infer<typeof trustedPublisherSchema>;

/**
 * How a bundle's signature checked out: `verified` by a trusted publisher; `unverified` when it is
 * unsigned or signed by a key the owner does not trust (installs only through the sideload
 * confirmation); `dev` for a folder loaded by `nova dev` (always unverified).
 */
export type ExtensionSignature = 'verified' | 'unverified' | 'dev';

/** Where an extension's worker is: running, starting, stopped (the SDK switch is off), off, failed. */
export type ExtensionStatus = 'running' | 'starting' | 'stopped' | 'disabled' | 'error';

/** Largest `.novax` accepted from an upload (bytes, before base64). */
export const EXTENSION_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const base64Bundle = z
  .string()
  .min(4)
  .max(Math.ceil((EXTENSION_BUNDLE_MAX_BYTES * 4) / 3) + 4)
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'expected the bundle as base64');

/** Install from an uploaded `.novax`, or from a `.novax` file or extension folder on the Hub. */
export const extensionSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upload'),
    bundle: base64Bundle,
    fileName: z.string().max(200).optional(),
  }),
  z.object({ kind: z.literal('path'), path: z.string().min(1).max(1000) }),
]);
export type ExtensionSource = z.infer<typeof extensionSourceSchema>;

export const previewExtensionSchema = z.object({ source: extensionSourceSchema });

const trustHookSchema = z.object({
  id: z.string().min(1).max(300),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const installExtensionSchema = z.object({
  previewId: idSchema,
  /** Required for an unverified bundle (unsigned or unknown publisher, docs/14 §5). */
  confirmSideload: z.boolean().optional(),
  enable: z.boolean().default(true),
  /** Hooks (plugin and SDK) to trust now, with the hash the preview showed (FR-197). */
  trustHooks: z.array(trustHookSchema).max(100).optional(),
});
export type InstallExtensionRequest = z.input<typeof installExtensionSchema>;

/**
 * `nova dev`: load or reload a local extension (packed by the CLI) in one step. A dev load is
 * always unverified, so the sideload confirmation is part of the request; `trustHooks` trusts the
 * bundle's hooks at their new hashes (each reload changes them), audited.
 */
export const devExtensionSchema = z.object({
  bundle: base64Bundle,
  confirmSideload: z.literal(true),
  trustHooks: z.boolean().default(false),
});
export type DevExtensionRequest = z.input<typeof devExtensionSchema>;

export const setExtensionEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const runExtensionCommandSchema = z.object({
  /** JSON arguments for the command handler (at most 64 KiB as JSON). */
  args: z.unknown().optional(),
});

/** A declared secret's value, stored in the vault; never returned. */
export const extensionSecretSchema = z.object({ value: z.string().min(1).max(10_000) }).strict();
export const EXTENSION_SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ExtensionPublisherView {
  /** base64url of the raw Ed25519 public key; null when unsigned. */
  key: string | null;
  /** The owner's name for a trusted key; null otherwise. */
  name: string | null;
  /** First 16 hex characters of SHA-256 over the raw key, for reading aloud. */
  fingerprint: string | null;
  trusted: boolean;
}

/**
 * One thing an extension may do, in plain words (docs/14 §5: "This plugin can access: network →
 * api.github.com"). `key` is stable across versions so an update can show a diff.
 */
export interface ExtensionPermissionLine {
  key: string;
  kind: 'network' | 'fs' | 'secret' | 'command' | 'panel' | 'tool' | 'hook' | 'event' | 'plugin';
  text: string;
  /** Network, secrets, write access, send/delete/execute tools and hooks are marked. */
  sensitive: boolean;
}

export interface ExtensionHookView {
  /** `hook:<extensionId>.<hookId>` (the hooks list's id). */
  id: string;
  event: string;
  matcher: string | null;
  contentHash: string;
  failClosed: boolean;
  timeoutMs: number;
  /** From the hooks area once installed; `needs_trust` in a preview. */
  status: 'trusted' | 'needs_trust' | 'revoked' | 'disabled';
}

export interface ExtensionView {
  /** The plugin id (reverse-DNS); the extension's tools are `ext:<id>/<name>`. */
  id: string;
  name: string;
  version: string;
  description: string | null;
  api: number;
  signature: ExtensionSignature;
  /** Shown as Unverified for as long as it is installed (docs/26 §3). */
  verified: boolean;
  publisher: ExtensionPublisherView;
  /** SHA-256 digest of the bundle's files (D2). */
  digest: string;
  enabled: boolean;
  status: ExtensionStatus;
  error: string | null;
  permissions: ExtensionPermissionLine[];
  hooks: ExtensionHookView[];
  /** What the running worker registered. */
  registered: {
    commands: number;
    panels: number;
    tools: number;
    hooks: number;
    themes: number;
    keybindings: number;
    menus: number;
    statusItems: number;
    events: number;
  };
  /** Declared secrets and whether a value is stored (the value is never returned). */
  secrets: { name: string; set: boolean }[];
  installedAt: string;
  updatedAt: string;
}

export interface ExtensionPreviewView {
  previewId: string;
  id: string;
  name: string;
  version: string;
  description: string | null;
  api: number;
  signature: ExtensionSignature;
  verified: boolean;
  publisher: ExtensionPublisherView;
  digest: string;
  /** Set when the bundle needs the sideload confirmation, in plain words. */
  sideloadReason: string | null;
  permissions: ExtensionPermissionLine[];
  /** On an update: what the new version adds or drops (docs/14 §5 permission diff). */
  diff: { added: ExtensionPermissionLine[]; removed: ExtensionPermissionLine[] } | null;
  /** SDK hooks and the plugin's own hooks, with the hashes to trust. */
  hooks: ExtensionHookView[];
  pluginHooks: { id: string; event: string; contentHash: string }[];
  warnings: string[];
  replaces: { version: string } | null;
}

export interface ExtensionCommandView {
  extensionId: string;
  id: string;
  title: string;
}

export interface ExtensionPanelView {
  extensionId: string;
  id: string;
  title: string;
  resource: string;
  entryPoint: 'global' | 'thread' | 'file';
  extensions: string[];
}

export interface ExtensionMenuView {
  extensionId: string;
  where: string;
  items: { id: string; title: string; command: string }[];
}

export interface ExtensionStatusItemView {
  extensionId: string;
  id: string;
  text: string;
  /** The command a click runs, if any. */
  command: string | null;
}

export interface ExtensionKeybindingView {
  extensionId: string;
  /** `ext:<extensionId>/<commandId>`. */
  command: string;
  key: string;
  when: string | null;
}

/** What running extensions add to the client: the command palette, themes, menus, status bar. */
export interface ExtensionContributionsView {
  commands: ExtensionCommandView[];
  panels: ExtensionPanelView[];
  /** contracts/schemas/theme.json objects, offered next to `appearance.customThemes`. */
  themes: { extensionId: string; theme: Record<string, unknown> }[];
  /** Defaults below the user's `keyboard.bindings` (the user's remapping wins). */
  keybindings: ExtensionKeybindingView[];
  menus: ExtensionMenuView[];
  statusItems: ExtensionStatusItemView[];
}

export interface ExtensionCommandResult {
  ok: boolean;
  /** The handler's JSON result (capped), when it succeeded. */
  result: unknown;
  error: { code: string; message: string } | null;
}
