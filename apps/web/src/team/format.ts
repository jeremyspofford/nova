// Paths, words and pure helpers for the team area (FR-217, FR-091, FR-113; decision 5 of ADR-095):
// where each part lives, what each role, status and refusal is called, how a sign-in that came back
// with `?oidc_error=` reads, and the plain wording of what a shared chat does not share. Statuses
// the Hub may add later fall back to a neutral chip with the raw word, never a crash. Every word is
// a message (FR-016), read at render time; text the Hub writes (its error `message`s, validation
// issues) stays as the Hub sent it.
import { defineMessages, fmt, messageFor, subscribe } from '@nova/i18n';
import type { InvitationStatus, OidcProviderView, TeamTaskStatus } from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import type { ChipSpec } from '../netsurface/format.ts';

const enc = encodeURIComponent;

/** Words the team views share. */
export const TEAM_TEXT = defineMessages('team', {
  ownerOnly: 'Only the owner of this Hub can change this.',
  someone: 'Someone',
  you: 'You',
  /** After a person's name: "Sam (you)". */
  youMark: '(you)',
  untitledChat: 'Untitled chat',
  breadcrumb: 'Breadcrumb',
  retry: 'Retry',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',
  remove: 'Remove',
  made: 'Made {when}',
  membersLink: 'Settings → Members',
  accountLink: 'Settings → Account',
});

// ---- paths -----------------------------------------------------------------------------------

export const TEAM_PATH = '/team';
export const TEAM_SECTIONS = ['shared', 'agents'] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];

export const TEAM_SECTION_INFO = defineMessages('team.sections', {
  shared: { label: 'Shared chats', description: 'Chats you share with people of this Hub' },
  agents: {
    label: 'Team agents',
    description: 'Agents with their own identity that anyone here can give a task',
  },
});

export const MEMBERS_SETTINGS_PATH = '/settings/members';
export const ACCOUNT_SETTINGS_PATH = '/settings/account';
export const NEW_TEAM_AGENT_ID = 'new';

export function teamPath(section?: TeamSection | null): string {
  return section ? `${TEAM_PATH}/${section}` : TEAM_PATH;
}

export function sharedThreadPath(threadId: string | null): string {
  return threadId ? `${teamPath('shared')}/${enc(threadId)}` : teamPath('shared');
}

export function teamAgentPath(agentId: string | null, tab?: string | null): string {
  if (!agentId) return teamPath('agents');
  const base = `${teamPath('agents')}/${enc(agentId)}`;
  return tab ? `${base}?tab=${enc(tab)}` : base;
}

/** The section a path segment names, or null (the first section on desktop, the menu on phones). */
export function teamSectionFrom(value: string | null | undefined): TeamSection | null {
  return (TEAM_SECTIONS as readonly string[]).includes(value ?? '') ? (value as TeamSection) : null;
}

// ---- people ----------------------------------------------------------------------------------

export const ROLE_TEXT = defineMessages('team.roles', { owner: 'Owner', member: 'Member' });

/** A person's name as the UI shows it: display name, then username, never "null". */
export function personName(
  p: { displayName: string | null; username?: string | null } | null | undefined,
  fallback: string = TEAM_TEXT.someone,
): string {
  return p?.displayName?.trim() || p?.username?.trim() || fallback;
}

// ---- chips -----------------------------------------------------------------------------------

const CHIP_TEXT = defineMessages('team.chips', {
  invitation: {
    pending: 'Waiting to be used',
    redeemed: 'Used',
    expired: 'Expired',
    revoked: 'Withdrawn',
  },
  task: {
    queued: 'Queued',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
  },
  agent: { active: 'Active', paused: 'Paused', stopped: 'Stopped' },
  provider: { on: 'On', off: 'Off' },
});

type ChipLook = Omit<ChipSpec, 'text'>;

