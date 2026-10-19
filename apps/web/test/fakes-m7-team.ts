// The fake Hub's M7 team part: people and invitations, a member's own settings, the public
// profile card, OIDC providers and identities, shared threads and team agents, in memory, with the
// Hub's rules from apps/hub/src/team.ts and packages/core/src/team/*:
// - The member guard: a member gets 403 `policy_denied` (`owner_only`) for the owner's routes
//   (invitations, removing people, OIDC providers, provisioning and administering team agents).
// - Invitations: one-use tokens in the link's fragment, `ttlHours` clamped to 1..720; withdrawing
//   a pending one revokes it, others come back unchanged; 404 for an unknown id. Removing a member
//   answers how many sessions ended; the owner cannot remove themself (400), a non-member is 404.
// - Member settings: only `appearance.`, `keyboard.` and `onboarding.` keys (403 `owner_only`).
// - Card: turning it on while `team.publicProfiles` is off is 403 `setting_off`; a handle someone
//   else has is 409 `conflict` (`field: handle`); a malformed handle is 400 with issues.
// - OIDC: a second provider with the same issuer is 409; `clientSecret: null` removes it; start is
//   404 for an unknown or disabled provider and 503 `node_unavailable` (`discovery`) when the
//   provider cannot be reached; unlinking an unknown identity is 404.
// - Shared threads: only a plain chat outside a project (400 `not_shareable`), only people of the
//   Hub (400 `not_a_person`); the owner takes people out, a participant only themself (403
//   `owner_only`); someone who cannot see a thread gets 404 everywhere.
// - Team agents: everyone lists them (credentials only for the owner); tasks are the requester's
//   own (the owner sees all); cancelling someone else's task is 404; deciding a decided approval
//   is 409; plugins per agent refuse uninstalled ids (400 `unknown_plugin`).
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m7team: M7TeamState`,
// `createHub` defaults it to `m7TeamState()`, and `impl` spreads
// `...m7TeamImpl(state.m7team, { id, ts: () => ts(), maybeFail, threads: () => state.threads,
// setting: (k) => resolveSetting(k, layers()).value, plugins: () => state.m4.plugins.map((p) =>
// p.id) })`. Until then tests build the client with `createTeamHub()` and spread its `api` over
// `createHub().api` (see `renderWithTeam`).
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  SETTINGS,
  createOidcProviderSchema,
  isMemberSettingKey,
  profileHandleSchema,
  resolveSetting,
  type ApprovalView,
  type AuditEntryView,
  type InvitationView,
  type MessageView,
  type OidcIdentityView,
  type OidcProviderView,
  type ProfileCardView,
  type SettingKey,
  type SettingValue,
  type TeamAgentCredentialView,
  type TeamAgentView,
  type TeamPersonView,
  type TeamRole,
  type TeamTaskView,
  type ThreadView,
} from '@nova/shared';
import type { z } from 'zod';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import type { MemberSettings, TeamApi } from '../src/team/api.ts';
import { TeamRoleProvider, memberSettingsApi } from '../src/team/role.tsx';
import {
  DONE_ONBOARDING,
  createHub,
  fakeEventSource,
  message,
  testRegistry,
  thread,
} from './fakes.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;
const nid = (p: string) => `${p}${++n}`;
let clock = 0;
const nextTs = () => new Date(Date.parse(T0) + ++clock * 1000).toISOString();

export const OWNER_ID = 'acc-owner';
export const MEMBER_ID = 'acc-alex';

// ---- builders ----------------------------------------------------------------------------------

export interface FakePerson extends TeamPersonView {
  joinedAt: string | null;
  invitedBy: string | null;
  sessions: number;
}

export function person(over: Partial<FakePerson> = {}): FakePerson {
  return {
    accountId: nid('acc'),
    displayName: 'Someone',
    username: null,
    role: 'member',
    hasAvatar: false,
    joinedAt: T0,
    invitedBy: OWNER_ID,
    sessions: 1,
    ...over,
  };
}

export function invitation(over: Partial<InvitationView> = {}): InvitationView {
  return {
    id: nid('inv'),
    label: null,
    status: 'pending',
    createdAt: T0,
    expiresAt: '2026-10-04T12:00:00.000Z',
    redeemedAt: null,
    redeemedBy: null,
    ...over,
  };
}

export function oidcProvider(over: Partial<OidcProviderView> = {}): OidcProviderView {
  return {
    id: nid('oidc'),
    label: 'Company sign-in',
    issuer: 'https://accounts.example.com',
    clientId: 'nova-hub',
    hasClientSecret: true,
    scopes: ['openid', 'profile', 'email'],
    enabled: true,
    redirectPath: '/api/v1/auth/oidc/callback',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function identity(over: Partial<OidcIdentityView> = {}): OidcIdentityView {
  return {
    id: nid('idn'),
    providerId: 'oidc-x',
    providerLabel: 'Company sign-in',
    subject: 'sub-123',
    email: 'sam@example.com',
    linkedAt: T0,
    lastSignInAt: null,
    ...over,
  };
}

export function teamAgent(over: Partial<TeamAgentView> = {}): TeamAgentView {
  return {
    agentId: nid('ta'),
    identityAccountId: nid('acc-id'),
    name: 'Support desk',
    status: 'active',
    autonomy: 'standard',
    createdBy: OWNER_ID,
    createdAt: T0,
    credentials: [],
    ...over,
  };
}

export function teamTask(over: Partial<TeamTaskView> = {}): TeamTaskView {
  return {
    id: nid('task'),
    agentId: 'ta-x',
    requestedBy: OWNER_ID,
    text: 'Answer the open support mail',
    status: 'done',
    result: 'Answered 3 messages.',
    error: null,
    threadId: null,
    turnId: null,
    createdAt: T0,
    startedAt: T0,
    endedAt: T0,
    ...over,
  };
}

export function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: nid('ap'),
    threadId: null,
    turnId: null,
    callId: null,
    action: 'Send an email to billing@example.com',
    tool: 'mail.send',
    argsPreview: '{"to":"billing@example.com"}',
    reason: 'Sending mail leaves the Hub',
    tier: 'pre_approvable',
    risk: 'medium',
    userAsked: false,
    ruleId: null,
    options: ['allow_once', 'allow_session', 'allow_always', 'deny_continue', 'deny_stop'],
    alwaysScopes: [],
    status: 'pending',
    decision: null,
    decidedBy: null,
    createdAt: T0,
    expiresAt: '2026-10-01T13:00:00.000Z',
    decidedAt: null,
    ...over,
  };
}

export function auditEntry(over: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    id: nid('au'),
    actor: 'agent:ta-x',
    kind: 'agent',
    action: 'tool.call',
    resource: 'mail.send',
    decision: 'allow',
    result: 'ok',
    threadId: null,
    turnId: null,
    createdAt: T0,
    hash: 'h',
    ...over,
  };
}

