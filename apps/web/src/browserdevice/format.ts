// Words for the local browser fallback (FR-209) and the extension bridge (FR-096; docs/11 §4.3,
// §4.6): profiles, causes, how a session ended, grant states, the bridge's audit entries, the
// Hub's refusals in plain words, and how to read the fallback offer (a `user_input` request whose
// payload carries `context: {kind: 'browser.fallback', …}`). Every state pairs an icon with text,
// never color alone (docs/04 §7).
import {
  browserFallbackOfferContextSchema,
  type AuditEntryView,
  type BrowserActionFallbackMark,
  type BrowserActionView,
  type BrowserBridgeGrantState,
  type BrowserBridgeGrantView,
  type BrowserFallbackCause,
  type BrowserFallbackEndReason,
  type BrowserFallbackOfferContext,
  type BrowserFallbackProfile,
  type ServerRequestView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';
import { defineMessages, fmt } from '@nova/i18n';
import { ApiError, errorMessage } from '../api.ts';

/** The browser fallback's and the bridge's shared words (FR-016). */
export const BROWSER_DEVICE_TEXT = defineMessages('browserDevice', {
  never: 'never',
  unknown: 'unknown',
  profiles: {
    clean: 'Clean profile',
    extension: 'Your own browser',
  },
  /** Why the fallback was offered: a clause, after "because". */
  causes: {
    block_page: 'the site showed a block page to the agent’s browser',
    repeated_challenge: 'the site kept showing a bot check to the agent’s browser',
    requested: 'it was asked for',
  },
  ends: {
    closed: 'Closed',
    left_site: 'Ended when the agent left the site',
    consent_revoked: 'Ended when the consent was revoked',
    device_gone: 'Ended when the computer left',
    error: 'Ended by an error',
    disabled: 'Ended when continuing on a computer was turned off',
    restarted: 'Ended when the Hub restarted',
  },
  markOn:
    '{profile, select, clean {On {device}, clean profile} other {On {device}, your own browser}}',
  markYours:
    '{profile, select, clean {On your computer, clean profile} other {On your computer, your own browser}}',
  whereClean:
    '{device}’s browser, in a clean profile that reaches only this site and its subdomains',
  whereCleanAny:
    'a connected computer’s browser, in a clean profile that reaches only this site and its subdomains',
  whereExtension: 'Your own browser on {device}, through the Nova extension',
  whereExtensionAny: 'Your own browser on a connected computer, through the Nova extension',
  yourComputer: 'your computer',
  grants: {
    pending: 'Waiting for you',
    active: 'Granted',
    revoked: 'Revoked',
  },
  audit: {
    connected: 'The extension connected',
    disconnected: 'The extension disconnected',
    replaced:
      'A new browser connection replaced the previous one; agent work in the old one stopped',
    historySearch: 'An agent asked to search your history (your browser asked you first)',
    orphanClosed: 'The Hub closed a browser session on this computer that it no longer ran',
  },
  allSites: 'All sites',
  errors: {
    generic: 'Something went wrong.',
    ownerOnly: 'Only the owner of this Hub manages the browser bridge.',
    bridgeOff: 'The browser bridge is turned off in Settings → Browser, so nothing can be granted.',
    allSitesOff:
      'The “all sites” grant is turned off in Settings → Browser. Grant sites one by one instead.',
    ackRequired: 'Confirm that you understand the risk of “all sites” first.',
    hubHost:
      'That is one of this Hub’s own addresses. The bridge never acts on the Hub itself, so it cannot be granted.',
    notGranted: 'That site is not granted for the bridge on this computer.',
    offline: 'The browser bridge on this computer is not connected.',
    refused: 'The extension refused.',
    conflict: 'This grant was revoked in the meantime. Grant the site again if you still want it.',
    grantGone: 'This grant no longer exists.',
    consentGone: 'This consent no longer exists.',
    deviceGone: 'This device is not on this Hub.',
    gone: 'It no longer exists.',
    expired: 'This expired before your answer arrived.',
  },
});
const S = BROWSER_DEVICE_TEXT;

export type Tone = 'ready' | 'running' | 'needs_input' | 'blocked' | 'neutral';

export const SETTINGS_BROWSER_PATH = '/settings/browser';

/** A date and time, for a moment that may lie ahead: "Oct 2, 12:10 PM". */
export function stampOf(iso: string | null): string {
  if (!iso) return S.never;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return S.unknown;
  return fmt.dateTime(t, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---- the fallback ------------------------------------------------------------------------------

export const PROFILE_TEXT: Readonly<Record<BrowserFallbackProfile, string>> = S.profiles;

/** Why the fallback was offered, as a clause: "the site showed a block page…". */
export const CAUSE_TEXT: Readonly<Record<BrowserFallbackCause, string>> = S.causes;

export const END_TEXT: Readonly<Record<BrowserFallbackEndReason, string>> = S.ends;

/** The local-fallback mark of a trace row (`GET /browser/actions` adds it to every item). */
export function fallbackMarkOf(a: BrowserActionView): BrowserActionFallbackMark | null {
  const m = (a as { localFallback?: BrowserActionFallbackMark | null }).localFallback;
  return m && typeof m.deviceId === 'string' ? m : null;
}

/** "On Desk PC, clean profile" (the device's name when known). */
export function markText(mark: BrowserActionFallbackMark, deviceName: string | null): string {
  return deviceName
    ? S.markOn({ profile: mark.profile, device: deviceName })
    : S.markYours({ profile: mark.profile });
}

/** Where a fallback row ran, for its details. */
export function whereText(mark: BrowserActionFallbackMark, deviceName: string | null): string {
  if (mark.profile === 'clean')
    return deviceName ? S.whereClean({ device: deviceName }) : S.whereCleanAny;
  return deviceName ? S.whereExtension({ device: deviceName }) : S.whereExtensionAny;
}

// ---- the offer: a `user_input` question marked by its context ---------------------------------

export type FallbackChoiceId = BrowserFallbackOfferContext['choices'][number]['id'];

export interface FallbackOffer {
  site: string;
  deviceId: string;
  /** The computer's name as the Hub gave it. */
  device: string;
  cause: BrowserFallbackCause;
  /** The Hub's question, shown as text. */
  question: string;
  /** The choices in the Hub's order; `label` is the answer sent back. */
  choices: { id: FallbackChoiceId; label: string }[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

/**
 * The fallback offer a request carries, or null for any other question: a `user_input` whose
 * payload has a valid `context` of kind `browser.fallback`. Only choices that are also among the
 * request's own choices are kept (the Hub accepts nothing else as an answer).
 */
export function parseFallbackOffer(r: ServerRequestView): FallbackOffer | null {
  if (r.kind !== 'user_input') return null;
  const ctx = browserFallbackOfferContextSchema.safeParse(r.payload.context);
  if (!ctx.success) return null;
  const allowed = strings(r.payload.choices);
  const choices = ctx.data.choices
    .filter((c) => allowed.includes(c.label))
    .map((c) => ({ id: c.id, label: c.label }));
  if (!choices.length) return null;
  return {
    site: ctx.data.site,
    deviceId: ctx.data.deviceId,
    device: ctx.data.deviceName || S.yourComputer,
    cause: ctx.data.cause,
    question: typeof r.payload.question === 'string' ? r.payload.question : '',
    choices,
  };
}

// ---- the bridge ------------------------------------------------------------------------------

const GRANT_LOOK: Record<BrowserBridgeGrantState, { icon: IconName; tone: Tone }> = {
  pending: { icon: 'hand', tone: 'needs_input' },
  active: { icon: 'check', tone: 'ready' },
  revoked: { icon: 'slash', tone: 'neutral' },
};

/** A grant state's chip; its words read in the active locale. */
export function grantChip(state: BrowserBridgeGrantState): {
  text: string;
  icon: IconName;
  tone: Tone;
} {
  return { ...GRANT_LOOK[state], text: S.grants[state] };
}

/** The bridge's (and the fallback's device) audit actions a device lists, by message. */
const AUDIT_ACTIONS: Record<string, keyof typeof S.audit> = {
  'browser.bridge.connected': 'connected',
  'browser.bridge.disconnected': 'disconnected',
  'browser.bridge.replaced': 'replaced',
  'browser.bridge.history.search': 'historySearch',
  'browser.fallback.orphan_closed': 'orphanClosed',
};

/** What one of those audit entries says, or null for any other action. */
export function bridgeAuditText(action: string): string | null {
  const key = Object.hasOwn(AUDIT_ACTIONS, action) ? AUDIT_ACTIONS[action] : undefined;
  return key ? S.audit[key] : null;
}

/** The device's own audit entries the bridge section lists (resource `<id>` or `device:<id>`). */
export function isDeviceActivity(e: AuditEntryView, deviceId: string): boolean {
  return (
    (e.resource === deviceId || e.resource === `device:${deviceId}`) &&
    Object.hasOwn(AUDIT_ACTIONS, e.action)
  );
}

/** A grant's site as people read it. */
export function grantLabel(g: Pick<BrowserBridgeGrantView, 'allSites' | 'host'>): string {
  return g.allSites || g.host === '*' ? S.allSites : g.host;
}

// ---- refusals in plain words ----------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The Hub's not-found messages, by what they mean. */
const NOT_FOUND: Record<string, keyof typeof S.errors> = {
  'grant not found': 'grantGone',
  'consent not found': 'consentGone',
  'device not found': 'deviceGone',
};

/**
 * What a refusal of the fallback or bridge routes means, in plain words; `invalid` says what a
 * validation error means for the form that sent it.
 */
export function browserDeviceError(
  err: unknown,
  fallback?: string,
  opts: { invalid?: string } = {},
): string {
  const otherwise = fallback ?? S.errors.generic;
  if (!(err instanceof ApiError)) return errorMessage(err, otherwise);
  const E = S.errors;
  const reason = str(err.body.details?.reason) ?? err.body.code;
  switch (reason) {
    case 'owner_only':
      return E.ownerOnly;
    case 'bridge_disabled':
      return E.bridgeOff;
    case 'all_sites_disabled':
      return E.allSitesOff;
    case 'elevated_ack_required':
      return E.ackRequired;
    case 'hub_host':
      return E.hubHost;
    case 'host_not_granted':
      return E.notGranted;
    case 'bridge_offline':
      return E.offline;
    case 'extension_refused':
      return E.refused;
    case 'conflict':
      return E.conflict;
    case 'not_found': {
      const key = Object.hasOwn(NOT_FOUND, err.body.message) ? NOT_FOUND[err.body.message] : null;
      return key ? E[key] : E.gone;
    }
    case 'validation':
      return opts.invalid ?? errorMessage(err, otherwise);
    case 'request_expired':
      return E.expired;
    default:
      return errorMessage(err, otherwise);
  }
}
