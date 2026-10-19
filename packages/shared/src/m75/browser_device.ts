// M7.5 browser_device (FR-209, FR-096; docs/11 §4.3, §4.6; ADR-096 D7, D8): the local browser
// fallback (an agent continues on its connected computer's browser after a per-site consent) and
// the extension bridge (the user's own browser through our extension, novad's native host and
// novad's Hub connection). Views the web reads and the zod schemas of their requests, and of the
// events novad sends to `POST /agent/v1/bridge/events`.
import { z } from 'zod';
import type { BrowserActionView } from '../m6/browser.ts';

// ---- local browser fallback (FR-209) -----------------------------------------------------------

/** A clean temporary profile on the device, or the user's own browser through the extension. */
export const BROWSER_FALLBACK_PROFILES = ['clean', 'extension'] as const;
export type BrowserFallbackProfile = (typeof BROWSER_FALLBACK_PROFILES)[number];

/** Who a consent belongs to: an agent (its threads), or one thread. */
export const BROWSER_FALLBACK_SCOPES = ['agent', 'thread'] as const;
export type BrowserFallbackScopeKind = (typeof BROWSER_FALLBACK_SCOPES)[number];

/** Why the agent's own browser was not enough (the offer and the trace say which). */
export const BROWSER_FALLBACK_CAUSES = ['block_page', 'repeated_challenge', 'requested'] as const;
export type BrowserFallbackCause = (typeof BROWSER_FALLBACK_CAUSES)[number];