/** The chip for `value`: its look from `table`, its word from `words`; else the raw word. */
function lookup(table: Readonly<Record<string, ChipLook>>, words: object, value: string): ChipSpec {
  const look = Object.hasOwn(table, value) ? table[value] : undefined;
  const text = messageFor(words, value);
  if (look && text !== undefined) return { ...look, text };
  return { text: value.replace(/_/g, ' '), tone: 'neutral', icon: 'alert' };
}

const INVITATION: Record<InvitationStatus, ChipLook> = {
  pending: { tone: 'running', icon: 'clock' },
  redeemed: { tone: 'ready', icon: 'check' },
  expired: { tone: 'neutral', icon: 'clock' },
  revoked: { tone: 'blocked', icon: 'stop' },
};
export const invitationChip = (s: string) => lookup(INVITATION, CHIP_TEXT.invitation, s);

const TASK: Record<TeamTaskStatus, ChipLook> = {
  queued: { tone: 'neutral', icon: 'clock' },
  running: { tone: 'running', icon: null },
  done: { tone: 'ready', icon: 'check' },
  failed: { tone: 'blocked', icon: 'alert' },
  cancelled: { tone: 'neutral', icon: 'stop' },
};
export const taskChip = (s: string) => lookup(TASK, CHIP_TEXT.task, s);

const AGENT: Record<string, ChipLook> = {
  active: { tone: 'ready', icon: 'check' },
  paused: { tone: 'needs_input', icon: 'clock' },
  stopped: { tone: 'blocked', icon: 'stop' },
};
export const teamAgentChip = (s: string) => lookup(AGENT, CHIP_TEXT.agent, s);

export function providerChip(p: Pick<OidcProviderView, 'enabled'>): ChipSpec {
  return p.enabled
    ? { text: CHIP_TEXT.provider.on, tone: 'ready', icon: 'check' }
    : { text: CHIP_TEXT.provider.off, tone: 'neutral', icon: 'stop' };
}

/** "in 3 days", "in 5 hours", "in 10 minutes" in the active locale, or "now" once it passed. */
export function untilText(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return fmt.relative(now, { now });
  return fmt.relative(Math.max(at, now + 60_000), { now });
}

/** How long an invitation stays valid, in hours, as the expiry choices offer it. */
export const INVITATION_HOURS: readonly number[] = [24, 72, 168, 720];

// ---- refusals --------------------------------------------------------------------------------

/**
 * What a member sees on a part of the Hub only its owner may change. Other areas import it as a
 * string, so it is a live binding that follows the active locale; read it at render time (inside
 * the area, `TEAM_TEXT.ownerOnly` is the same message).
 */
export let OWNER_ONLY_TEXT: string = TEAM_TEXT.ownerOnly;
subscribe(() => {
  OWNER_ONLY_TEXT = TEAM_TEXT.ownerOnly;
});

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function reasonOf(err: unknown): string | null {
  return err instanceof ApiError ? (str(err.body.details?.reason) ?? err.body.code) : null;
}

/** The Hub's member guard refused: the route belongs to the owner (403 `owner_only`). */
export function isOwnerOnly(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && reasonOf(err) === 'owner_only';
}

const ERROR_TEXT = defineMessages('team.errors', {
  fallback: 'Something went wrong.',
  /** By the refusal's reason. */
  reason: {
    invitation_invalid:
      'This invitation cannot be used: it was used, withdrawn or has expired. Ask the owner of the Hub for a new link.',
    rate_limited: 'Too many tries from this address. Wait a minute and try again.',
    not_shareable:
      'Only a chat outside a project can be shared. Temporary chats and side chats stay yours.',
    not_a_person: 'Someone you chose is no longer on this Hub. Refresh and choose again.',
    setting_off: 'Public profile cards are turned off on this Hub. The owner can turn them on.',
    account_closed: 'This account was removed from the Hub.',
    identity_taken: 'This identity is already linked to someone else on this Hub.',
    already_linked: 'Your account already has an identity from this provider. Unlink it first.',
    discovery:
      'The Hub could not reach the sign-in provider. Check the issuer address and that the Hub can reach it.',
    capability_missing: 'This part of the Hub is not running yet. Try again in a moment.',
  },
  pluginsGone: 'These plugins are no longer installed: {plugins}.',
  pluginGone: 'A chosen plugin is no longer installed.',
  handleTaken: 'This handle is taken. Choose another.',
  alreadyPurged: 'Their data was already deleted.',
  notListed: 'This person is no longer listed. Refresh the page.',
});

