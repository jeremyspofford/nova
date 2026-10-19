// Team area (FR-217, FR-091, FR-113, FR-045 per agent; decision 5 of ADR-095, docs/13 §7).
// Several people use one Hub: the owner invites members with a one-use link, each member has
// their own account and sessions, the owner can remove a member (their sessions end at once).
// Members are refused the routes that administer the Hub or reach its machine (`preHandler`
// guard, 403 `policy_denied` reason `owner_only`). Threads can be shared; specialist/team agents
// work under their own identity; an OIDC provider and opt-in public profile cards are optional.
//
// Public routes and how each authenticates:
// - `POST /api/v1/team/join/preview`, `POST /api/v1/team/join`: the one-use invitation token in
//   the body (256 random bits, only its hash stored, expires); rate-limited per address.
// - `GET /api/v1/auth/oidc/providers`: none (enabled providers' ids and labels only).
// - `POST /api/v1/auth/oidc/start`: none for `sign_in`; `join` needs a usable invitation; `link`
//   needs a session. Rate-limited per address. It only returns the provider's URL.
// - `GET /api/v1/auth/oidc/callback`: the single-use state from start (10 minutes), then the ID
//   token's signature, issuer, audience, expiry and nonce; it only ever redirects to fixed paths.
// - `GET /api/v1/profiles/:handle`, `.../avatar`: none; only cards their person published while
//   `team.publicProfiles` is on; rate-limited per address.
//
// M8 (ADR-097): a removed member's data is purged after `team.removedMemberPurgeDays` (an hourly
// sweep) or at once on the owner's request, after the owner could export it; `/team/me/access`
// tells the web UI what a member may reach (the route classification, D7).
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  agentPluginsSchema,
  createInvitationSchema,
  createOidcProviderSchema,
  createTeamAgentSchema,
  decideApprovalSchema,
  idSchema,
  joinPreviewSchema,
  joinTeamSchema,
  oidcStartSchema,
  patchMemberSettingSchema,
  purgeMemberSchema,
  profileCardSchema,
  profileHandleSchema,
  sendMessageSchema,
  shareThreadSchema,
  teamAgentCredentialSchema,
  teamTaskSchema,
  updateOidcProviderSchema,
  type AgentPluginsView,
  type JoinPreviewView,
  type PublicProfileView,
  type TeamAccessView,
  type TeamMeView,
  type TeamRole,
} from '@nova/shared';
import {
  AuditLog,
  EgressStore,
  MemberPurgeService,
  OIDC_CALLBACK_PATH,
  OWNER_ONLY_ROUTES,
  OidcService,
  ProfileCardService,
  ProfileService,
  SharedThreadService,
  SlidingWindowLimiter,
  TeamAgentService,
  TeamService,
  memberBodyReason,
  memberScoped,
  recordHubOwner,
  memberWorkspace,
  ownerOnlyError,
  ownerOnlyReason,
  type AgentService,
  type ApprovalRequests,
  type AuditSink,
  type ChatAccess,
  type ChatService,
  type FetchLike,
  type ThreadPolicySource,
  type ToolLimitSource,
} from '@nova/core';
import type { AuthService } from './auth.ts';
import { openStream } from './chat-routes.ts';
import type { HubArea, HubContext } from './hub-context.ts';

export interface TeamDeps {
  auth: Pick<AuthService, 'issueSession' | 'revokeAccountSessions'>;
  audit?: AuditSink;
  /** The Hub's session cookie name (`SESSION_COOKIE` in app.ts). */
  sessionCookie?: string;
  /** Approvals of team agents' identities, answered by the owner (the policy area). */
  approvals?: ApprovalRequests;
  /** Tests: the OIDC provider's fetch, a clock and lower public limits. */
  fetch?: FetchLike;
  now?: () => Date;
  limits?: {
    join?: { limit: number; windowMs: number };
    oidc?: { limit: number; windowMs: number };
    profiles?: { limit: number; windowMs: number };
  };
  /** How often removed members past their grace period are purged (default hourly; 0: never). */
  purgeSweepMs?: number;
}

/**
 * An export of one account's data for the owner to keep before a purge (V's data export, D5):
 * the file's name and its bytes, streamed.
 */
