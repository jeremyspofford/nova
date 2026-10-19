// M7 team: API shapes (owned by the team area; FR-217, FR-091, FR-113, FR-045 per agent;
// decision 5 of ADR-095, docs/13 §7). Several people use one Hub: the owner invites members with a
// one-use link; each member has their own account (memory, connectors, sessions). Threads can be
// shared between them, team agents work under their own identity, and an OIDC provider and an
// opt-in public profile card are optional.
import { z } from 'zod';
import {
  RUN_AUTONOMY,
  idSchema,
  providerKindSchema,
  type MessageView,
  type ThreadView,
} from '../api.ts';
import { EGRESS_CREDENTIAL_SCHEMES, hostPatternSchema } from '../m6/computers.ts';

// ---- people ---------------------------------------------------------------------------------

export const TEAM_ROLES = ['owner', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** A person of the Hub, as other people of the Hub see them (no email, no sessions). */
export interface TeamPersonView {
  accountId: string;
  displayName: string | null;
  username: string | null;
  role: TeamRole;
  hasAvatar: boolean;
}

/** GET /api/v1/team/members: the owner sees invitations and removal too. */
export interface TeamMemberView extends TeamPersonView {
  joinedAt: string | null;
  invitedBy: string | null;
  /** The account behind the request. */
  you: boolean;
}

/** GET /api/v1/team/me. */
export interface TeamMeView extends TeamPersonView {
  /** Linked OIDC identities (FR-113). */
  identities: OidcIdentityView[];
}

// ---- invitations (decision 5) -----------------------------------------------------------------

/** How long an invitation link is valid by default, and at most (hours). */
export const INVITATION_DEFAULT_HOURS = 72;
export const INVITATION_MAX_HOURS = 720;

/** POST /api/v1/team/invitations (owner). */
export const createInvitationSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    ttlHours: z.number().int().min(1).max(INVITATION_MAX_HOURS).optional(),
  })
  .strict();
export type CreateInvitationRequest = z.infer<typeof createInvitationSchema>;

export const INVITATION_STATUSES = ['pending', 'redeemed', 'expired', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface InvitationView {
  id: string;
  label: string | null;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
}

/** The token is shown once; the link carries it in the fragment, which browsers never send. */
export interface CreatedInvitationView {
  invitation: InvitationView;
  token: string;
  url: string;
}

const invitationToken = z.string().min(20).max(200);

/** POST /api/v1/team/join/preview (public; the token authenticates). */
export const joinPreviewSchema = z.object({ token: invitationToken }).strict();

export interface JoinPreviewView {
  valid: boolean;
  label: string | null;
  invitedBy: string | null;
  expiresAt: string | null;
  /** OIDC providers the new member may sign up with instead of a local account. */
  providers: { id: string; label: string }[];
}

/** POST /api/v1/team/join (public; the one-use token authenticates). */
export const joinTeamSchema = z
  .object({
    token: invitationToken,
    displayName: z.string().trim().min(1).max(100),
  })
  .strict();
export type JoinTeamRequest = z.infer<typeof joinTeamSchema>;

// ---- OIDC (FR-113, docs/13 §7) -------------------------------------------------------------------

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** An issuer: https (http only on this machine), no credentials, query or fragment. */
export const oidcIssuerSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      const ok = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname));
      return ok && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, 'an https:// issuer URL (http:// only on this machine), without credentials, query or fragment');

const oidcScopes = z
  .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/))
  .min(1)
  .max(20)
  .refine((s) => s.includes('openid'), 'the scopes must include openid');

/** POST /api/v1/team/oidc (owner). `clientSecret` is write-only and goes to the vault. */
export const createOidcProviderSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    issuer: oidcIssuerSchema,
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().min(1).max(4000).optional(),
    scopes: oidcScopes.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type CreateOidcProviderRequest = z.infer<typeof createOidcProviderSchema>;

/** PATCH /api/v1/team/oidc/:id (owner). `clientSecret: null` removes the secret. */
export const updateOidcProviderSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    clientId: z.string().trim().min(1).max(500).optional(),
    clientSecret: z.string().min(1).max(4000).nullable().optional(),
    scopes: oidcScopes.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateOidcProviderRequest = z.infer<typeof updateOidcProviderSchema>;

