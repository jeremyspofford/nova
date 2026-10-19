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
import { ApiError, errorMessage } from '../api.ts';

export type Tone = 'ready' | 'running' | 'needs_input' | 'blocked' | 'neutral';

export const SETTINGS_BROWSER_PATH = '/settings/browser';

/** A date and time, for a moment that may lie ahead: "Oct 2, 12:10 PM". */
export function stampOf(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---- the fallback ------------------------------------------------------------------------------

export const PROFILE_TEXT: Record<BrowserFallbackProfile, string> = {
  clean: 'Clean profile',
  extension: 'Your own browser',
};

/** Short, for a trace mark: "On Desk PC, clean profile". */
export const PROFILE_SHORT: Record<BrowserFallbackProfile, string> = {
  clean: 'clean profile',
  extension: 'your own browser',
};

export const CAUSE_TEXT: Record<BrowserFallbackCause, string> = {
  block_page: 'the site showed a block page to the agent’s browser',
  repeated_challenge: 'the site kept showing a bot check to the agent’s browser',
  requested: 'it was asked for',
};

export const END_TEXT: Record<BrowserFallbackEndReason, string> = {
  closed: 'Closed',
  left_site: 'Ended when the agent left the site',
  consent_revoked: 'Ended when the consent was revoked',
  device_gone: 'Ended when the computer left',
  error: 'Ended by an error',
  disabled: 'Ended when continuing on a computer was turned off',
  restarted: 'Ended when the Hub restarted',
};

/** The local-fallback mark of a trace row (`GET /browser/actions` adds it to every item). */
export function fallbackMarkOf(a: BrowserActionView): BrowserActionFallbackMark | null {
  const m = (a as { localFallback?: BrowserActionFallbackMark | null }).localFallback;
  return m && typeof m.deviceId === 'string' ? m : null;
}

/** "On Desk PC, clean profile" (the device's name when known). */
export function markText(mark: BrowserActionFallbackMark, deviceName: string | null): string {
  return `On ${deviceName ?? 'your computer'}, ${PROFILE_SHORT[mark.profile]}`;
}

/** Where a fallback row ran, for its details. */
export function whereText(mark: BrowserActionFallbackMark, deviceName: string | null): string {
  const name = deviceName ?? 'a connected computer';
  return mark.profile === 'clean'
    ? `${name}’s browser, in a clean profile that reaches only this site and its subdomains`
    : `Your own browser on ${name}, through the Nova extension`;
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
    device: ctx.data.deviceName || 'your computer',
    cause: ctx.data.cause,
    question: typeof r.payload.question === 'string' ? r.payload.question : '',
    choices,
  };
}

// ---- the bridge ------------------------------------------------------------------------------

export const GRANT_CHIP: Record<
  BrowserBridgeGrantState,
  { text: string; icon: IconName; tone: Tone }
> = {
  pending: { text: 'Waiting for you', icon: 'hand', tone: 'needs_input' },
  active: { text: 'Granted', icon: 'check', tone: 'ready' },
  revoked: { text: 'Revoked', icon: 'slash', tone: 'neutral' },
};

/** What the bridge's (and the fallback's device) audit entries on a device say. */
export const BRIDGE_AUDIT_TEXT: Record<string, string> = {
  'browser.bridge.connected': 'The extension connected',
  'browser.bridge.disconnected': 'The extension disconnected',
  'browser.bridge.replaced':
    'A new browser connection replaced the previous one; agent work in the old one stopped',
  'browser.bridge.history.search':
    'An agent asked to search your history (your browser asked you first)',
  'browser.fallback.orphan_closed':
    'The Hub closed a browser session on this computer that it no longer ran',
};

/** The device's own audit entries the bridge section lists (resource `<id>` or `device:<id>`). */
export function isDeviceActivity(e: AuditEntryView, deviceId: string): boolean {
  return (
    (e.resource === deviceId || e.resource === `device:${deviceId}`) &&
    Object.hasOwn(BRIDGE_AUDIT_TEXT, e.action)
  );
}

/** A grant's site as people read it. */
export function grantLabel(g: Pick<BrowserBridgeGrantView, 'allSites' | 'host'>): string {
  return g.allSites || g.host === '*' ? 'All sites' : g.host;
}

// ---- refusals in plain words ----------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const NOT_FOUND: Record<string, string> = {
  'grant not found': 'This grant no longer exists.',
  'consent not found': 'This consent no longer exists.',
  'device not found': 'This device is not on this Hub.',
};

/**
 * What a refusal of the fallback or bridge routes means, in plain words; `invalid` says what a
 * validation error means for the form that sent it.
 */
export function browserDeviceError(
  err: unknown,
  fallback = 'Something went wrong.',
  opts: { invalid?: string } = {},
): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const reason = str(err.body.details?.reason) ?? err.body.code;
  switch (reason) {
    case 'owner_only':
      return 'Only the owner of this Hub manages the browser bridge.';
    case 'bridge_disabled':
      return 'The browser bridge is turned off in Settings → Browser, so nothing can be granted.';
    case 'all_sites_disabled':
      return 'The “all sites” grant is turned off in Settings → Browser. Grant sites one by one instead.';
    case 'elevated_ack_required':
      return 'Confirm that you understand the risk of “all sites” first.';
    case 'hub_host':
      return 'That is one of this Hub’s own addresses. The bridge never acts on the Hub itself, so it cannot be granted.';
    case 'host_not_granted':
      return 'That site is not granted for the bridge on this computer.';
    case 'bridge_offline':
      return 'The browser bridge on this computer is not connected.';
    case 'extension_refused':
      return 'The extension refused.';
    case 'conflict':
      return 'This grant was revoked in the meantime. Grant the site again if you still want it.';
    case 'not_found':
      return NOT_FOUND[err.body.message] ?? 'It no longer exists.';
    case 'validation':
      return opts.invalid ?? errorMessage(err, fallback);
    case 'request_expired':
      return 'This expired before your answer arrived.';
    default:
      return errorMessage(err, fallback);
  }
}
