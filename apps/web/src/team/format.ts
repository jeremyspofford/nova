// Paths, words and pure helpers for the team area (FR-217, FR-091, FR-113; decision 5 of ADR-095):
// where each part lives, what each role, status and refusal is called, how a sign-in that came back
// with `?oidc_error=` reads, and the plain wording of what a shared chat does not share. Statuses
// the Hub may add later fall back to a neutral chip with the raw word, never a crash.
import type { InvitationStatus, OidcProviderView, TeamRole, TeamTaskStatus } from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import type { ChipSpec } from '../netsurface/format.ts';

const enc = encodeURIComponent;

// ---- paths -----------------------------------------------------------------------------------

export const TEAM_PATH = '/team';
export const TEAM_SECTIONS = ['shared', 'agents'] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];

export const TEAM_SECTION_INFO: Record<TeamSection, { label: string; description: string }> = {
  shared: { label: 'Shared chats', description: 'Chats you share with people of this Hub' },
  agents: {
    label: 'Team agents',
    description: 'Agents with their own identity that anyone here can give a task',
  },
};

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

export const ROLE_TEXT: Record<TeamRole, string> = { owner: 'Owner', member: 'Member' };

/** A person's name as the UI shows it: display name, then username, never "null". */
export function personName(
  p: { displayName: string | null; username?: string | null } | null | undefined,
  fallback = 'Someone',
): string {
  return p?.displayName?.trim() || p?.username?.trim() || fallback;
}

// ---- chips -----------------------------------------------------------------------------------

function lookup(table: Record<string, ChipSpec>, value: string): ChipSpec {
  return (
    table[value] ?? {
      text: value.replace(/_/g, ' '),
      tone: 'neutral',
      icon: 'alert',
    }
  );
}

const INVITATION: Record<InvitationStatus, ChipSpec> = {
  pending: { text: 'Waiting to be used', tone: 'running', icon: 'clock' },
  redeemed: { text: 'Used', tone: 'ready', icon: 'check' },
  expired: { text: 'Expired', tone: 'neutral', icon: 'clock' },
  revoked: { text: 'Withdrawn', tone: 'blocked', icon: 'stop' },
};
export const invitationChip = (s: string) => lookup(INVITATION, s);