/** A revocable consent for one site on one device, per agent or thread (0043). */
export interface BrowserFallbackConsentView {
  id: string;
  scopeKind: BrowserFallbackScopeKind;
  scopeRef: string;
  deviceId: string;
  /** The device's name, when the device still exists. */
  deviceName: string | null;
  /** The site the consent covers (a host; its subdomains load as resources). */
  site: string;
  profile: BrowserFallbackProfile;
  grantedBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export const BROWSER_FALLBACK_END_REASONS = [
  'closed',
  'left_site',
  'consent_revoked',
  'device_gone',
  'error',
  /** `browser.localFallback` was turned off. */
  'disabled',
  /** The Hub restarted while the session ran. */
  'restarted',
] as const;
export type BrowserFallbackEndReason = (typeof BROWSER_FALLBACK_END_REASONS)[number];

/** One local-fallback browser session: its trace rows are marked with its id. */
export interface BrowserFallbackSessionView {
  id: string;
  computerId: string;
  threadId: string | null;
  deviceId: string;
  site: string;
  profile: BrowserFallbackProfile;
  cause: BrowserFallbackCause;
  consentId: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: BrowserFallbackEndReason | null;
  /** What the device's egress filter allowed and refused (D7), when it reported them. */
  egress: { allowed: number; refused: number } | null;
  /** In the user's own browser: the OS user whose browser it was (novad says). */
  bridgeUser?: string | null;
}

/** A trace row with its local-fallback mark (`GET /browser/actions` adds it to every item). */
export interface BrowserActionFallbackMark {
  sessionId: string;
  deviceId: string;
  profile: BrowserFallbackProfile;
}
export type BrowserActionMarkedView = BrowserActionView & {
  localFallback: BrowserActionFallbackMark | null;
};

/**
 * The structured side of the fallback offer (a `user_input` server request, FR-188): its payload
 * carries this as `context`, so a client can show the offer its own way. The answer is still
 * `{choice: <label>}` with one of the labels.
 */
export const browserFallbackOfferContextSchema = z
  .object({
    kind: z.literal('browser.fallback'),
    site: z.string().min(1).max(253),
    deviceId: z.string().min(1).max(100),
    deviceName: z.string().max(200),
    cause: z.enum(BROWSER_FALLBACK_CAUSES),
    choices: z
      .array(
        z
          .object({
            id: z.enum(['clean', 'extension', 'decline']),
            label: z.string().min(1).max(200),
            profile: z.enum(BROWSER_FALLBACK_PROFILES).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type BrowserFallbackOfferContext = z.infer<typeof browserFallbackOfferContextSchema>;

export const browserFallbackConsentsQuerySchema = z
  .object({
    scopeKind: z.enum(BROWSER_FALLBACK_SCOPES).optional(),
    scopeRef: z.string().min(1).max(100).optional(),
    deviceId: z.string().min(1).max(100).optional(),
    /** Revoked consents too (newest first). */
    all: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type BrowserFallbackConsentsQuery = z.infer<typeof browserFallbackConsentsQuerySchema>;

export const browserFallbackSessionsQuerySchema = z
  .object({
    computerId: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

// ---- extension bridge (FR-096) -----------------------------------------------------------------

/** A tab of the user's browser the agent may act in: shared by the user, or opened by the agent. */
export interface BrowserBridgeTabView {
  tabId: number;
  /** The tab's host (never the full address: it may carry tokens). */
  host: string | null;
  title: string | null;
  /** `shared`: the user shared it; `agent`: the agent opened it in the Nova tab group. */
  origin: 'shared' | 'agent';
  since: string;
  /** The OS user whose browser the tab is in; a tab of another user is never acted in. */
  user?: string | null;
}

/** The bridge on one device, from the events novad relays (in memory; rebuilt by the next). */
export interface BrowserBridgeStatusView {
  deviceId: string;
  deviceName: string | null;
  /** The native host is connected to novad (and so the extension runs). */
  connected: boolean;
  since: string | null;
  extensionVersion: string | null;
  browser: string | null;
  /** The OS user whose browser runs the extension (novad says). */
  user: string | null;
  /** `browser.extensionBridge` (managed policy can turn it off). */
  enabled: boolean;
  /** `browser.extensionBridgeAllSites`: whether an "all sites" grant may be used at all. */
  allSitesAllowed: boolean;
  tabs: BrowserBridgeTabView[];
}

export const BROWSER_BRIDGE_GRANT_STATES = ['pending', 'active', 'revoked'] as const;
export type BrowserBridgeGrantState = (typeof BROWSER_BRIDGE_GRANT_STATES)[number];

/**
 * A per-host grant of the bridge (owner-confirmed). `host` `*` is the separate "all sites" grant,
 * elevated risk. `pending`: the extension reported the browser's permission for the host, and the
 * owner has not confirmed it yet; only `active` grants let the agent act.
 */
export interface BrowserBridgeGrantView {
  id: string;
  deviceId: string;
  host: string;
  allSites: boolean;
  state: BrowserBridgeGrantState;
  /** The browser's own permission for the host, as the extension last reported it. */
  browserPermission: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** A host as the bridge grants it: an exact host name, never a pattern or an address. */
export const bridgeHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/,
    'a host name such as github.com',
  );

/**
 * `POST /devices/:id/bridge/grants`: one host with the owner's confirmation, or "all sites"
 * with its own, separate acknowledgement of the elevated risk (docs/11 §4.3).
 */
export const createBridgeGrantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), host: bridgeHostSchema, confirm: z.literal(true) }).strict(),
  z
    .object({
      kind: z.literal('all_sites'),
      confirm: z.literal(true),
      acknowledgeElevatedRisk: z.literal(true),
    })
    .strict(),
]);
export type CreateBridgeGrantRequest = z.infer<typeof createBridgeGrantSchema>;

/** `POST /devices/:id/bridge/grants/:grantId/confirm`: a pending grant the extension reported. */
export const confirmBridgeGrantSchema = z
  .object({ confirm: z.literal(true), acknowledgeElevatedRisk: z.literal(true).optional() })
  .strict();

export const BROWSER_BRIDGE_EVENT_KINDS = [
  'tab.shared',
  'tab.unshared',
  'tab.closed',
  'host.granted',
  'host.revoked',
  'connected',
  'disconnected',
] as const;
export type BrowserBridgeEventKind = (typeof BROWSER_BRIDGE_EVENT_KINDS)[number];

const tabId = z
  .number()
  .int()
  .min(0)
  .max(2 ** 31);
const at = z.string().max(40).optional();
/** A tab's host as the extension reports it (only the host: addresses can carry tokens). */
const tabHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9._:[\]-]+$/, 'a host name')
  .nullable();
const shortText = (n: number) =>
  z
    .string()
    .max(n * 4)
    .transform((s) => s.slice(0, n));
/** `*` is the browser's permission for every site (the extension's "all sites"). */
const eventHost = z.union([bridgeHostSchema, z.literal('*')]);

/** One event novad relays from the bridge host (D8). Unknown fields are refused. */
export const bridgeEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tab.shared'),
      tabId,
      host: tabHost,
      title: shortText(300).optional(),
      /** A tab the agent opened in the Nova group, reported again after a reconnect. */
      origin: z.enum(['shared', 'agent']).optional(),
      at,
    })
    .strict(),
  z.object({ kind: z.literal('tab.unshared'), tabId, at }).strict(),
  z.object({ kind: z.literal('tab.closed'), tabId, at }).strict(),
  z.object({ kind: z.literal('host.granted'), host: eventHost, at }).strict(),
  z.object({ kind: z.literal('host.revoked'), host: eventHost, at }).strict(),
  // novad's own: its native host connected or left, for the OS user it runs for.
  z
    .object({
      kind: z.literal('connected'),
      user: shortText(100).optional(),
      extensionVersion: shortText(40).optional(),
      browser: shortText(80).optional(),
      at,
    })
    .strict(),
  z.object({ kind: z.literal('disconnected'), user: shortText(100).optional(), at }).strict(),
]);
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;

/**
 * The body of `POST /agent/v1/bridge/events` (device credential, like heartbeats). Each event is
 * checked on its own (`bridgeEventSchema`): one the Hub does not know is skipped and counted, so
 * a batch novad keeps retrying is never stuck on it.
 */
export const bridgeEventsSchema = z
  .object({ events: z.array(z.unknown()).min(1).max(100) })
  .strict();
export type BridgeEventsRequest = z.infer<typeof bridgeEventsSchema>;

/** The methods the Hub may call through `POST /agent/v1/bridge/call` (D8). */
export const BROWSER_BRIDGE_METHODS = [
  'tabs.list',
  'tabs.open',
  'tab.attach',
  'tab.detach',
  'cdp.send',
  'history.search',
] as const;
export type BrowserBridgeMethod = (typeof BROWSER_BRIDGE_METHODS)[number];

/**
 * The page scripts `Runtime.evaluate` may name through the bridge. The extension holds the
 * scripts themselves and runs one only on the host the Hub expects; an expression is never
 * sent (FR-096).
 */
export const BROWSER_BRIDGE_SCRIPTS = [
  'read',
  'describe',
  'href',
  'readyState',
  'navStatus',
  'frames',
  'point',
  'focus',
  'select',
  'hasText',
  'back',
  'box',
  'focusedSecret',
] as const;
export type BrowserBridgeScript = (typeof BROWSER_BRIDGE_SCRIPTS)[number];
