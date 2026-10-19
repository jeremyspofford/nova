// Hub client calls for the team area (FR-217, FR-091, FR-113, FR-045 per agent; decision 5 of
// ADR-095, docs/13 §7), in the conventions of src/api.ts: people and invitations, a member's own
// preferences, the public profile card, OIDC providers and linked identities, shared threads and
// team agents, and plugins per agent. `createApi` spreads `teamApi(call)` into the client, so `Api`
// includes these; until then `useTeamApi` reads them from the services object.
import type { z } from 'zod';
import type {
  AgentPluginsView,
  ApprovalView,
  AuditEntryView,
  CreatedInvitationView,
  CreateTeamAgentRequest,
  DecideApprovalRequest,
  InvitationView,
  OidcProviderView,
  OidcStartRequest,
  OidcStartView,
  Page,
  ProfileCardRequest,
  ProfileCardView,
  SendMessageRequest,
  SendMessageResponse,
  SharedThreadDetailView,
  SharedThreadView,
  TeamAgentCredentialView,
  TeamAgentView,
  TeamMemberView,
  TeamMeView,
  TeamTaskView,
  createInvitationSchema,
  createOidcProviderSchema,
  teamAgentCredentialSchema,
  updateOidcProviderSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

export type CreateInvitationBody = z.input<typeof createInvitationSchema>;
export type CreateOidcProviderBody = z.input<typeof createOidcProviderSchema>;
export type UpdateOidcProviderBody = z.input<typeof updateOidcProviderSchema>;
export type TeamAgentCredentialBody = z.input<typeof teamAgentCredentialSchema>;

/** `GET /api/v1/team/me/settings`: the member's own value, or the default. */
export type MemberSettings = Record<string, { value: unknown; source: 'default' | 'member' }>;

export interface TeamAuditQuery {
  kind?: string;
  cursor?: string;
  limit?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function teamApi(call: HubCall) {
  return {
    // ---- people (decision 5) -------------------------------------------------------------------
    /** The signed-in person: role and linked identities. */
    getTeamMe: () => call<TeamMeView>('GET', `${V1}/team/me`),
    /** Everyone on the Hub, the owner first; any person may list them (to share a thread). */
    listTeamMembers: () => call<{ items: TeamMemberView[] }>('GET', `${V1}/team/members`),
    /** Owner only. Their sessions end at once; 400 `validation` for the owner themself. */
    removeTeamMember: (accountId: string) =>
      call<{ sessionsEnded: number }>('DELETE', `${V1}/team/members/${enc(accountId)}`),

    // ---- invitations (owner) -------------------------------------------------------------------
    listTeamInvitations: () => call<{ items: InvitationView[] }>('GET', `${V1}/team/invitations`),
    /** The link carries a one-use token in its fragment; it is shown once. */
    createTeamInvitation: (body: CreateInvitationBody = {}) =>
      call<CreatedInvitationView>('POST', `${V1}/team/invitations`, body),
    /** A pending invitation becomes unusable; others come back unchanged. */
    revokeTeamInvitation: (id: string) =>
      call<InvitationView>('DELETE', `${V1}/team/invitations/${enc(id)}`),

    // ---- a member's own preferences ----------------------------------------------------------
    getMemberSettings: () => call<{ settings: MemberSettings }>('GET', `${V1}/team/me/settings`),
    /** 403 `policy_denied` (`owner_only`) for a key that belongs to the Hub. */
    setMemberSetting: (key: string, value: unknown) =>
      call<{ settings: MemberSettings }>('PATCH', `${V1}/team/me/settings`, { key, value }),

    // ---- public profile card (FR-113) ----------------------------------------------------------
    getProfileCard: () => call<ProfileCardView>('GET', `${V1}/team/me/card`),
    /** 403 `setting_off` while the Hub's switch is off; 409 `conflict` for a taken handle. */
    setProfileCard: (body: ProfileCardRequest) =>
      call<ProfileCardView>('PUT', `${V1}/team/me/card`, body),

    // ---- OIDC (FR-113, docs/13 §7) -----------------------------------------------------------
    listOidcProviders: () => call<{ items: OidcProviderView[] }>('GET', `${V1}/team/oidc`),
    /** 409 `conflict` for an issuer that is already configured. */
    createOidcProvider: (body: CreateOidcProviderBody) =>
      call<OidcProviderView>('POST', `${V1}/team/oidc`, body),
    /** `clientSecret: null` removes the secret; a string replaces it. */
    updateOidcProvider: (id: string, body: UpdateOidcProviderBody) =>
      call<OidcProviderView>('PATCH', `${V1}/team/oidc/${enc(id)}`, body),
    deleteOidcProvider: (id: string) => call<{ ok: true }>('DELETE', `${V1}/team/oidc/${enc(id)}`),
    /** Enabled providers by label (public): what sign-in and linking offer. */
    listPublicOidcProviders: () =>
      call<{ items: { id: string; label: string }[] }>('GET', `${V1}/auth/oidc/providers`),
    unlinkOidcIdentity: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/team/me/identities/${enc(id)}`),
    /**
     * Where the browser goes to sign in at the provider. `link` needs this session; the Hub
     * answers 503 `node_unavailable` when it cannot reach the provider.
     */
    startOidc: (body: OidcStartRequest) =>
      call<OidcStartView>('POST', `${V1}/auth/oidc/start`, body),

    // ---- shared threads (FR-217) ---------------------------------------------------------------
    listSharedThreads: () => call<{ items: SharedThreadView[] }>('GET', `${V1}/team/threads`),
    getSharedThread: (id: string) =>
      call<SharedThreadDetailView>('GET', `${V1}/team/threads/${enc(id)}`),
    /** The thread's owner shares it; 400 `not_shareable` outside plain chats. */
    shareThread: (id: string, accountIds: string[]) =>
      call<SharedThreadView>('POST', `${V1}/team/threads/${enc(id)}/share`, { accountIds }),
    /** The owner takes someone out, or a participant leaves (their own account id). */
    unshareThread: (id: string, accountId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/team/threads/${enc(id)}/share/${enc(accountId)}`),
    /** The turn runs under the account that writes (its providers, policy and approvals). */
    sendSharedMessage: (id: string, body: SendMessageRequest) =>
      call<SendMessageResponse>('POST', `${V1}/team/threads/${enc(id)}/messages`, body),
    /** Any participant may stop the running turn. */
    cancelSharedThread: (id: string) =>
      call<{ ok: true; cancelled: boolean }>('POST', `${V1}/team/threads/${enc(id)}/cancel`, {}),
    sharedThreadStreamUrl: (id: string) => `${V1}/team/threads/${enc(id)}/stream`,

    // ---- team agents (FR-091) ------------------------------------------------------------------
    /** Every person sees them; only the owner sees their credentials. */
    listTeamAgents: () => call<{ items: TeamAgentView[] }>('GET', `${V1}/team/agents`),
    provisionTeamAgent: (body: CreateTeamAgentRequest) =>
      call<TeamAgentView>('POST', `${V1}/team/agents`, body),
    getTeamAgent: (id: string) => call<TeamAgentView>('GET', `${V1}/team/agents/${enc(id)}`),
    removeTeamAgent: (id: string) => call<{ ok: true }>('DELETE', `${V1}/team/agents/${enc(id)}`),
    /** Values are write-only: only the `secret://` reference comes back. */
    addTeamAgentCredential: (id: string, body: TeamAgentCredentialBody) =>
      call<TeamAgentCredentialView>('POST', `${V1}/team/agents/${enc(id)}/credentials`, body),
    removeTeamAgentCredential: (id: string, credentialId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/team/agents/${enc(id)}/credentials/${enc(credentialId)}`),
    /** Any person may give a task (202); it runs under the agent's identity. */
    giveTeamTask: (agentId: string, text: string) =>
      call<TeamTaskView>('POST', `${V1}/team/agents/${enc(agentId)}/tasks`, { text }),
    /** The requester's own tasks; the owner sees every task. */
    listTeamTasks: (agentId?: string) =>
      call<{ items: TeamTaskView[] }>('GET', `${V1}/team/tasks${query({ agentId })}`),
    getTeamTask: (id: string) => call<TeamTaskView>('GET', `${V1}/team/tasks/${enc(id)}`),
    cancelTeamTask: (id: string) =>
      call<TeamTaskView>('POST', `${V1}/team/tasks/${enc(id)}/cancel`, {}),
    /** Owner only: everything the agent's identity did. */
    teamAgentAudit: (id: string, q: TeamAuditQuery = {}) =>
      call<Page<AuditEntryView>>('GET', `${V1}/team/agents/${enc(id)}/audit${query({ ...q })}`),
    /** Owner only: what the agent waits for. */
    teamAgentApprovals: (id: string) =>
      call<{ items: ApprovalView[] }>('GET', `${V1}/team/agents/${enc(id)}/approvals`),
    decideTeamAgentApproval: (
      id: string,
      approvalId: string,
      body: Omit<DecideApprovalRequest, 'approvalId'>,
    ) =>
      call<ApprovalView>('POST', `${V1}/team/agents/${enc(id)}/approvals/${enc(approvalId)}`, body),

    // ---- plugins per agent (FR-045, docs/04 §2.5) --------------------------------------------
    getAgentPlugins: (agentId: string) =>
      call<AgentPluginsView>('GET', `${V1}/agents/${enc(agentId)}/plugins`),
    /** `null`: every plugin the account enabled. 400 `unknown_plugin` for one not installed. */
    setAgentPlugins: (agentId: string, pluginIds: string[] | null) =>
      call<AgentPluginsView>('PUT', `${V1}/agents/${enc(agentId)}/plugins`, { pluginIds }),
  };
}

export type TeamApi = ReturnType<typeof teamApi>;

/** The team calls of the app's client (part of `Api` once `createApi` spreads them). */
export function useTeamApi(): TeamApi {
  const api: unknown = useServices().api;
  return api as TeamApi;
}