/** The Hub's own words for a refusal (English, D9), as a sentence; else `fallback`. */
function hubSentence(err: ApiError, fallback: string): string {
  return err.body.message ? `${capitalize(err.body.message).replace(/\.$/, '')}.` : fallback;
}

export function teamErrorMessage(err: unknown, fallback: string = ERROR_TEXT.fallback): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const d = err.body.details ?? {};
  const reason = reasonOf(err);
  switch (reason) {
    case 'owner_only':
      return TEAM_TEXT.ownerOnly;
    case 'address_rate_limited':
      return ERROR_TEXT.reason.rate_limited;
    case 'unknown_plugin': {
      const list = Array.isArray(d.plugins) ? (d.plugins as unknown[]).map(String) : [];
      return list.length
        ? ERROR_TEXT.pluginsGone({ plugins: fmt.list(list) })
        : ERROR_TEXT.pluginGone;
    }
    case 'conflict':
      if (str(d.field) === 'handle') return ERROR_TEXT.handleTaken;
      return hubSentence(err, fallback);
    case 'validation':
      return firstIssue(d) ?? hubSentence(err, fallback);
    default:
      return (
        (reason ? messageFor(ERROR_TEXT.reason, reason) : undefined) ?? hubSentence(err, fallback)
      );
  }
}

function firstIssue(d: Record<string, unknown>): string | null {
  if (!Array.isArray(d.issues)) return null;
  for (const i of d.issues as unknown[]) {
    if (!i || typeof i !== 'object') continue;
    const m = str((i as { message?: unknown }).message);
    if (m) return `${capitalize(m).replace(/\.$/, '')}.`;
  }
  return null;
}

/** The fields a validation refusal names, by path (`handle`, `issuer`…). */
export function errorFields(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.body.code !== 'validation') return {};
  const d = err.body.details ?? {};
  const out: Record<string, string> = {};
  if (Array.isArray(d.issues)) {
    for (const i of d.issues as unknown[]) {
      if (!i || typeof i !== 'object') continue;
      const p = str((i as { path?: unknown }).path);
      const m = str((i as { message?: unknown }).message);
      if (p && m) out[p] ??= `${capitalize(m).replace(/\.$/, '')}.`;
    }
  }
  return out;
}

// ---- OIDC sign-in that came back with `?oidc_error=` ----------------------------------------

