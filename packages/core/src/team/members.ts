// The people of one Hub (decision 5 of ADR-095, docs/13 §7). The owner invites members with a
// one-use link: only the token's SHA-256 is stored, like setup codes, and the link carries the
// token in its fragment. A member sets up their own account (display name) and gets their own
// sessions; their memory, connectors, settings and threads stay theirs because every account-scoped
// table is filtered by the account. The owner can remove a member: their sessions end at once,
// their shares end and their account is closed. Members may not administer the Hub (`access.ts`).
import { randomBytes } from 'node:crypto';
import {
  INVITATION_DEFAULT_HOURS,
  INVITATION_MAX_HOURS,
  NovaError,
  isMemberSettingKey,
  resolveSetting,
  uuidv7,
  type CreateInvitationRequest,
  type CreatedInvitationView,
  type InvitationStatus,
  type InvitationView,
  type JoinPreviewView,
  type SettingKey,
  type TeamMemberView,
  type TeamPersonView,
  type TeamRole,
  SETTINGS,
  checkSettingWrite,
} from '@nova/shared';
import { hashToken } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import { hubOwnerId, recordHubOwner } from './owner.ts';
import { oneLine } from './text.ts';

/** Session tokens for accounts (the Hub's AuthService); a token is shown once, as a cookie. */
export interface TeamSessions {
  issue(accountId: string): Promise<{ token: string; maxAgeS: number }>;
  /** End every session of the account; returns how many ended. */
  revokeAll(accountId: string): Promise<number>;
}

export interface TeamServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  audit?: AuditSink;
  sessions?: TeamSessions;
  log?: Logger;
  now?: () => Date;
  /** `team.invitationHours`: how long a new invitation link is valid. */
  invitationHours?: () => Promise<number>;
}

interface InvitationRow {
  id: string;
  token_hash: string;
  label: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  revoked_at: string | null;
}

interface PersonRow {
  id: string;
  display_name: string | null;
  username: string | null;
  avatar_path: string | null;
  role: TeamRole | null;
  joined_at: string | null;
  invited_by: string | null;
}

const TOKEN_PREFIX = 'nvi';

function ownerOnly(): NovaError {
  return new NovaError('policy_denied', 'only the owner of this Hub can do that', {
    details: { reason: 'owner_only' },
  });
}

function invalidInvitation(): NovaError {
  return new NovaError('auth_missing', 'this invitation is invalid, used or expired', {
    details: { reason: 'invitation_invalid' },
    action: 'Ask the owner of the Hub for a new invitation',
  });
}