// ---- state -------------------------------------------------------------------------------------

export interface SharedThreadRecord {
  thread: ThreadView;
  owner: string;
  participants: string[];
  sharedAt: string | null;
  messages: MessageView[];
  /** Who wrote each user message (by id); replies are asked for by the turn's writer. */
  writers: Record<string, string>;
  running: boolean;
}

export interface M7TeamState {
  /** The account behind the requests. */
  me: string;
  people: (FakePerson & { removed?: boolean })[];
  invitations: (InvitationView & { token?: string })[];
  memberSettings: Record<string, Record<string, unknown>>;
  cards: Record<string, { enabled: boolean; handle: string; showAvatar: boolean }>;
  /** `team.publicProfiles` when no setting reader is given. */
  publicProfiles: boolean;
  providers: (OidcProviderView & { secret?: string | null })[];
  identities: Record<string, OidcIdentityView[]>;
  /** Whether the Hub can reach the providers (discovery). */
  reachable: boolean;
  /** Where `startOidc` sends the browser. */
  authorizeUrl: string;
  threads: Record<string, SharedThreadRecord>;
  agents: TeamAgentView[];
  tasks: TeamTaskView[];
  approvals: Record<string, ApprovalView[]>;
  audit: Record<string, AuditEntryView[]>;
  agentPlugins: Record<string, string[] | null>;
}