const TASK: Record<TeamTaskStatus, ChipSpec> = {
  queued: { text: 'Queued', tone: 'neutral', icon: 'clock' },
  running: { text: 'Running', tone: 'running', icon: null },
  done: { text: 'Done', tone: 'ready', icon: 'check' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
  cancelled: { text: 'Cancelled', tone: 'neutral', icon: 'stop' },
};
export const taskChip = (s: string) => lookup(TASK, s);

const AGENT: Record<string, ChipSpec> = {
  active: { text: 'Active', tone: 'ready', icon: 'check' },
  paused: { text: 'Paused', tone: 'needs_input', icon: 'clock' },
  stopped: { text: 'Stopped', tone: 'blocked', icon: 'stop' },
};
export const teamAgentChip = (s: string) => lookup(AGENT, s);

export function providerChip(p: Pick<OidcProviderView, 'enabled'>): ChipSpec {
  return p.enabled
    ? { text: 'On', tone: 'ready', icon: 'check' }
    : { text: 'Off', tone: 'neutral', icon: 'stop' };
}

/** "in 3 days", "in 5 h", "in 10 min", or "now" for a moment that has passed. */
export function untilText(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${Math.max(min, 1)} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

/** How long an invitation stays valid, as the expiry choices show it. */
export const INVITATION_HOURS: { hours: number; label: string }[] = [
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

// ---- refusals --------------------------------------------------------------------------------

/** What a member sees on a part of the Hub only its owner may change. */
export const OWNER_ONLY_TEXT = 'Only the owner of this Hub can change this.';

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

export function teamErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const d = err.body.details ?? {};
  switch (reasonOf(err)) {
    case 'owner_only':
      return OWNER_ONLY_TEXT;
    case 'invitation_invalid':
      return 'This invitation cannot be used: it was used, withdrawn or has expired. Ask the owner of the Hub for a new link.';
    case 'rate_limited':
    case 'address_rate_limited':
      return 'Too many tries from this address. Wait a minute and try again.';
    case 'not_shareable':
      return 'Only a chat outside a project can be shared. Temporary chats and side chats stay yours.';
    case 'not_a_person':
      return 'Someone you chose is no longer on this Hub. Refresh and choose again.';
    case 'setting_off':
      return 'Public profile cards are turned off on this Hub. The owner can turn them on.';
    case 'unknown_plugin': {
      const list = Array.isArray(d.plugins) ? (d.plugins as unknown[]).map(String) : [];
      return list.length
        ? `These plugins are no longer installed: ${list.join(', ')}.`
        : 'A chosen plugin is no longer installed.';
    }
    case 'account_closed':
      return 'This account was removed from the Hub.';
    case 'identity_taken':
      return 'This identity is already linked to someone else on this Hub.';
    case 'already_linked':
      return 'Your account already has an identity from this provider. Unlink it first.';
    case 'discovery':
      return 'The Hub could not reach the sign-in provider. Check the issuer address and that the Hub can reach it.';
    case 'capability_missing':
      return 'This part of the Hub is not running yet. Try again in a moment.';
    case 'conflict':
      if (str(d.field) === 'handle') return 'This handle is taken. Choose another.';
      return err.body.message ? `${capitalize(err.body.message).replace(/\.$/, '')}.` : fallback;
    case 'validation': {
      const issue = firstIssue(d);
      if (issue) return issue;
      return err.body.message ? `${capitalize(err.body.message).replace(/\.$/, '')}.` : fallback;
    }
    default:
      return err.body.message ? `${capitalize(err.body.message).replace(/\.$/, '')}.` : fallback;
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

const CHECKS: Record<string, string> = {
  malformed: 'its answer could not be read',
  algorithm: 'it signed with a method the Hub does not accept',
  key: 'its signing key is unknown',
  signature: 'the signature did not verify',
  issuer: 'it came from another issuer',
  audience: 'it was meant for another app',
  nonce: 'it was not an answer to this sign-in',
  subject: 'it did not say who you are',
};

/**
 * Why the Hub refused a sign-in, in plain words (the callback's `oidc_error` reason). Unknown
 * reasons still read as a refusal; the raw code is never the whole message.
 */
export function oidcErrorText(reason: string): string {
  switch (reason) {
    case 'state_invalid':
      return 'This sign-in expired or was already used. Start again.';
    case 'provider_error':
      return 'The sign-in provider did not sign you in. Nothing changed on this Hub.';
    case 'provider_disabled':
      return 'This sign-in provider was turned off on this Hub.';
    case 'not_linked':
      return 'This identity is not linked to anyone on this Hub. Sign in another way and link it in Settings → Account, or ask the owner for an invitation.';
    case 'account_closed':
      return 'This account was removed from the Hub. Ask the owner for a new invitation.';
    case 'identity_taken':
      return 'This identity is already linked to someone else on this Hub.';
    case 'already_linked':
      return 'Your account already has an identity from this provider.';
    case 'invitation_invalid':
      return 'The invitation was used, withdrawn or has expired. Ask the owner of the Hub for a new link.';
    case 'oidc_discovery':
      return 'The Hub could not reach the sign-in provider. Try again later, or tell the owner of the Hub.';
    case 'oidc_token_exchange':
      return 'The sign-in provider did not accept the Hub’s request. The owner should check the client id and secret.';
    case 'oidc_expired':
    case 'oidc_not_yet_valid':
      return 'The sign-in answer was out of date. Check that the clocks of the Hub and this device are right, then try again.';
    default: {
      const check = reason.startsWith('oidc_') ? CHECKS[reason.slice(5)] : undefined;
      return check
        ? `The sign-in provider’s answer did not pass the Hub’s checks: ${check}. Nobody was signed in.`
        : 'The sign-in was refused. Try again, or sign in another way.';
    }
  }
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
export const NOT_SHARED: string[] = [
  'Nobody’s memory or past chats, and nothing said here becomes anyone’s memory.',
  'Nobody’s connectors: MCP servers, plugins, channels, devices, agents or spaces.',
  'No projects or instructions of yours.',
];

/** Each reply runs as the person who asked; this is what the dialog says about that. */
export const SHARED_ACTS_AS =
  'Each message runs under the account of the person who wrote it: their models, permissions and approvals.';