export interface OidcProviderView {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  /** The secret itself is never returned. */
  hasClientSecret: boolean;
  scopes: string[];
  enabled: boolean;
  /** The callback to register at the provider. */
  redirectPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface OidcIdentityView {
  id: string;
  providerId: string;
  providerLabel: string;
  subject: string;
  email: string | null;
  linkedAt: string;
  lastSignInAt: string | null;
}

export const OIDC_FLOWS = ['sign_in', 'join', 'link'] as const;
export type OidcFlow = (typeof OIDC_FLOWS)[number];

/**
 * POST /api/v1/auth/oidc/start (public for `sign_in` and `join`; `link` needs a session). `join`
 * carries the invitation token: the new member's account is created at the callback.
 */
export const oidcStartSchema = z
  .object({
    providerId: idSchema,
    flow: z.enum(OIDC_FLOWS).default('sign_in'),
    invitation: invitationToken.optional(),
    displayName: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => v.flow !== 'join' || !!v.invitation, {
    message: 'joining needs the invitation',
    path: ['invitation'],
  });
export type OidcStartRequest = z.input<typeof oidcStartSchema>;

export interface OidcStartView {
  /** Where the browser goes to sign in. */
  url: string;
  expiresAt: string;
}

// ---- public profile card (FR-113) ----------------------------------------------------------------

export const profileHandleSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{2,39}$/, '3-40 lowercase letters, digits, - or _');

/** PUT /api/v1/team/me/card. Off by default; the card shows only what is listed here. */
export const profileCardSchema = z
  .object({
    enabled: z.boolean(),
    handle: profileHandleSchema,
    showAvatar: z.boolean().optional(),
  })
  .strict();
export type ProfileCardRequest = z.infer<typeof profileCardSchema>;

export interface ProfileCardView {
  /** The Hub allows public cards at all (`team.publicProfiles`, the owner's switch). */
  allowed: boolean;
  enabled: boolean;
  handle: string | null;
  showAvatar: boolean;
  /** The public page path (`/api/v1/profiles/<handle>`), when enabled. */
  path: string | null;
}

/** GET /api/v1/profiles/:handle (public, read-only). */
export interface PublicProfileView {
  handle: string;
  displayName: string | null;
  avatarPath: string | null;
}

// ---- shared threads (FR-217) ---------------------------------------------------------------------

/** POST /api/v1/team/threads/:id/share: who else may read and write in the thread. */
export const shareThreadSchema = z
  .object({ accountIds: z.array(idSchema).min(1).max(50) })
  .strict();
export type ShareThreadRequest = z.infer<typeof shareThreadSchema>;

export interface SharedThreadView {
  thread: ThreadView;
  owner: TeamPersonView;
  participants: TeamPersonView[];
  /** The account behind the request is the thread's owner, or a participant. */
  you: 'owner' | 'participant';
  sharedAt: string;
}

/** Who wrote a message of a shared thread; a reply names who asked for it. */
export interface SharedAuthorView {
  accountId: string;
  displayName: string | null;
  /** `wrote` for the person's own messages, `asked` for Nova's reply to them. */
  as: 'wrote' | 'asked';
}

export interface SharedThreadDetailView extends SharedThreadView {
  messages: MessageView[];
  /** By message id. */
  authors: Record<string, SharedAuthorView>;
}

// ---- specialist/team agents (FR-091) ------------------------------------------------------------

/** POST /api/v1/team/agents (owner): an agent with its own identity, not a person's account. */
export const createTeamAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    instructions: z.string().max(16_000).optional(),
    responsibilities: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            instructions: z.string().trim().max(4000).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    autonomy: z.enum(RUN_AUTONOMY).optional(),
    model: z.string().max(300).optional(),
  })
  .strict();
export type CreateTeamAgentRequest = z.infer<typeof createTeamAgentSchema>;

/** POST /api/v1/team/agents/:id/credentials (owner). Values are write-only (the vault keeps them). */
export const teamAgentCredentialSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('provider'),
      provider: providerKindSchema,
      label: z.string().trim().min(1).max(100),
      baseUrl: z.url().max(500).optional(),
      apiKey: z.string().min(1).max(4000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('egress'),
      label: z.string().trim().min(1).max(100),
      hosts: z.array(hostPatternSchema).min(1).max(50),
      scheme: z.enum(EGRESS_CREDENTIAL_SCHEMES),
      header: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,100}$/)
        .optional(),
      username: z.string().max(200).optional(),
      value: z.string().min(1).max(16_384),
    })
    .strict(),
]);
export type TeamAgentCredentialRequest = z.infer<typeof teamAgentCredentialSchema>;

export interface TeamAgentCredentialView {
  id: string;
  kind: 'provider' | 'egress';
  label: string;
  /** The provider account or egress credential in the agent's identity account. */
  refId: string;
  /** `secret://` reference only. */
  secretRef: string | null;
  createdAt: string;
}

export interface TeamAgentView {
  agentId: string;
  /** The agent's own identity account (never signs in). */
  identityAccountId: string;
  name: string;
  status: 'active' | 'paused' | 'stopped';
  autonomy: string;
  createdBy: string;
  createdAt: string;
  credentials: TeamAgentCredentialView[];
}

/** POST /api/v1/team/agents/:id/tasks: any person of the Hub may give a team agent a task. */
export const teamTaskSchema = z.object({ text: z.string().trim().min(1).max(8000) }).strict();
export type TeamTaskRequest = z.infer<typeof teamTaskSchema>;

export const TEAM_TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export interface TeamTaskView {
  id: string;
  agentId: string;
  requestedBy: string;
  text: string;
  status: TeamTaskStatus;
  result: string | null;
  error: string | null;
  threadId: string | null;
  turnId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

// ---- plugins per agent (FR-045, docs/04 §2.5) ----------------------------------------------------

/** PUT /api/v1/agents/:id/plugins. `null`: every plugin the account enabled (the default). */
export const agentPluginsSchema = z
  .object({ pluginIds: z.array(z.string().min(1).max(200)).max(100).nullable() })
  .strict();
export type AgentPluginsRequest = z.infer<typeof agentPluginsSchema>;

export interface AgentPluginsView {
  agentId: string;
  pluginIds: string[] | null;
}

// ---- a member's own preferences ------------------------------------------------------------------

/** Setting keys a member keeps for themself; every other setting is the Hub's (the owner's). */
export const MEMBER_SETTING_PREFIXES = ['appearance.', 'keyboard.', 'onboarding.'] as const;

export function isMemberSettingKey(key: string): boolean {
  return MEMBER_SETTING_PREFIXES.some((p) => key.startsWith(p));
}

/** PATCH /api/v1/team/me/settings. */
export const patchMemberSettingSchema = z
  .object({ key: z.string().min(1).max(200), value: z.unknown() })
  .strict();
export type PatchMemberSettingRequest = z.infer<typeof patchMemberSettingSchema>;