export function m7TeamState(init: Partial<M7TeamState> = {}): M7TeamState {
  return {
    me: OWNER_ID,
    people: [
      person({
        accountId: OWNER_ID,
        displayName: 'Sam',
        username: 'sam',
        role: 'owner',
        joinedAt: null,
        invitedBy: null,
      }),
      person({ accountId: MEMBER_ID, displayName: 'Alex', sessions: 2 }),
    ],
    invitations: [],
    memberSettings: {},
    cards: {},
    publicProfiles: false,
    providers: [],
    identities: {},
    reachable: true,
    authorizeUrl: 'https://accounts.example.com/authorize?state=s1',
    threads: {},
    agents: [],
    tasks: [],
    approvals: {},
    audit: {},
    agentPlugins: {},
    ...init,
  };
}

/** A shared thread record (owner Sam, shared with Alex) with two messages. */
export function sharedThread(over: Partial<SharedThreadRecord> = {}): SharedThreadRecord {
  const t = over.thread ?? thread({ id: nid('st'), title: 'Trip planning', memoryOptOut: true });
  const ask = message(t.id, {
    id: nid('msg'),
    role: 'user',
    turnId: 'turn-1',
    parts: [{ type: 'text', text: 'Where should we go in May?' }],
  });
  const reply = message(t.id, {
    id: nid('msg'),
    role: 'assistant',
    turnId: 'turn-1',
    parts: [{ type: 'text', text: 'Lisbon is **warm** in May.' }],
  });
  return {
    thread: t,
    owner: OWNER_ID,
    participants: [MEMBER_ID],
    sharedAt: T0,
    messages: [ask, reply],
    writers: { [ask.id]: MEMBER_ID },
    running: false,
    ...over,
  };
}

// ---- errors ------------------------------------------------------------------------------------

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });
const notFound = (what: string) => fail(404, 'not_found', `${what} not found`);
const ownerOnly = () =>
  fail(403, 'policy_denied', 'only the owner of this Hub can do that', { reason: 'owner_only' });
const zodFail = (err: z.ZodError) =>
  fail(400, 'validation', 'request failed validation', {
    issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });

const copy = <T>(v: T): T => structuredClone(v);

// ---- the implementation ------------------------------------------------------------------------