/** By the callback's `oidc_error` reason. */
const OIDC_TEXT = defineMessages('team.signInRefusals', {
  state_invalid: 'This sign-in expired or was already used. Start again.',
  provider_error: 'The sign-in provider did not sign you in. Nothing changed on this Hub.',
  provider_disabled: 'This sign-in provider was turned off on this Hub.',
  not_linked:
    'This identity is not linked to anyone on this Hub. Sign in another way and link it in Settings → Account, or ask the owner for an invitation.',
  account_closed: 'This account was removed from the Hub. Ask the owner for a new invitation.',
  identity_taken: 'This identity is already linked to someone else on this Hub.',
  already_linked: 'Your account already has an identity from this provider.',
  invitation_invalid:
    'The invitation was used, withdrawn or has expired. Ask the owner of the Hub for a new link.',
  oidc_discovery:
    'The Hub could not reach the sign-in provider. Try again later, or tell the owner of the Hub.',
  oidc_token_exchange:
    'The sign-in provider did not accept the Hub’s request. The owner should check the client id and secret.',
  oidc_expired:
    'The sign-in answer was out of date. Check that the clocks of the Hub and this device are right, then try again.',
  /** The provider's answer failed one of the Hub's checks (`oidc_<check>`). */
  oidc_malformed:
    'The sign-in provider’s answer did not pass the Hub’s checks: its answer could not be read. Nobody was signed in.',
  oidc_algorithm:
    'The sign-in provider’s answer did not pass the Hub’s checks: it signed with a method the Hub does not accept. Nobody was signed in.',
  oidc_key:
    'The sign-in provider’s answer did not pass the Hub’s checks: its signing key is unknown. Nobody was signed in.',
  oidc_signature:
    'The sign-in provider’s answer did not pass the Hub’s checks: the signature did not verify. Nobody was signed in.',
  oidc_issuer:
    'The sign-in provider’s answer did not pass the Hub’s checks: it came from another issuer. Nobody was signed in.',
  oidc_audience:
    'The sign-in provider’s answer did not pass the Hub’s checks: it was meant for another app. Nobody was signed in.',
  oidc_nonce:
    'The sign-in provider’s answer did not pass the Hub’s checks: it was not an answer to this sign-in. Nobody was signed in.',
  oidc_subject:
    'The sign-in provider’s answer did not pass the Hub’s checks: it did not say who you are. Nobody was signed in.',
  other: 'The sign-in was refused. Try again, or sign in another way.',
});

/**
 * Why the Hub refused a sign-in, in plain words (the callback's `oidc_error` reason). Unknown
 * reasons still read as a refusal; the raw code is never the whole message.
 */
export function oidcErrorText(reason: string): string {
  const key = reason === 'oidc_not_yet_valid' ? 'oidc_expired' : reason;
  return (key === 'other' ? undefined : messageFor(OIDC_TEXT, key)) ?? OIDC_TEXT.other;
}

/** The `oidc_error` (or null) and whether an identity was just linked, from a query string. */
export function oidcReturn(search: string): { error: string | null; linked: boolean } {
  const q = new URLSearchParams(search);
  const raw = q.get('oidc_error');
  return {
    error: raw ? raw.replace(/[^a-z_]/g, '').slice(0, 40) || 'refused' : null,
    linked: q.get('oidc') === 'linked',
  };
}

// ---- shared threads ----------------------------------------------------------------------------

/** What sharing a chat never shares (FR-217, decision 5), said plainly in the share dialog. */
export const SHARING_TEXT = defineMessages('team.sharing', {
  notShared: {
    memory: 'Nobody’s memory or past chats, and nothing said here becomes anyone’s memory.',
    connectors: 'Nobody’s connectors: MCP servers, plugins, channels, devices, agents or spaces.',
    projects: 'No projects or instructions of yours.',
  },
  /** Each reply runs as the person who asked; this is what the dialog says about that. */
  actsAs:
    'Each message runs under the account of the person who wrote it: their models, permissions and approvals.',
});

// ---- M8: a removed member's data (ADR-097) ---------------------------------------------------