export type MemberExporter = (
  accountId: string,
) => Promise<{ fileName: string; contentType?: string; body: AsyncIterable<Buffer> | Readable }>;

export interface TeamArea extends HubArea {
  team: TeamService;
  oidc: OidcService;
  cards: ProfileCardService;
  shared: SharedThreadService;
  /** Null until `useAgents`. */
  agents(): TeamAgentService | null;
  /** For `chat.useAccess`: shared threads and the owner's user instructions (FR-217). */
  access: ChatAccess;
  /** For `gate.useToolLimits`: no private connectors in a shared thread. */
  toolLimits: ToolLimitSource;
  /**
   * A member's threads work in their own folder: wrap each thread policy source (and register
   * `scoped()` last as the fallback) for both the gate and the tools.
   */
  scoped(source?: ThreadPolicySource): ThreadPolicySource;
  roleOf(accountId: string): TeamRole | null;
  /**
   * Called after a member was removed (their sessions are revoked and their work disabled in the
   * database): app.ts closes the account's open `/api/v1/ws` and event streams, and the MCP area
   * disconnects its servers. Shared-thread streams of this area end on their own.
   */
  onMemberRemoved(fn: (accountId: string) => Promise<void> | void): void;
  /** The agents area's service: team agents and plugins per agent. */
  useAgents(agents: AgentService): void;
  /** A removed member's data: the list, the grace-period sweep and the purge (M8). */
  purges: MemberPurgeService;
  /** The data controls' export of one account, offered before a purge (M8). */
  useExporter(exporter: MemberExporter): void;
  /** The chat loop: sends in shared threads and team tasks. */
  useChat(chat: Pick<ChatService, 'send' | 'cancel' | 'turnStarter'>): void;
  useApprovals(approvals: ApprovalRequests): void;
}