export function m7TeamImpl(
  st: M7TeamState,
  helpers: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof TeamApi) => void;
    /** The owner's chats (to share one). */
    threads: () => ThreadView[];
    setting?: <K extends SettingKey>(key: K) => SettingValue<K>;
    /** Installed plugin ids (plugins per agent). */
    plugins?: () => string[];
  },
): TeamApi {
  const { id, ts, maybeFail } = helpers;
  const active = () => st.people.filter((p) => !p.removed);
  const roleOf = (accountId: string): TeamRole | null =>
    active().find((p) => p.accountId === accountId)?.role ?? null;
  const owner = () => roleOf(st.me) === 'owner';
  const needOwner = () => {
    if (!owner()) throw ownerOnly();
  };
  const view = (p: FakePerson): TeamPersonView => ({
    accountId: p.accountId,
    displayName: p.displayName,
    username: p.username,
    role: p.role,
    hasAvatar: p.hasAvatar,
  });
  const personOf = (accountId: string): TeamPersonView => {
    const p = st.people.find((x) => x.accountId === accountId);
    return p
      ? view(p)
      : { accountId, displayName: null, username: null, role: 'member', hasAvatar: false };
  };
  const publicProfiles = () =>
    helpers.setting ? helpers.setting('team.publicProfiles') : st.publicProfiles;
  const providerView = (p: M7TeamState['providers'][number]): OidcProviderView => {
    const { secret: _secret, ...rest } = p;
    return copy(rest);
  };
  const canSee = (r: SharedThreadRecord | undefined) =>
    !!r && r.sharedAt !== null && (r.owner === st.me || r.participants.includes(st.me));
  const record = (threadId: string) => {
    const r = st.threads[threadId];
    if (!canSee(r)) throw notFound('thread');
    return r!;
  };
  const sharedView = (r: SharedThreadRecord) => ({
    thread: copy({ ...r.thread, state: r.running ? ('streaming' as const) : r.thread.state }),
    owner: personOf(r.owner),
    participants: r.participants.map(personOf),
    you: r.owner === st.me ? ('owner' as const) : ('participant' as const),
    sharedAt: r.sharedAt ?? T0,
  });
  const agent = (agentId: string) => {
    const a = st.agents.find((x) => x.agentId === agentId);
    if (!a) throw notFound('team agent');
    return a;
  };
  const agentView = (a: TeamAgentView): TeamAgentView =>
    copy({ ...a, credentials: owner() ? a.credentials : [] });
  const memberSettings = (accountId: string): MemberSettings => {
    const own = st.memberSettings[accountId] ?? {};
    const out: MemberSettings = {};
    for (const key of Object.keys(SETTINGS)) {
      if (!isMemberSettingKey(key)) continue;
      out[key] =
        key in own
          ? { value: copy(own[key]), source: 'member' }
          : {
              value: resolveSetting(key as SettingKey, { global: {}, managed: {} }).value,
              source: 'default',
            };
    }
    return out;
  };
  const cardView = (accountId: string): ProfileCardView => {
    const c = st.cards[accountId];
    return {
      enabled: c?.enabled ?? false,
      handle: c?.handle ?? null,
      showAvatar: c?.showAvatar ?? true,
      path: c?.enabled ? `/api/v1/profiles/${c.handle}` : null,
      allowed: helpers.setting
        ? Boolean(helpers.setting('team.publicProfiles'))
        : st.publicProfiles,
    };
  };

  return {
    // ---- people --------------------------------------------------------------------------------
    getTeamMe: async () => {
      maybeFail('getTeamMe');
      const p = active().find((x) => x.accountId === st.me);
      if (!p) throw notFound('person');
      return { ...view(p), identities: copy(st.identities[st.me] ?? []) };
    },
    listTeamMembers: async () => {
      maybeFail('listTeamMembers');
      return {
        items: active().map((p) => ({
          ...view(p),
          joinedAt: p.joinedAt,
          invitedBy: p.invitedBy,
          you: p.accountId === st.me,
        })),
      };
    },
    removeTeamMember: async (accountId) => {
      maybeFail('removeTeamMember');
      needOwner();
      if (accountId === st.me) throw fail(400, 'validation', 'the owner cannot remove themself');
      const p = active().find((x) => x.accountId === accountId && x.role === 'member');
      if (!p) throw notFound('member');
      p.removed = true;
      for (const r of Object.values(st.threads))
        r.participants = r.participants.filter((x) => x !== accountId);
      delete st.identities[accountId];
      const ended = p.sessions;
      p.sessions = 0;
      return { sessionsEnded: ended };
    },

    // ---- invitations -------------------------------------------------------------------------
    listTeamInvitations: async () => {
      maybeFail('listTeamInvitations');
      needOwner();
      return { items: st.invitations.map(({ token: _t, ...inv }) => copy(inv)) };
    },
    createTeamInvitation: async (body = {}) => {
      maybeFail('createTeamInvitation');
      needOwner();
      const hours = Math.min(Math.max(body.ttlHours ?? 72, 1), 720);
      const created = ts();
      const inv: InvitationView & { token: string } = {
        id: id('inv'),
        label: body.label ?? null,
        status: 'pending',
        createdAt: created,
        expiresAt: new Date(Date.parse(created) + hours * 3_600_000).toISOString(),
        redeemedAt: null,
        redeemedBy: null,
        token: `nvi_${'x'.repeat(30)}${id('')}`,
      };
      st.invitations = [inv, ...st.invitations];
      const { token, ...invitation } = inv;
      return {
        invitation: copy(invitation),
        token,
        url: `http://localhost:3000/join#invite=${encodeURIComponent(token)}`,
      };
    },
    revokeTeamInvitation: async (invId) => {
      maybeFail('revokeTeamInvitation');
      needOwner();
      const inv = st.invitations.find((x) => x.id === invId);
      if (!inv) throw notFound('invitation');
      if (inv.status === 'pending') inv.status = 'revoked';
      const { token: _t, ...rest } = inv;
      return copy(rest);
    },

    // ---- member settings ---------------------------------------------------------------------
    getMemberSettings: async () => {
      maybeFail('getMemberSettings');
      return { settings: memberSettings(st.me) };
    },
    setMemberSetting: async (key, value) => {
      maybeFail('setMemberSetting');
      if (!isMemberSettingKey(key))
        throw fail(403, 'policy_denied', 'this setting belongs to the Hub, not to you', {
          reason: 'owner_only',
          key,
        });
      st.memberSettings[st.me] = { ...st.memberSettings[st.me], [key]: copy(value) };
      return { settings: memberSettings(st.me) };
    },

    // ---- card --------------------------------------------------------------------------------
    getProfileCard: async () => {
      maybeFail('getProfileCard');
      return cardView(st.me);
    },
    setProfileCard: async (body) => {
      maybeFail('setProfileCard');
      const h = profileHandleSchema.safeParse(body.handle);
      if (!h.success) throw zodFail(h.error);
      if (body.enabled && !publicProfiles())
        throw fail(403, 'policy_denied', 'public profile cards are turned off on this Hub', {
          reason: 'setting_off',
          setting: 'team.publicProfiles',
        });
      const taken = Object.entries(st.cards).some(
        ([acc, c]) => acc !== st.me && c.handle === body.handle,
      );
      if (taken) throw fail(409, 'conflict', 'this handle is taken', { field: 'handle' });
      st.cards[st.me] = {
        enabled: body.enabled,
        handle: body.handle,
        showAvatar: body.showAvatar !== false,
      };
      return cardView(st.me);
    },

    // ---- OIDC --------------------------------------------------------------------------------
    listOidcProviders: async () => {
      maybeFail('listOidcProviders');
      needOwner();
      return { items: st.providers.map(providerView) };
    },
    createOidcProvider: async (body) => {
      maybeFail('createOidcProvider');
      needOwner();
      const parsed = createOidcProviderSchema.safeParse(body);
      if (!parsed.success) throw zodFail(parsed.error);
      const issuer = parsed.data.issuer.replace(/\/+$/, '');
      if (st.providers.some((p) => p.issuer === issuer))
        throw fail(409, 'conflict', 'this issuer is already configured');
      const at = ts();
      const p = {
        ...oidcProvider({
          id: id('oidc'),
          label: parsed.data.label,
          issuer,
          clientId: parsed.data.clientId,
          hasClientSecret: !!parsed.data.clientSecret,
          scopes: parsed.data.scopes ?? ['openid', 'profile', 'email'],
          enabled: parsed.data.enabled !== false,
          createdAt: at,
          updatedAt: at,
        }),
        secret: parsed.data.clientSecret ?? null,
      };
      st.providers = [...st.providers, p];
      return providerView(p);
    },
    updateOidcProvider: async (pid, body) => {
      maybeFail('updateOidcProvider');
      needOwner();
      const p = st.providers.find((x) => x.id === pid);
      if (!p) throw notFound('OIDC provider');
      if (body.label !== undefined) p.label = body.label;
      if (body.clientId !== undefined) p.clientId = body.clientId;
      if (body.scopes !== undefined) p.scopes = [...body.scopes];
      if (body.enabled !== undefined) p.enabled = body.enabled;
      if (body.clientSecret === null) {
        p.secret = null;
        p.hasClientSecret = false;
      } else if (typeof body.clientSecret === 'string') {
        p.secret = body.clientSecret;
        p.hasClientSecret = true;
      }
      p.updatedAt = ts();
      return providerView(p);
    },
    deleteOidcProvider: async (pid) => {
      maybeFail('deleteOidcProvider');
      needOwner();
      if (!st.providers.some((p) => p.id === pid)) throw notFound('OIDC provider');
      st.providers = st.providers.filter((p) => p.id !== pid);
      return { ok: true };
    },
    listPublicOidcProviders: async () => {
      maybeFail('listPublicOidcProviders');
      return {
        items: st.providers.filter((p) => p.enabled).map((p) => ({ id: p.id, label: p.label })),
      };
    },
    unlinkOidcIdentity: async (iid) => {
      maybeFail('unlinkOidcIdentity');
      const list = st.identities[st.me] ?? [];
      if (!list.some((i) => i.id === iid)) throw notFound('identity');
      st.identities[st.me] = list.filter((i) => i.id !== iid);
      return { ok: true };
    },
    startOidc: async (body) => {
      maybeFail('startOidc');
      const p = st.providers.find((x) => x.id === body.providerId);
      if (!p?.enabled) throw notFound('OIDC provider');
      if (!st.reachable)
        throw fail(503, 'node_unavailable', 'the sign-in provider cannot be reached', {
          reason: 'discovery',
        });
      return { url: st.authorizeUrl, expiresAt: '2026-10-01T12:10:00.000Z' };
    },

    // ---- shared threads ----------------------------------------------------------------------
    listSharedThreads: async () => {
      maybeFail('listSharedThreads');
      return { items: Object.values(st.threads).filter(canSee).map(sharedView) };
    },
    getSharedThread: async (tid) => {
      maybeFail('getSharedThread');
      const r = record(tid);
      const authors: Record<
        string,
        { accountId: string; displayName: string | null; as: 'wrote' | 'asked' }
      > = {};
      const askedBy = new Map<string, string>();
      for (const m of r.messages)
        if (m.role === 'user' && m.turnId) askedBy.set(m.turnId, r.writers[m.id] ?? r.owner);
      for (const m of r.messages) {
        const acc =
          m.role === 'user'
            ? (r.writers[m.id] ?? r.owner)
            : ((m.turnId && askedBy.get(m.turnId)) ?? r.owner);
        authors[m.id] = {
          accountId: acc,
          displayName: personOf(acc).displayName,
          as: m.role === 'user' ? 'wrote' : 'asked',
        };
      }
      return { ...sharedView(r), messages: copy(r.messages), authors };
    },
    shareThread: async (tid, accountIds) => {
      maybeFail('shareThread');
      const existing = st.threads[tid];
      if (existing && existing.sharedAt !== null && existing.owner !== st.me)
        throw notFound('thread');
      const t = existing?.thread ?? helpers.threads().find((x) => x.id === tid);
      if (!t) throw notFound('thread');
      if (t.mode !== 'chat' || t.temporary || t.side || t.projectId)
        throw fail(400, 'validation', 'only a chat outside a project can be shared', {
          reason: 'not_shareable',
        });
      const ids = [...new Set(accountIds)].filter((x) => x !== st.me);
      if (!ids.length) throw fail(400, 'validation', 'name someone to share the thread with');
      const unknown = ids.filter((x) => !roleOf(x));
      if (unknown.length)
        throw fail(400, 'validation', 'these accounts are not people of this Hub', {
          reason: 'not_a_person',
          accountIds: unknown,
        });
      const r: SharedThreadRecord = existing ?? {
        thread: copy({ ...t, memoryOptOut: true }),
        owner: st.me,
        participants: [],
        sharedAt: null,
        messages: [],
        writers: {},
        running: false,
      };
      r.sharedAt ??= ts();
      r.participants = [...r.participants, ...ids.filter((x) => !r.participants.includes(x))];
      st.threads[tid] = r;
      return sharedView(r);
    },
    unshareThread: async (tid, accountId) => {
      maybeFail('unshareThread');
      const r = record(tid);
      if (st.me !== r.owner && st.me !== accountId)
        throw fail(403, 'policy_denied', "only the thread's owner can take others out of it", {
          reason: 'owner_only',
        });
      if (!r.participants.includes(accountId)) throw notFound('participant');
      r.participants = r.participants.filter((x) => x !== accountId);
      return { ok: true };
    },
    sendSharedMessage: async (tid, body) => {
      maybeFail('sendSharedMessage');
      const r = record(tid);
      const turnId = id('turn');
      const user = message(tid, {
        id: id('msg'),
        role: 'user',
        turnId,
        parts: [{ type: 'text', text: body.text }],
      });
      const reply = message(tid, {
        id: id('msg'),
        role: 'assistant',
        turnId,
        status: 'streaming',
        parts: [],
      });
      r.messages = [...r.messages, user, reply];
      r.writers[user.id] = st.me;
      r.running = true;
      return {
        disposition: 'started',
        turnId,
        userMessageId: user.id,
        assistantMessageId: reply.id,
      };
    },
    cancelSharedThread: async (tid) => {
      maybeFail('cancelSharedThread');
      const r = record(tid);
      const was = r.running;
      r.running = false;
      return { ok: true, cancelled: was };
    },
    sharedThreadStreamUrl: (tid) => `/api/v1/team/threads/${encodeURIComponent(tid)}/stream`,

    // ---- team agents -------------------------------------------------------------------------
    listTeamAgents: async () => {
      maybeFail('listTeamAgents');
      return { items: st.agents.map(agentView) };
    },
    provisionTeamAgent: async (body) => {
      maybeFail('provisionTeamAgent');
      needOwner();
      const a = teamAgent({
        agentId: id('ta'),
        name: body.name,
        autonomy: body.autonomy ?? 'standard',
        createdAt: ts(),
      });
      st.agents = [...st.agents, a];
      return agentView(a);
    },
    getTeamAgent: async (aid) => {
      maybeFail('getTeamAgent');
      return agentView(agent(aid));
    },
    removeTeamAgent: async (aid) => {
      maybeFail('removeTeamAgent');
      needOwner();
      agent(aid);
      st.agents = st.agents.filter((a) => a.agentId !== aid);
      return { ok: true };
    },
    addTeamAgentCredential: async (aid, body) => {
      maybeFail('addTeamAgentCredential');
      needOwner();
      const a = agent(aid);
      const cid = id('cred');
      const c: TeamAgentCredentialView = {
        id: cid,
        kind: body.kind,
        label: body.label,
        refId: id('ref'),
        secretRef:
          body.kind === 'provider'
            ? body.apiKey
              ? `secret://providers/${cid}`
              : null
            : `secret://egress/${cid}`,
        createdAt: ts(),
      };
      a.credentials = [...a.credentials, c];
      return copy(c);
    },
    removeTeamAgentCredential: async (aid, cid) => {
      maybeFail('removeTeamAgentCredential');
      needOwner();
      const a = agent(aid);
      if (!a.credentials.some((c) => c.id === cid)) throw notFound('credential');
      a.credentials = a.credentials.filter((c) => c.id !== cid);
      return { ok: true };
    },
    giveTeamTask: async (aid, text) => {
      maybeFail('giveTeamTask');
      if (!roleOf(st.me)) throw notFound('person');
      agent(aid);
      const t = teamTask({
        id: id('task'),
        agentId: aid,
        requestedBy: st.me,
        text,
        status: 'running',
        result: null,
        createdAt: ts(),
        startedAt: ts(),
        endedAt: null,
      });
      st.tasks = [t, ...st.tasks];
      return copy(t);
    },
    listTeamTasks: async (aid) => {
      maybeFail('listTeamTasks');
      return {
        items: st.tasks
          .filter((t) => (owner() || t.requestedBy === st.me) && (!aid || t.agentId === aid))
          .map((t) => copy(t)),
      };
    },
    getTeamTask: async (tid) => {
      maybeFail('getTeamTask');
      const t = st.tasks.find((x) => x.id === tid);
      if (!t || (t.requestedBy !== st.me && !owner())) throw notFound('task');
      return copy(t);
    },
    cancelTeamTask: async (tid) => {
      maybeFail('cancelTeamTask');
      const t = st.tasks.find((x) => x.id === tid);
      if (!t || (t.requestedBy !== st.me && !owner())) throw notFound('task');
      if (t.status === 'queued' || t.status === 'running') {
        t.status = 'cancelled';
        t.endedAt = ts();
      }
      return copy(t);
    },
    teamAgentAudit: async (aid, q = {}) => {
      maybeFail('teamAgentAudit');
      needOwner();
      agent(aid);
      const all = st.audit[aid] ?? [];
      const start = q.cursor ? Number(q.cursor) : 0;
      const limit = q.limit ?? 50;
      const items = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return { items: copy(items), nextCursor: next };
    },
    teamAgentApprovals: async (aid) => {
      maybeFail('teamAgentApprovals');
      needOwner();
      agent(aid);
      return { items: copy((st.approvals[aid] ?? []).filter((a) => a.status === 'pending')) };
    },
    decideTeamAgentApproval: async (aid, apId, body) => {
      maybeFail('decideTeamAgentApproval');
      needOwner();
      agent(aid);
      const a = (st.approvals[aid] ?? []).find((x) => x.id === apId);
      if (!a) throw notFound('approval');
      if (a.status !== 'pending')
        throw fail(409, 'conflict', 'this approval was already answered', { reason: 'decided' });
      a.status = 'decided';
      a.decision = body.decision;
      a.decidedBy = st.me;
      a.decidedAt = ts();
      return copy(a);
    },

    // ---- plugins per agent ----------------------------------------------------------------------
    getAgentPlugins: async (aid) => {
      maybeFail('getAgentPlugins');
      return { agentId: aid, pluginIds: copy(st.agentPlugins[aid] ?? null) };
    },
    setAgentPlugins: async (aid, pluginIds) => {
      maybeFail('setAgentPlugins');
      const installed = new Set(helpers.plugins?.() ?? []);
      const missing = (pluginIds ?? []).filter((p) => !installed.has(p));
      if (missing.length)
        throw fail(400, 'validation', `plugins that are not installed: ${missing.join(', ')}`, {
          reason: 'unknown_plugin',
          plugins: missing,
        });
      st.agentPlugins[aid] = pluginIds === null ? null : [...new Set(pluginIds)];
      return { agentId: aid, pluginIds: copy(st.agentPlugins[aid] ?? null) };
    },
  };
}