export const REMOVED_TEXT = defineMessages('team.removed', {
  heading: 'Removed members',
  intro:
    'What a removed member made (their chats, files, memory, settings and tokens) is kept for a while so you can export it, then deleted for good. The audit log keeps what they did.',
  keepLabel: 'Keep a removed member’s data for',
  keepFormLabel: 'How long a removed member’s data is kept',
  keepHint: 'Days before it is deleted; 0 keeps it until you delete it yourself.',
  keepInvalid: 'Enter a whole number of days from 0 to 3650.',
  keepSaved:
    '{days, plural, =0 {Removed members’ data is kept until you delete it.} one {Removed members’ data is kept for # day.} other {Removed members’ data is kept for # days.}}',
  save: 'Save',
  saveFailed: 'Could not save it.',
  loading: 'Loading removed members',
  loadFailed: 'Could not load the removed members.',
  none: 'Nobody was removed from this Hub.',
  listLabel: 'Removed members',
  removedWhen: 'Removed {when}',
  purgedName: 'A removed member (data deleted)',
  status: {
    kept: 'Kept until you delete it',
    scheduled: 'Deleted {when}',
    scheduledSoon: 'Deleted soon',
    purged: 'Deleted {when}',
    failed: 'Deleting failed; it is tried again tomorrow',
  },
  byRequest: 'when you asked',
  afterGrace: 'when the time ran out',
  failedWhy: 'Why: {why}',
  counts:
    '{rows, plural, one {# record} other {# records}} and {files, plural, one {# file} other {# files}} deleted.',
  export: 'Export their data',
  exportLabel: 'Export the data of {name}',
  cleanupPending:
    'Some of their files and secrets are still being removed; the next hourly sweep finishes it.',
  exportUnavailable: 'Exporting one member’s data is not available on this Hub yet.',
  purge: 'Delete now',
  purgeLabel: 'Delete the data of {name} now',
  purgeTitle: 'Delete {name}’s data for good?',
  purgeWhat:
    'Their chats, files, memory, settings, tokens, connectors and anything only they used are deleted now. Usage records stay without their chats, and the audit log keeps what they did. This cannot be undone.',
  purgeExportFirst: 'Export it first if you might need it.',
  purgeConfirm: 'I understand {name}’s data cannot be recovered',
  purgeButton: 'Delete for good',
  purgeError: 'Could not delete the data.',
  cancel: 'Cancel',
  purged: '{name}’s data was deleted.',
  purgeFailed: 'Deleting {name}’s data failed. Nothing was deleted; it is tried again tomorrow.',
  /** The removal's confirmation: what happens now and to what they made. */
  removeWhat:
    '{days, plural, =0 {Their sessions end at once on every device, their account closes and the chats shared with them stop being shared. What they made is kept until you delete it under Removed members.} one {Their sessions end at once on every device, their account closes and the chats shared with them stop being shared. What they made is kept for # day so you can export it, then deleted.} other {Their sessions end at once on every device, their account closes and the chats shared with them stop being shared. What they made is kept for # days so you can export it, then deleted.}}',
});

/** A refusal of the removed-member routes in plain words. */
export function removedErrorMessage(err: unknown, fallback: string): string {
  switch (reasonOf(err)) {
    case 'already_purged':
      return ERROR_TEXT.alreadyPurged;
    case 'export_unavailable':
      return REMOVED_TEXT.exportUnavailable;
    case 'not_found':
      return ERROR_TEXT.notListed;
    default:
      return teamErrorMessage(err, fallback);
  }
}

// ---- M8: member mode in Tools & MCP, Notifications and Channels (ADR-097 D7) -----------------

export const MEMBER_MODE_TEXT = defineMessages('team.memberMode', {
  accessUnknown:
    'Nova could not check what you may change here, so parts that may belong to the owner are hidden.',
  tools:
    'You are a member of this Hub. Your MCP servers and the defaults for your tools are your own. Servers that run as programs on the Hub, server bundles and web search belong to the owner.',
  toolsAddresses:
    'Your servers must be reachable on the internet: addresses on the Hub’s own network are refused.',
  stdioOwner: 'Running a command on the Hub is for its owner only.',
  webSearchHeading: 'Web search',
  webSearch: 'The owner of this Hub sets the web search service everyone uses.',
  notifications:
    'You are a member of this Hub. Where your notifications go and which of your devices get them are yours to choose.',
  categoriesHeading: 'What to notify you about',
  categories: 'The owner of this Hub chooses which kinds of notifications Nova shows and sends.',
  pushHub:
    'The owner of this Hub decides whether push notifications are sent at all and how much they say.',
  channels:
    'You are a member of this Hub. Your channels, and the people they answer, are your own.',
  channelsOwnerHeading: 'Set by the owner',
  channelsOwner:
    'The owner of this Hub sets the public address other services reach it at, and what happens when a reply in a shared channel would use a private detail.',
  mailAddresses:
    'Mail servers must be reachable on the internet: addresses on the Hub’s own network are refused.',
});