const params = z.object({ id: idSchema });
const memberParams = z.object({ id: idSchema, accountId: idSchema });
const credentialParams = z.object({ id: idSchema, credentialId: idSchema });
const approvalParams = z.object({ id: idSchema, approvalId: idSchema });
const handleParams = z.object({ handle: profileHandleSchema });
const callbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
});
const tasksQuery = z.object({ agentId: idSchema.optional() });
/** The cookie that binds an OIDC sign-in to the browser that started it (path: the callback). */
export const OIDC_BINDING_COOKIE = 'nova_oidc_binding';
const auditQuery = z.object({
  kind: z.string().max(40).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function baseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}

/** A reason safe to put in a redirect's query (letters and underscores). */
function safeReason(err: unknown): string {
  const r =
    err instanceof NovaError && typeof err.details?.reason === 'string'
      ? err.details.reason
      : 'refused';
  return r.replace(/[^a-z_]/g, '').slice(0, 40) || 'refused';
}

export function setupTeam(ctx: HubContext, deps: TeamDeps): Promise<TeamArea> {
  const log = ctx.log.child('team');
  const now = deps.now ?? (() => new Date());
  const cookieName = deps.sessionCookie ?? 'nova_session';
  const team = new TeamService({
    db: ctx.db,
    events: ctx.events,
    log,
    now,
    sessions: {
      issue: (accountId) => deps.auth.issueSession(accountId),
      revokeAll: (accountId) => deps.auth.revokeAccountSessions(accountId),
    },
    invitationHours: () => ctx.setting('team.invitationHours'),
    ...(deps.audit ? { audit: deps.audit } : {}),
  });
  const oidc = new OidcService({
    db: ctx.db,
    secrets: ctx.secrets,
    events: ctx.events,
    team,
    log: log.child('oidc'),
    now,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.audit ? { audit: deps.audit } : {}),
  });
  const cards = new ProfileCardService({
    db: ctx.db,
    now,
    allowed: () => ctx.setting('team.publicProfiles'),
  });
  const profile = new ProfileService({ db: ctx.db, dataDir: ctx.dataDir });
  const shared = new SharedThreadService({
    db: ctx.db,
    events: ctx.events,
    threads: ctx.threads,
    team,
    log: log.child('shared'),
    now,
    ...(deps.audit ? { audit: deps.audit } : {}),
  });
  const offShared = shared.start(ctx.events.bus);
  const egress = new EgressStore({ db: ctx.db, secrets: ctx.secrets, now });
  // Read-only here: the team agents' audit trails (the ops area appends).
  const auditLog = new AuditLog({ db: ctx.db });
  let approvals = deps.approvals ?? null;
  let agentService: AgentService | null = null;
  let teamAgents: TeamAgentService | null = null;
  let chat: Pick<ChatService, 'send' | 'cancel' | 'turnStarter'> | null = null;
  let exporter: MemberExporter | null = null;
  const purges = new MemberPurgeService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    team,
    events: ctx.events,
    secrets: ctx.secrets,
    log: log.child('purge'),
    now,
    graceDays: () => ctx.setting('team.removedMemberPurgeDays'),
    ...(deps.audit ? { audit: deps.audit } : {}),
  });
  // Removed members past the grace period are purged in the background (failures are recorded and
  // tried again a day later).
  const sweepMs = deps.purgeSweepMs ?? 3_600_000;
  const sweep = () =>
    purges.sweep().catch((err: unknown) => log.warn('the removed-member sweep failed', { err }));
  const sweeper = sweepMs > 0 ? setInterval(() => void sweep(), sweepMs) : null;
  sweeper?.unref();

  const limiter = (l: { limit: number; windowMs: number } | undefined, d: number) =>
    new SlidingWindowLimiter({
      limit: l?.limit ?? d,
      windowMs: l?.windowMs ?? 60_000,
      now: () => now().getTime(),
    });
  const joinLimiter = limiter(deps.limits?.join, 10);
  const oidcLimiter = limiter(deps.limits?.oidc, 30);
  const profileLimiter = limiter(deps.limits?.profiles, 60);
  const limited = (l: SlidingWindowLimiter, req: FastifyRequest) => {
    if (!l.take(req.ip))
      throw new NovaError('rate_limited', 'too many requests from this address', {
        details: { reason: 'address_rate_limited' },
        action: 'Wait a minute and try again',
      });
  };

  // Members' own folders (decision 5); made on first use, private to the Hub's user.
  const memberRoot = (accountId: string) => {
    const dir = memberWorkspace(ctx.dataDir, accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  // Before migration 0037 nobody can be a member: the guard has nothing to check.
  const ready =
    ctx.db.raw
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'team_member'")
      .get() !== undefined;
  if (!ready) log.warn('the team tables are missing (migration 0037): members are off');
  // A Hub from before M7 gets its owner recorded now; every later check reads that row.
  const owner = ready ? team.ownerId() : null;
  if (owner) recordHubOwner(ctx.db, owner, now().toISOString());
  // Every account that is not the recorded owner (a member, a removed member, a team agent's
  // identity) is refused Hub administration and works only in its own folder (decision 5).
  const notOwner = (accountId: string) => ready && !team.isOwner(accountId);

  const streams = new Set<() => void>();
  // Each person's open shared-thread streams, so a removed member's end at once.
  const byAccount = new Map<string, Set<() => void>>();
  const trackFor = (accountId: string) => (end: () => void) => {
    streams.add(end);
    const mine = byAccount.get(accountId) ?? new Set<() => void>();
    mine.add(end);
    byAccount.set(accountId, mine);
    return () => {
      streams.delete(end);
      mine.delete(end);
      if (!mine.size) byAccount.delete(accountId);
    };
  };
  team.onRemoved((accountId) => {
    for (const end of [...(byAccount.get(accountId) ?? [])]) end();
  });
  // A team agent's events (the approvals it waits for, its turns and replies) also reach the
  // owner, who administers it: the same event, for the owner's account, naming the agent. A
  // persisted event is persisted again; a live one (deltas) stays live.
  const agentOf = new Map<string, string | null>();
  const offMirror = ctx.events.bus.subscribe('*', (e) => {
    if (!e.accountId || !teamAgents) return;
    let agentId = agentOf.get(e.accountId);
    if (agentId === undefined) {
      agentId = teamAgents.agentOfIdentity(e.accountId);
      if (agentOf.size > 10_000) agentOf.clear();
      agentOf.set(e.accountId, agentId);
    }
    const owner = agentId ? team.ownerId() : null;
    if (!agentId || !owner || owner === e.accountId) return;
    const copy = {
      name: e.name,
      actor: e.actor,
      accountId: owner,
      ...(e.correlation ? { correlation: e.correlation } : {}),
      payload: { ...e.payload, teamAgent: { agentId, identityAccountId: e.accountId } },
    };
    const persisted =
      ctx.db.raw.prepare('SELECT 1 AS x FROM event WHERE id = ?').get(e.id) !== undefined;
    if (persisted)
      void ctx.events.emit(copy).catch((err: unknown) => {
        log.warn('team agent event not mirrored to the owner', { err, name: e.name });
      });
    else ctx.events.emitEphemeral(copy);
  });

  const needAgents = (): TeamAgentService => {
    if (!teamAgents) throw new NovaError('capability_missing', 'team agents are not available');
    return teamAgents;
  };
  const needChat = () => {
    if (!chat) throw new NovaError('capability_missing', 'the chat loop is not available');
    return chat;
  };
  const needAgentService = () => {
    if (!agentService) throw new NovaError('capability_missing', 'agents are not available');
    return agentService;
  };

  function setSession(
    req: FastifyRequest,
    reply: FastifyReply,
    s: { token: string; maxAgeS: number },
  ) {
    void reply.setCookie(cookieName, s.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: s.maxAgeS,
    });
  }

  async function signedIn(accountId: string, via: string): Promise<void> {
    // Local-first: a new person can chat offline at once with the mock provider.
    await ctx.registry.ensureDefaultProvider(accountId);
    await ctx.events.emit({
      name: 'auth.session.created',
      actor: 'user',
      accountId,
      payload: { accountId, via },
    });
  }

  function register(app: FastifyInstance): void {
    // ---- the member guard (decision 5): runs after authentication, on every route ------------
    app.addHook('preHandler', (req, _reply, done) => {
      const accountId = req.principal?.accountId;
      if (!accountId || !notOwner(accountId)) {
        done();
        return;
      }
      const route = req.routeOptions.url;
      const why =
        ownerOnlyReason(req.method, route) ?? memberBodyReason(req.method, route, req.body);
      done(why ? ownerOnlyError(why) : undefined);
    });
    // Open shared-thread streams end before the server closes.
    app.addHook('preClose', (done) => {
      for (const end of [...streams]) end();
      done();
    });

    // ---- people ----------------------------------------------------------------------------
    app.get('/api/v1/team/me', async (req) => {
      const accountId = await ctx.accountOf(req);
      const person = team.person(accountId);
      if (!person) throw new NovaError('not_found', 'no such person on this Hub');
      const out: TeamMeView = { ...person, identities: oidc.identities(accountId) };
      return out;
    });

    app.get('/api/v1/team/members', async (req) => ({
      items: team.members(await ctx.accountOf(req)),
    }));

    app.delete('/api/v1/team/members/:id', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return team.removeMember(actor, id);
    });

    // ---- invitations (owner) and joining (public) -------------------------------------------
    app.get('/api/v1/team/invitations', async (req) => ({
      items: team.invitations(await ctx.accountOf(req)),
    }));

    app.post('/api/v1/team/invitations', async (req, reply) => {
      const actor = await ctx.accountOf(req);
      const body = createInvitationSchema.parse(req.body ?? {});
      const out = await team.createInvitation(actor, body, baseUrl(req));
      void reply.header('cache-control', 'no-store').status(201);
      return out;
    });

    app.delete('/api/v1/team/invitations/:id', async (req) => {
      const actor = await ctx.accountOf(req);
      return team.revokeInvitation(actor, params.parse(req.params).id);
    });

    app.post('/api/v1/team/join/preview', async (req, reply) => {
      limited(joinLimiter, req);
      const body = joinPreviewSchema.parse(req.body ?? {});
      const out: JoinPreviewView = { ...team.preview(body.token), providers: [] };
      if (out.valid) out.providers = oidc.publicProviders();
      void reply.header('cache-control', 'no-store');
      return out;
    });

    app.post('/api/v1/team/join', async (req, reply) => {
      limited(joinLimiter, req);
      const body = joinTeamSchema.parse(req.body ?? {});
      const out = await team.redeem(body.token, body.displayName, { via: 'local' });
      await signedIn(out.accountId, 'invitation');
      setSession(req, reply, out.session);
      void reply.header('cache-control', 'no-store').status(201);
      return { accountId: out.accountId, role: 'member' as const };
    });

    // ---- a removed member's data (M8): kept, exported, purged --------------------------------
    app.get('/api/v1/team/removed', async (req) => ({
      items: (await purges.removed(await ctx.accountOf(req))).map((v) => ({
        ...v,
        exportable: v.exportable && exporter !== null,
      })),
    }));

    app.post('/api/v1/team/removed/:id/purge', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      purgeMemberSchema.parse(req.body ?? {});
      const out = await purges.purge(actor, id);
      return { ...out, exportable: false };
    });

    app.get('/api/v1/team/removed/:id/export', async (req, reply) => {
      const actor = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const view = await purges.get(actor, id);
      if (!view.exportable)
        throw new NovaError('conflict', "this member's data was already purged", {
          details: { reason: 'already_purged' },
        });
      if (!exporter)
        throw new NovaError('capability_missing', 'exporting data is not available on this Hub', {
          details: { reason: 'export_unavailable' },
        });
      const out = await exporter(id);
      await deps.audit
        ?.append({
          accountId: actor,
          actor: 'user',
          kind: 'auth',
          action: 'team.member.export',
          resource: `account:${id}`,
          detail: { fileName: out.fileName },
        })
        .catch(() => undefined);
      const safe = out.fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'export';
      void reply
        .header('content-type', out.contentType ?? 'application/zip')
        .header('content-disposition', `attachment; filename="${safe}"`)
        .header('cache-control', 'no-store');
      return reply.send(out.body instanceof Readable ? out.body : Readable.from(out.body));
    });

    // What this person may reach, for the web UI's member mode (D7).
    app.get('/api/v1/team/me/access', async (req) => {
      const accountId = await ctx.accountOf(req);
      const role = team.assertPerson(accountId);
      const owner = role === 'owner';
      const out: TeamAccessView = {
        role,
        refused: owner
          ? []
          : OWNER_ONLY_ROUTES.map((r) => ({
              method: r.methods === '*' ? '*' : r.methods.join(','),
              route: r.pattern,
              why: r.why,
            })),
        limits: {
          stdioMcpServers: owner,
          privateAddresses: owner,
          narrowingOnlyAllowLists: !owner,
          hubSettings: owner,
        },
      };
      return out;
    });

    // ---- a member's own preferences ---------------------------------------------------------
    app.get('/api/v1/team/me/settings', async (req) => ({
      settings: team.memberSettings(await ctx.accountOf(req)),
    }));

    app.patch('/api/v1/team/me/settings', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = patchMemberSettingSchema.parse(req.body ?? {});
      await team.setMemberSetting(accountId, body.key, body.value);
      return { settings: team.memberSettings(accountId) };
    });

    // ---- public profile card (FR-113) --------------------------------------------------------
    app.get('/api/v1/team/me/card', async (req) => cards.get(await ctx.accountOf(req)));

    app.put('/api/v1/team/me/card', async (req) => {
      const accountId = await ctx.accountOf(req);
      const out = await cards.set(accountId, profileCardSchema.parse(req.body ?? {}));
      await deps.audit
        ?.append({
          accountId,
          actor: 'user',
          kind: 'auth',
          action: 'profile.card',
          resource: `account:${accountId}`,
          detail: { enabled: out.enabled, handle: out.handle },
        })
        .catch(() => undefined);
      return out;
    });

    app.get('/api/v1/profiles/:handle', async (req, reply) => {
      limited(profileLimiter, req);
      const { handle } = handleParams.parse(req.params);
      const card = await cards.publicCard(handle);
      if (!card) throw new NovaError('not_found', 'profile not found');
      const out: PublicProfileView = {
        handle: card.handle,
        displayName: card.displayName,
        avatarPath:
          card.showAvatar && card.hasAvatar ? `/api/v1/profiles/${card.handle}/avatar` : null,
      };
      void reply.header('cache-control', 'public, max-age=60');
      return out;
    });

    app.get('/api/v1/profiles/:handle/avatar', async (req, reply) => {
      limited(profileLimiter, req);
      const { handle } = handleParams.parse(req.params);
      const card = await cards.publicCard(handle);
      const image = card?.showAvatar ? await profile.avatar(card.accountId) : null;
      if (!image) throw new NovaError('not_found', 'no avatar');
      void reply
        .header('Content-Type', image.mime)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'public, max-age=300');
      return reply.send(image.bytes);
    });

    // ---- OIDC (FR-113, docs/13 §7) ------------------------------------------------------------
    app.get('/api/v1/team/oidc', async (req) => ({
      items: oidc.providers(await ctx.accountOf(req)),
    }));

    app.post('/api/v1/team/oidc', async (req, reply) => {
      const actor = await ctx.accountOf(req);
      const out = await oidc.createProvider(actor, createOidcProviderSchema.parse(req.body ?? {}));
      void reply.status(201);
      return out;
    });

    app.patch('/api/v1/team/oidc/:id', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return oidc.updateProvider(actor, id, updateOidcProviderSchema.parse(req.body ?? {}));
    });

    // Discovery and the key set from the Hub, as a sign-in would reach them (also when it is off).
    app.post('/api/v1/team/oidc/:id/test', async (req) => {
      const actor = await ctx.accountOf(req);
      return oidc.testProvider(actor, params.parse(req.params).id);
    });

    app.delete('/api/v1/team/oidc/:id', async (req) => {
      const actor = await ctx.accountOf(req);
      await oidc.deleteProvider(actor, params.parse(req.params).id);
      return { ok: true };
    });

    app.delete('/api/v1/team/me/identities/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      await oidc.unlink(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    app.get('/api/v1/auth/oidc/providers', () => ({ items: oidc.publicProviders() }));

    app.post('/api/v1/auth/oidc/start', async (req, reply) => {
      limited(oidcLimiter, req);
      const body = oidcStartSchema.parse(req.body ?? {});
      // Linking needs the person's own session; signing in and joining have none yet.
      const accountId = body.flow === 'link' ? await ctx.accountOf(req) : null;
      // The browser that starts is the only one that may finish: a random value in a cookie only
      // the callback sees, its hash kept with the pending sign-in.
      const binding = randomBytes(32).toString('base64url');
      const out = await oidc.start({
        providerId: body.providerId,
        flow: body.flow,
        baseUrl: baseUrl(req),
        accountId,
        invitation: body.invitation ?? null,
        displayName: body.displayName ?? null,
        browserBinding: binding,
        address: req.ip,
      });
      void reply.header('cache-control', 'no-store').setCookie(OIDC_BINDING_COOKIE, binding, {
        httpOnly: true,
        // Lax: the provider's redirect back is a top-level GET from another site.
        sameSite: 'lax',
        secure: req.protocol === 'https',
        path: OIDC_CALLBACK_PATH,
        maxAge: 600,
      });
      return out;
    });

    app.get('/api/v1/auth/oidc/callback', async (req, reply) => {
      limited(oidcLimiter, req);
      const q = callbackQuery.parse(req.query);
      void reply.header('cache-control', 'no-store');
      const binding = req.cookies[OIDC_BINDING_COOKIE];
      if (binding) void reply.clearCookie(OIDC_BINDING_COOKIE, { path: OIDC_CALLBACK_PATH });
      try {
        const out = await oidc.callback(q, binding);
        if (out.kind === 'linked')
          return await reply.redirect('/settings/account?oidc=linked', 302);
        await signedIn(out.accountId, out.kind === 'joined' ? 'oidc_join' : 'oidc');
        setSession(req, reply, out.session);
        return await reply.redirect('/', 302);
      } catch (err) {
        log.info('OIDC sign-in refused', { reason: safeReason(err) });
        // A failed link returns to the account settings; a sign-in or join (and a refusal that
        // cannot tell, an unknown state) to the sign-in page.
        const link = err instanceof NovaError && err.details?.flow === 'link';
        const page = link ? '/settings/account' : '/sign-in';
        return reply.redirect(`${page}?oidc_error=${safeReason(err)}`, 302);
      }
    });

    // ---- shared threads (FR-217) ---------------------------------------------------------------
    app.get('/api/v1/team/threads', async (req) => ({
      items: await shared.list(await ctx.accountOf(req)),
    }));

    app.get('/api/v1/team/threads/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return shared.detail(accountId, params.parse(req.params).id);
    });

    app.post('/api/v1/team/threads/:id/share', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return shared.share(actor, id, shareThreadSchema.parse(req.body ?? {}).accountIds);
    });

    app.delete('/api/v1/team/threads/:id/share/:accountId', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id, accountId } = memberParams.parse(req.params);
      await shared.unshare(actor, id, accountId);
      return { ok: true };
    });

    // The turn runs under the account that wrote (its providers, policy and approvals).
    app.post(
      '/api/v1/team/threads/:id/messages',
      { bodyLimit: 30 * 1024 * 1024 },
      async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        if (!shared.canSee(accountId, id)) throw new NovaError('not_found', 'thread not found');
        const res = await needChat().send(accountId, id, sendMessageSchema.parse(req.body));
        void reply.status(202);
        return res;
      },
    );

    app.post('/api/v1/team/threads/:id/cancel', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      if (!shared.canSee(accountId, id)) throw new NovaError('not_found', 'thread not found');
      return { ok: true, cancelled: await needChat().cancel(accountId, id) };
    });

    app.get('/api/v1/team/threads/:id/stream', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      if (!shared.canSee(accountId, id)) throw new NovaError('not_found', 'thread not found');
      const header = req.headers['last-event-id'];
      const query = z.object({ after: z.string().max(100).optional() }).parse(req.query);
      const after =
        (typeof header === 'string' && header ? header : undefined) ?? query.after ?? null;
      return openStream(
        req,
        reply,
        { events: ctx.events, trackStream: trackFor(accountId) },
        // Access is checked on every event: someone taken out of the thread stops hearing it.
        (e) => shared.visible(accountId, id, e) && shared.canSee(accountId, id),
        async (send) => {
          if (!after) return;
          let cursor: string = after;
          for (;;) {
            const page = await ctx.events.since(cursor, 500, { threadId: id });
            for (const e of page) if (shared.visible(accountId, id, e)) send(e);
            if (page.length < 500) break;
            cursor = page.at(-1)!.id;
          }
        },
      );
    });

    // ---- team agents (FR-091) -----------------------------------------------------------------
    app.get('/api/v1/team/agents', async (req) => ({
      items: await needAgents().list(await ctx.accountOf(req)),
    }));

    app.post('/api/v1/team/agents', async (req, reply) => {
      const actor = await ctx.accountOf(req);
      const out = await needAgents().provision(actor, createTeamAgentSchema.parse(req.body ?? {}));
      agentOf.delete(out.identityAccountId);
      void reply.status(201);
      return out;
    });

    app.get('/api/v1/team/agents/:id', async (req) => {
      const viewer = await ctx.accountOf(req);
      return needAgents().get(viewer, params.parse(req.params).id);
    });

    app.delete('/api/v1/team/agents/:id', async (req) => {
      const actor = await ctx.accountOf(req);
      await needAgents().remove(actor, params.parse(req.params).id);
      return { ok: true };
    });

    app.post('/api/v1/team/agents/:id/credentials', async (req, reply) => {
      const actor = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const out = await needAgents().addCredential(
        actor,
        id,
        teamAgentCredentialSchema.parse(req.body ?? {}),
      );
      void reply.status(201);
      return out;
    });

    app.delete('/api/v1/team/agents/:id/credentials/:credentialId', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id, credentialId } = credentialParams.parse(req.params);
      await needAgents().removeCredential(actor, id, credentialId);
      return { ok: true };
    });

    app.get('/api/v1/team/agents/:id/tasks', async (req) => {
      const viewer = await ctx.accountOf(req);
      return { items: needAgents().tasks(viewer, params.parse(req.params).id) };
    });

    app.post('/api/v1/team/agents/:id/tasks', async (req, reply) => {
      const requester = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const out = await needAgents().createTask(
        requester,
        id,
        teamTaskSchema.parse(req.body ?? {}).text,
      );
      void reply.status(202);
      return out;
    });

    app.get('/api/v1/team/tasks', async (req) => {
      const viewer = await ctx.accountOf(req);
      const q = tasksQuery.parse(req.query);
      return { items: needAgents().tasks(viewer, q.agentId) };
    });

    app.get('/api/v1/team/tasks/:id', async (req) => {
      const viewer = await ctx.accountOf(req);
      return needAgents().task(viewer, params.parse(req.params).id);
    });

    app.post('/api/v1/team/tasks/:id/cancel', async (req) => {
      const viewer = await ctx.accountOf(req);
      return needAgents().cancelTask(viewer, params.parse(req.params).id);
    });

    app.get('/api/v1/team/agents/:id/audit', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const q = auditQuery.parse(req.query);
      return needAgents().audit(actor, id, {
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      });
    });

    app.get('/api/v1/team/agents/:id/approvals', async (req) => {
      const actor = await ctx.accountOf(req);
      return { items: await needAgents().approvals(actor, params.parse(req.params).id) };
    });

    app.post('/api/v1/team/agents/:id/approvals/:approvalId', async (req) => {
      const actor = await ctx.accountOf(req);
      const { id, approvalId } = approvalParams.parse(req.params);
      const body = decideApprovalSchema.parse({
        ...((req.body ?? {}) as Record<string, unknown>),
        approvalId,
      });
      return needAgents().decide(actor, id, body);
    });

    // ---- plugins per agent (FR-045, docs/04 §2.5) -------------------------------------------
    app.get('/api/v1/agents/:id/plugins', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const out: AgentPluginsView = {
        agentId: id,
        pluginIds: await needAgentService().plugins(accountId, id),
      };
      return out;
    });

    app.put('/api/v1/agents/:id/plugins', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const body = agentPluginsSchema.parse(req.body ?? {});
      const out: AgentPluginsView = {
        agentId: id,
        pluginIds: await needAgentService().setPlugins(accountId, id, body.pluginIds),
      };
      return out;
    });
  }

  ctx.diagnostics.add('team', () => {
    const count = (sql: string) => (ctx.db.raw.prepare(sql).get() as { n: number }).n;
    return Promise.resolve({
      members: count(
        "SELECT COUNT(*) AS n FROM team_member WHERE role = 'member' AND removed_at IS NULL",
      ),
      sharedThreads: count('SELECT COUNT(DISTINCT thread_id) AS n FROM thread_share'),
      teamAgents: count('SELECT COUNT(*) AS n FROM team_agent'),
      oidcProviders: count('SELECT COUNT(*) AS n FROM oidc_provider WHERE enabled = 1'),
    });
  });

  return Promise.resolve({
    team,
    oidc,
    cards,
    shared,
    purges,
    useExporter: (fn) => {
      exporter = fn;
    },
    agents: () => teamAgents,
    access: shared.access,
    // Shared threads, and team tasks' own threads (they read none of the agent's other work).
    toolLimits: {
      forThread: async (accountId, threadId) =>
        (await shared.toolLimits.forThread(accountId, threadId)) ??
        (teamAgents ? await teamAgents.toolLimits.forThread(accountId, threadId) : null),
    },
    scoped: (source) => memberScoped(notOwner, memberRoot, source),
    roleOf: (accountId) => team.roleOf(accountId),
    onMemberRemoved: (fn) => team.onRemoved(fn),
    useAgents: (agents) => {
      agentService = agents;
      teamAgents = new TeamAgentService({
        db: ctx.db,
        events: ctx.events,
        team,
        agents,
        registry: ctx.registry,
        egress,
        auditLog,
        log: log.child('agents'),
        now,
        ...(deps.audit ? { audit: deps.audit } : {}),
        ...(approvals ? { approvals } : {}),
      });
      if (chat) teamAgents.useTurns(chat.turnStarter);
    },
    useChat: (c) => {
      chat = c;
      teamAgents?.useTurns(c.turnStarter);
    },
    useApprovals: (a) => {
      approvals = a;
      teamAgents?.useApprovals(a);
    },
    register,
    close: async () => {
      if (sweeper) clearInterval(sweeper);
      offShared();
      offMirror();
      for (const end of [...streams]) end();
      await teamAgents?.idle();
    },
  });
}