// ---- the client tests use -----------------------------------------------------------------------

export type TeamMocks = TeamApi & Record<keyof TeamApi, Mock>;

export function createTeamHub(
  init: Partial<M7TeamState> = {},
  extra: {
    threads?: () => ThreadView[];
    setting?: <K extends SettingKey>(key: K) => SettingValue<K>;
    plugins?: () => string[];
  } = {},
) {
  const state = m7TeamState(init);
  const failNext: Partial<Record<keyof TeamApi, Error>> = {};
  const impl = m7TeamImpl(state, {
    id: nid,
    ts: nextTs,
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
    threads: extra.threads ?? (() => []),
    ...(extra.setting ? { setting: extra.setting } : {}),
    ...(extra.plugins ? { plugins: extra.plugins } : {}),
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as TeamMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the team views need, with the main fake Hub's client and the
 * team part spread over it (what `createApi` will do). `as: 'member'` signs in as Alex and gives
 * the settings store a member's client (what App.tsx does once wired).
 */
export async function renderWithTeam(
  ui: ReactNode,
  opts: {
    team?: Partial<M7TeamState>;
    as?: 'owner' | 'member';
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    hub?: ReturnType<typeof createHub>;
    /** Wrap in TeamRoleProvider (the views also work without it). */
    provider?: boolean;
    /** Runs before the first render (to make the first load fail, say). */
    prepare?: (team: ReturnType<typeof createTeamHub>) => void;
  } = {},
) {
  const hub = opts.hub ?? createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const team = createTeamHub(
    { ...(opts.as === 'member' ? { me: MEMBER_ID } : {}), ...opts.team },
    {
      threads: () => hub.state.threads,
      setting: (k) =>
        resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value,
      plugins: () => hub.state.m4.plugins.map((p) => p.id),
    },
  );
  const api = { ...hub.api, ...team.api };
  const member = team.state.me !== OWNER_ID && opts.as !== 'owner';
  const store = member ? memberSettingsApi(team.api) : api;
  const { settings } = await store.settings();
  opts.prepare?.(team);
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const withRole = opts.provider ? createElement(TeamRoleProvider, { children: inner }) : inner;
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, {
        api: store,
        initial: settings,
        children: withRole,
      }),
    }),
  );
  return { hub, team, api: team.api, state: team.state, ...utils };
}