export class TeamService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  #audit: AuditSink | undefined;
  #sessions: TeamSessions | undefined;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #hours: () => Promise<number>;
  readonly #onRemoved: ((accountId: string) => Promise<void> | void)[] = [];

  constructor(opts: TeamServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#audit = opts.audit;
    this.#sessions = opts.sessions;
    this.#log = opts.log ?? new Logger({ module: 'core.team', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#hours = opts.invitationHours ?? (() => Promise.resolve(INVITATION_DEFAULT_HOURS));
  }

  useSessions(sessions: TeamSessions): void {
    this.#sessions = sessions;
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  /** Called after a member was removed (shares end, OIDC links go). */
  onRemoved(fn: (accountId: string) => Promise<void> | void): void {
    this.#onRemoved.push(fn);
  }

  // ---- roles ---------------------------------------------------------------------------------

  /**
   * The owner: the account recorded as owner, else the first local account that is neither a
   * member nor a team agent's identity (single-owner Hubs before the first invitation).
   */
  ownerId(): string | null {
    return hubOwnerId(this.#db);
  }

  /** Record the owner row on a Hub from before M7 (the first local account that is nobody else). */
  async recordOwner(): Promise<string | null> {
    const id = this.ownerId();
    if (id) {
      const at = this.#now().toISOString();
      await this.#db.transaction(() => recordHubOwner(this.#db, id, at));
    }
    return id;
  }

  /** The account's role; null for a removed member, a team agent's identity or an unknown id. */
  roleOf(accountId: string): TeamRole | null {
    const row = this.#db.raw
      .prepare(
        `SELECT m.role AS role, m.removed_at AS removed, a.deleted_at AS deleted
         FROM team_member m JOIN account a ON a.id = m.account_id WHERE m.account_id = ?`,
      )
      .get(accountId) as
      { role: TeamRole; removed: string | null; deleted: string | null } | undefined;
    if (row) return row.removed || row.deleted ? null : row.role;
    return this.ownerId() === accountId ? 'owner' : null;
  }

  isOwner(accountId: string): boolean {
    return this.roleOf(accountId) === 'owner';
  }

  /** A member (not the owner) of this Hub. */
  isMember(accountId: string): boolean {
    return this.roleOf(accountId) === 'member';
  }

  assertOwner(accountId: string): void {
    if (!this.isOwner(accountId)) throw ownerOnly();
  }

  /** An active person of the Hub (the owner or a member). */
  assertPerson(accountId: string): TeamRole {
    const role = this.roleOf(accountId);
    if (!role) throw new NovaError('not_found', 'no such person on this Hub');
    return role;
  }

  // ---- people --------------------------------------------------------------------------------

  #people(): PersonRow[] {
    const owner = this.ownerId();
    const rows = this.#db.raw
      .prepare(
        `SELECT a.id, a.display_name, a.username, a.avatar_path, m.role, m.joined_at, m.invited_by
         FROM account a LEFT JOIN team_member m ON m.account_id = a.id
         WHERE a.deleted_at IS NULL AND (m.removed_at IS NULL AND (m.role IS NOT NULL OR a.id = ?))
         ORDER BY CASE WHEN m.role = 'owner' OR a.id = ? THEN 0 ELSE 1 END, m.joined_at, a.created_at`,
      )
      .all(owner ?? '', owner ?? '') as unknown as PersonRow[];
    return rows.map((r) => ({ ...r, role: r.role ?? 'owner' }));
  }

  person(accountId: string): TeamPersonView | null {
    const role = this.roleOf(accountId);
    if (!role) return null;
    const row = this.#db.raw
      .prepare('SELECT display_name, username, avatar_path FROM account WHERE id = ?')
      .get(accountId) as
      | { display_name: string | null; username: string | null; avatar_path: string | null }
      | undefined;
    if (!row) return null;
    return {
      accountId,
      displayName: row.display_name,
      username: row.username,
      role,
      hasAvatar: row.avatar_path !== null,
    };
  }

  /** Everyone on the Hub, the owner first. Any person may list them (to share a thread). */
  members(viewer: string): TeamMemberView[] {
    this.assertPerson(viewer);
    return this.#people().map((r) => ({
      accountId: r.id,
      displayName: r.display_name,
      username: r.username,
      role: r.role ?? 'owner',
      hasAvatar: r.avatar_path !== null,
      joinedAt: r.joined_at,
      invitedBy: r.invited_by,
      you: r.id === viewer,
    }));
  }

  // ---- invitations ---------------------------------------------------------------------------

  async createInvitation(
    actor: string,
    req: CreateInvitationRequest,
    baseUrl: string,
  ): Promise<CreatedInvitationView> {
    this.assertOwner(actor);
    const hours = Math.min(
      Math.max(req.ttlHours ?? (await this.#hours()), 1),
      INVITATION_MAX_HOURS,
    );
    const token = `${TOKEN_PREFIX}_${randomBytes(32).toString('base64url')}`;
    const now = this.#now();
    const id = uuidv7();
    const row: InvitationRow = {
      id,
      token_hash: hashToken(token),
      label: req.label ?? null,
      created_by: actor,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + hours * 3_600_000).toISOString(),
      redeemed_at: null,
      redeemed_by: null,
      revoked_at: null,
    };
    await this.#db.transaction(() => {
      this.#recordOwner(actor, row.created_at);
      this.#db.raw
        .prepare(
          `INSERT INTO team_invitation (id, token_hash, role, label, created_by, created_at, expires_at)
           VALUES (?, ?, 'member', ?, ?, ?, ?)`,
        )
        .run(id, row.token_hash, row.label, actor, row.created_at, row.expires_at);
    });
    await this.#emit('team.invitation.created', actor, {
      invitationId: id,
      expiresAt: row.expires_at,
    });
    await this.#auditAuth(actor, 'user', 'team.invite', `invitation:${id}`, {
      expiresAt: row.expires_at,
    });
    return {
      invitation: this.#invitationView(row),
      token,
      // The token rides in the fragment, which browsers never send to a server.
      url: `${baseUrl.replace(/\/$/, '')}/join#invite=${encodeURIComponent(token)}`,
    };
  }

  /** The owner's row, written once, so a later member can never be taken for the owner. */
  #recordOwner(owner: string, at: string): void {
    recordHubOwner(this.#db, owner, at);
  }

  invitations(actor: string): InvitationView[] {
    this.assertOwner(actor);
    const rows = this.#db.raw
      .prepare('SELECT * FROM team_invitation ORDER BY created_at DESC LIMIT 200')
      .all() as unknown as InvitationRow[];
    return rows.map((r) => this.#invitationView(r));
  }

  async revokeInvitation(actor: string, id: string): Promise<InvitationView> {
    this.assertOwner(actor);
    const row = this.#invitation(id);
    if (!row) throw new NovaError('not_found', 'invitation not found');
    if (this.#status(row) === 'pending') {
      const at = this.#now().toISOString();
      await this.#db.transaction(() =>
        this.#db.raw
          .prepare('UPDATE team_invitation SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(at, id),
      );
      await this.#emit('team.invitation.revoked', actor, { invitationId: id });
      await this.#auditAuth(actor, 'user', 'team.invite.revoke', `invitation:${id}`, {});
    }
    return this.#invitationView(this.#invitation(id) ?? row);
  }

  #invitation(id: string): InvitationRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM team_invitation WHERE id = ?').get(id) as
        InvitationRow | undefined) ?? null
    );
  }

  #byToken(token: string): InvitationRow | null {
    if (!token || token.length > 200 || !token.startsWith(`${TOKEN_PREFIX}_`)) return null;
    return (
      (this.#db.raw
        .prepare('SELECT * FROM team_invitation WHERE token_hash = ?')
        .get(hashToken(token)) as InvitationRow | undefined) ?? null
    );
  }

  #status(r: InvitationRow): InvitationStatus {
    if (r.revoked_at) return 'revoked';
    if (r.redeemed_at) return 'redeemed';
    if (r.expires_at <= this.#now().toISOString()) return 'expired';
    return 'pending';
  }

  #invitationView(r: InvitationRow): InvitationView {
    return {
      id: r.id,
      label: r.label,
      status: this.#status(r),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      redeemedAt: r.redeemed_at,
      redeemedBy: r.redeemed_by,
    };
  }

  /** What the join page shows before the new member picks a name (no account is created). */
  preview(token: string): Omit<JoinPreviewView, 'providers'> {
    const row = this.#byToken(token);
    if (!row || this.#status(row) !== 'pending')
      return { valid: false, label: null, invitedBy: null, expiresAt: null };
    const by = this.person(row.created_by);
    return {
      valid: true,
      label: row.label,
      invitedBy: by?.displayName ?? null,
      expiresAt: row.expires_at,
    };
  }

  /** True while the invitation can still be redeemed (OIDC checks it before leaving the Hub). */
  invitationUsable(token: string): boolean {
    const row = this.#byToken(token);
    return row !== null && this.#status(row) === 'pending';
  }

  /**
   * Redeem an invitation: the token is burned, the member's own account is created and signed in.
   * Everything happens in one transaction, so a failure leaves the invitation usable.
   * `link` runs inside it too (an OIDC identity for the new account).
   */
  async redeem(
    token: string,
    displayName: string,
    opts: { via?: 'local' | 'oidc'; link?: (accountId: string) => void } = {},
  ): Promise<{ accountId: string; session: { token: string; maxAgeS: number } }> {
    const sessions = this.#sessions;
    if (!sessions) throw new NovaError('capability_missing', 'sessions are not available');
    // A display name is one line: no control characters to pose as a label or a prompt.
    const name = oneLine(displayName).slice(0, 100);
    if (!name) throw new NovaError('validation', 'a display name is required');
    const accountId = uuidv7();
    const out = await this.#db.transaction(async () => {
      const row = this.#byToken(token);
      if (!row || this.#status(row) !== 'pending') throw invalidInvitation();
      const at = this.#now().toISOString();
      this.#db.raw
        .prepare(
          `INSERT INTO account (id, kind, display_name, created_at, updated_at)
           VALUES (?, 'local', ?, ?, ?)`,
        )
        .run(accountId, name, at, at);
      // Burned in the same transaction: a second redeemer finds it used, a failure rolls back.
      const burned = this.#db.raw
        .prepare(
          `UPDATE team_invitation SET redeemed_at = ?, redeemed_by = ?
           WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
        )
        .run(at, accountId, row.id).changes;
      if (!burned) throw invalidInvitation();
      this.#recordOwner(row.created_by, at);
      this.#db.raw
        .prepare(
          `INSERT INTO team_member (account_id, role, invitation_id, invited_by, joined_at)
           VALUES (?, 'member', ?, ?, ?)`,
        )
        .run(accountId, row.id, row.created_by, at);
      opts.link?.(accountId);
      const session = await sessions.issue(accountId);
      return { invitedBy: row.created_by, invitationId: row.id, session };
    });
    await this.#emit('team.member.joined', out.invitedBy, {
      accountId,
      invitationId: out.invitationId,
      via: opts.via ?? 'local',
    });
    await this.#auditAuth(accountId, 'user', 'team.join', `account:${accountId}`, {
      invitationId: out.invitationId,
      via: opts.via ?? 'local',
    });
    return { accountId, session: out.session };
  }

  /** A new session for an active person of the Hub (OIDC sign-in). */
  async issueSession(accountId: string): Promise<{ token: string; maxAgeS: number }> {
    if (!this.roleOf(accountId))
      throw new NovaError('auth_missing', 'this account is closed', {
        details: { reason: 'account_closed' },
      });
    if (!this.#sessions) throw new NovaError('capability_missing', 'sessions are not available');
    return this.#sessions.issue(accountId);
  }

  /** The owner removes a member: sessions end at once, shares and OIDC links go, the account closes. */
  async removeMember(actor: string, accountId: string): Promise<{ sessionsEnded: number }> {
    this.assertOwner(actor);
    if (accountId === actor) throw new NovaError('validation', 'the owner cannot remove themself');
    if (this.roleOf(accountId) !== 'member') throw new NovaError('not_found', 'no such member');
    const sessions = this.#sessions;
    const at = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE team_member SET removed_at = ?, removed_by = ? WHERE account_id = ?')
        .run(at, actor, accountId);
      this.#db.raw
        .prepare('UPDATE account SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(at, at, accountId);
      this.#db.raw
        .prepare('DELETE FROM thread_share WHERE account_id = ? OR owner_account_id = ?')
        .run(accountId, accountId);
      this.#db.raw.prepare('DELETE FROM oidc_identity WHERE account_id = ?').run(accountId);
      this.#db.raw
        .prepare('UPDATE profile_card SET enabled = 0 WHERE account_id = ?')
        .run(accountId);
      this.#stopWork(accountId, at);
    });
    let ended = 0;
    try {
      ended = sessions ? await sessions.revokeAll(accountId) : 0;
    } catch (err) {
      // The account is closed: its sessions no longer authenticate even if revoking failed.
      this.#log.error('could not revoke the sessions of a removed member', { err, accountId });
    }
    for (const fn of this.#onRemoved) {
      try {
        await fn(accountId);
      } catch (err) {
        this.#log.warn('a member removal hook failed', { err, accountId });
      }
    }
    await this.#emit('team.member.removed', actor, { accountId, sessionsEnded: ended });
    await this.#auditAuth(actor, 'user', 'team.member.remove', `account:${accountId}`, {
      sessionsEnded: ended,
    });
    return { sessionsEnded: ended };
  }

  /**
   * Nothing of a removed member keeps working on the Hub: schedules, triggers and channel
   * bindings are disabled, agents stopped, MCP servers turned off, MCP event and push
   * subscriptions ended. Turns and runs of a closed account are refused too (the loop and the
   * runs check); live connections close through the `onRemoved` hooks.
   */
  #stopWork(accountId: string, at: string): void {
    const has = (t: string) =>
      this.#db.raw
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(t) !== undefined;
    const run = (t: string, sql: string) => {
      if (has(t)) this.#db.raw.prepare(sql).run(accountId);
    };
    run('schedule', 'UPDATE schedule SET enabled = 0 WHERE account_id = ?');
    run('trigger', 'UPDATE trigger SET enabled = 0 WHERE account_id = ?');
    run('channel_binding', 'UPDATE channel_binding SET enabled = 0 WHERE account_id = ?');
    run('mcp_server', 'UPDATE mcp_server SET enabled = 0 WHERE account_id = ?');
    run(
      'mcp_event_subscription',
      `UPDATE mcp_event_subscription SET status = 'removed'
       WHERE account_id = ? AND status IN ('pending', 'active', 'refreshing', 'lapsed')`,
    );
    run('push_subscription', "UPDATE push_subscription SET status = 'gone' WHERE account_id = ?");
    if (has('agent'))
      this.#db.raw
        .prepare(
          `UPDATE agent SET status = 'stopped', pause_reason = NULL,
             status_detail = 'its person was removed from the Hub', updated_at = ?
           WHERE account_id = ?`,
        )
        .run(at, accountId);
  }

  // ---- a member's own preferences --------------------------------------------------------------

  /** The member's own preference values over the defaults (appearance, keyboard, onboarding). */
  memberSettings(
    accountId: string,
  ): Record<string, { value: unknown; source: 'default' | 'member' }> {
    this.assertPerson(accountId);
    const rows = this.#db.raw
      .prepare('SELECT key, value_json FROM member_setting WHERE account_id = ?')
      .all(accountId) as { key: string; value_json: string }[];
    const own = new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
    const out: Record<string, { value: unknown; source: 'default' | 'member' }> = {};
    for (const key of Object.keys(SETTINGS)) {
      if (!isMemberSettingKey(key)) continue;
      out[key] = own.has(key)
        ? { value: own.get(key), source: 'member' }
        : {
            value: resolveSetting(key as SettingKey, { global: {}, project: {}, managed: {} })
              .value,
            source: 'default',
          };
    }
    return out;
  }

  async setMemberSetting(accountId: string, key: string, value: unknown): Promise<void> {
    this.assertPerson(accountId);
    if (!isMemberSettingKey(key))
      throw new NovaError('policy_denied', 'this setting belongs to the Hub, not to you', {
        details: { reason: 'owner_only', key },
      });
    const check = checkSettingWrite(key, value, 'global', { global: {}, project: {}, managed: {} });
    if (!check.ok)
      throw new NovaError('validation', check.message, { details: { reason: check.error } });
    const at = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare(
          `INSERT INTO member_setting (account_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (account_id, key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(accountId, key, JSON.stringify(check.value), at),
    );
    await this.#events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId,
      payload: { key, scope: 'member' },
    });
  }

  // ---- events and audit ------------------------------------------------------------------------

  async #emit(name: string, accountId: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.#events.emit({ name, actor: 'user', accountId, payload });
    } catch (err) {
      this.#log.warn('team event not recorded', { err, name });
    }
  }

  async #auditAuth(
    accountId: string,
    actor: string,
    action: string,
    resource: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#audit?.append({ accountId, actor, kind: 'auth', action, resource, detail });
    } catch (err) {
      this.#log.warn('team audit not recorded', { err, action });
    }
  }
}
