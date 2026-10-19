// The people of a Hub (decision 5): one-use invitations like setup codes, members with their own
// account and sessions, removal ends their sessions, members keep only their own preferences,
// public profile cards are opt-in, and the routes a member may not use.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  ProfileCardService,
  TeamService,
  memberBodyReason,
  memberScoped,
  memberWorkspace,
  ownerOnlyError,
  ownerOnlyReason,
  UNCLASSIFIED_WHY,
  type AuditRecord,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { ensureTeamTables } from './team-env.ts';

let db: NovaDatabase;
let team: TeamService;
let clock: Date;
let events: MemoryEventSink;
const audit: AuditRecord[] = [];
const issued: string[] = [];
const revoked: string[] = [];

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  ensureTeamTables(db);
  clock = new Date('2026-10-01T10:00:00.000Z');
  const at = clock.toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, at, at);
  audit.length = 0;
  issued.length = 0;
  revoked.length = 0;
  events = new MemoryEventSink();
  team = new TeamService({
    db,
    events,
    now: () => clock,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    sessions: {
      issue: (accountId) => {
        issued.push(accountId);
        return Promise.resolve({ token: 'tok', maxAgeS: 1 });
      },
      revokeAll: (accountId) => {
        revoked.push(accountId);
        return Promise.resolve(2);
      },
    },
  });
});

afterEach(() => db.close());

describe('invitations', () => {
  it('are one-use links that only the owner makes; only the hash is stored', async () => {
    expect(team.ownerId()).toBe(ACCOUNT);
    expect(team.roleOf(ACCOUNT)).toBe('owner');
    const inv = await team.createInvitation(ACCOUNT, { label: 'for Bea' }, 'http://hub:7419/');
    expect(inv.url).toBe(`http://hub:7419/join#invite=${encodeURIComponent(inv.token)}`);
    expect(inv.invitation).toMatchObject({ status: 'pending', label: 'for Bea' });
    expect(inv.invitation.expiresAt).toBe('2026-10-04T10:00:00.000Z');
    const stored = JSON.stringify(db.raw.prepare('SELECT * FROM team_invitation').all());
    expect(stored).not.toContain(inv.token);
    expect(team.preview(inv.token)).toMatchObject({
      valid: true,
      invitedBy: 'Owner',
      label: 'for Bea',
    });

    const joined = await team.redeem(inv.token, '  Bea  ');
    expect(team.roleOf(joined.accountId)).toBe('member');
    expect(team.person(joined.accountId)).toMatchObject({ displayName: 'Bea', role: 'member' });
    expect(issued).toEqual([joined.accountId]);
    expect(team.preview(inv.token).valid).toBe(false);
    await expect(team.redeem(inv.token, 'Eve')).rejects.toMatchObject({
      code: 'auth_missing',
      details: { reason: 'invitation_invalid' },
    });
    // The member is not the owner and cannot invite.
    expect(team.ownerId()).toBe(ACCOUNT);
    await expect(team.createInvitation(joined.accountId, {}, 'http://hub')).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'owner_only' },
    });
    expect(() => team.invitations(joined.accountId)).toThrow();
    expect(team.invitations(ACCOUNT)).toMatchObject([
      { status: 'redeemed', redeemedBy: joined.accountId },
    ]);
    expect(team.members(joined.accountId).map((m) => [m.displayName, m.role, m.you])).toEqual([
      ['Owner', 'owner', false],
      ['Bea', 'member', true],
    ]);
    expect(audit.map((a) => a.action)).toEqual(['team.invite', 'team.join']);
    expect(events.names()).toEqual(['team.invitation.created', 'team.member.joined']);
  });

  it('expire, can be revoked, and refuse a blank name or a malformed token', async () => {
    const inv = await team.createInvitation(ACCOUNT, { ttlHours: 1 }, 'http://hub');
    await expect(team.redeem(inv.token, '   ')).rejects.toMatchObject({ code: 'validation' });
    await expect(team.redeem('garbage', 'Bea')).rejects.toMatchObject({ code: 'auth_missing' });
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    expect(team.invitations(ACCOUNT)[0]!.status).toBe('expired');
    await expect(team.redeem(inv.token, 'Bea')).rejects.toMatchObject({ code: 'auth_missing' });
    const inv2 = await team.createInvitation(ACCOUNT, {}, 'http://hub');
    await team.revokeInvitation(ACCOUNT, inv2.invitation.id);
    expect(team.invitationUsable(inv2.token)).toBe(false);
    await expect(team.redeem(inv2.token, 'Bea')).rejects.toMatchObject({ code: 'auth_missing' });
    await expect(team.revokeInvitation(ACCOUNT, 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    // Nothing was created by the failed attempts.
    expect(team.members(ACCOUNT)).toHaveLength(1);
  });

  it('leave nothing behind when the session cannot be issued', async () => {
    const broken = new TeamService({
      db,
      events,
      sessions: {
        issue: () => Promise.reject(new Error('down')),
        revokeAll: () => Promise.resolve(0),
      },
    });
    const inv = await broken.createInvitation(ACCOUNT, {}, 'http://hub');
    await expect(broken.redeem(inv.token, 'Bea')).rejects.toThrow('down');
    expect(broken.invitationUsable(inv.token)).toBe(true);
    expect(broken.members(ACCOUNT)).toHaveLength(1);
    const none = new TeamService({ db, events });
    await expect(none.redeem(inv.token, 'Bea')).rejects.toMatchObject({
      code: 'capability_missing',
    });
  });
});

describe('members', () => {
  async function member(name: string) {
    const inv = await team.createInvitation(ACCOUNT, {}, 'http://hub');
    return (await team.redeem(inv.token, name)).accountId;
  }

  it('are removed by the owner only: sessions end, the account closes', async () => {
    const bea = await member('Bea');
    const cy = await member('Cy');
    await expect(team.removeMember(bea, cy)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(team.removeMember(ACCOUNT, ACCOUNT)).rejects.toMatchObject({ code: 'validation' });
    await expect(team.removeMember(ACCOUNT, 'nobody')).rejects.toMatchObject({ code: 'not_found' });
    const removed: string[] = [];
    team.onRemoved((id) => void removed.push(id));
    team.onRemoved(() => {
      throw new Error('a hook fails; removal still completes');
    });
    expect(await team.removeMember(ACCOUNT, bea)).toEqual({ sessionsEnded: 2 });
    expect(revoked).toEqual([bea]);
    expect(removed).toEqual([bea]);
    expect(team.roleOf(bea)).toBeNull();
    expect(team.person(bea)).toBeNull();
    await expect(team.issueSession(bea)).rejects.toMatchObject({
      details: { reason: 'account_closed' },
    });
    const row = db.raw.prepare('SELECT deleted_at FROM account WHERE id = ?').get(bea) as {
      deleted_at: string;
    };
    expect(row.deleted_at).not.toBeNull();
    expect(team.members(ACCOUNT).map((m) => m.displayName)).toEqual(['Owner', 'Cy']);
    await expect(team.removeMember(ACCOUNT, bea)).rejects.toMatchObject({ code: 'not_found' });
    expect(() => team.members(bea)).toThrow();
  });

  it("keep their own preferences; the Hub settings stay the owner's", async () => {
    const bea = await member('Bea');
    await team.setMemberSetting(bea, 'appearance.theme', 'dark');
    expect(team.memberSettings(bea)['appearance.theme']).toEqual({
      value: 'dark',
      source: 'member',
    });
    expect(team.memberSettings(ACCOUNT)['appearance.theme']).toEqual({
      value: 'system',
      source: 'default',
    });
    expect(team.memberSettings(bea)['tools.roots']).toBeUndefined();
    await expect(team.setMemberSetting(bea, 'tools.roots', [])).rejects.toMatchObject({
      details: { reason: 'owner_only' },
    });
    await expect(team.setMemberSetting(bea, 'appearance.theme', 'neon')).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(team.setMemberSetting('nobody', 'appearance.theme', 'dark')).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
  });

  it('do not take a team agent identity or a removed member for the owner', async () => {
    const bea = await member('Bea');
    // A fresh Hub records the owner on the first invitation; even without that row the first
    // local account that is nobody else is the owner.
    db.raw.prepare("DELETE FROM team_member WHERE role = 'owner'").run();
    expect(team.ownerId()).toBe(ACCOUNT);
    expect(team.roleOf(bea)).toBe('member');
    db.raw.prepare('UPDATE account SET deleted_at = ? WHERE id = ?').run('x', ACCOUNT);
    expect(team.ownerId()).toBeNull();
    expect(team.roleOf(ACCOUNT)).toBeNull();
  });
});

describe('public profile cards (FR-113)', () => {
  it('are off until the Hub allows them and the person publishes one', async () => {
    let allowed = false;
    const cards = new ProfileCardService({ db, allowed: () => Promise.resolve(allowed) });
    expect(await cards.get(ACCOUNT)).toEqual({
      allowed: false,
      enabled: false,
      handle: null,
      showAvatar: true,
      path: null,
    });
    await expect(cards.set(ACCOUNT, { enabled: true, handle: 'owner' })).rejects.toMatchObject({
      details: { reason: 'setting_off' },
    });
    // Reserving a handle without publishing is fine.
    await cards.set(ACCOUNT, { enabled: false, handle: 'owner' });
    expect(await cards.publicCard('owner')).toBeNull();
    allowed = true;
    expect(await cards.publicCard('owner')).toBeNull();
    const v = await cards.set(ACCOUNT, { enabled: true, handle: 'owner', showAvatar: false });
    expect(v).toEqual({
      allowed: true,
      enabled: true,
      handle: 'owner',
      showAvatar: false,
      path: '/api/v1/profiles/owner',
    });
    expect(await cards.publicCard('owner')).toEqual({
      accountId: ACCOUNT,
      handle: 'owner',
      displayName: 'Owner',
      showAvatar: false,
      hasAvatar: false,
    });
    const inv = await team.createInvitation(ACCOUNT, {}, 'http://hub');
    const bea = (await team.redeem(inv.token, 'Bea')).accountId;
    await expect(cards.set(bea, { enabled: true, handle: 'owner' })).rejects.toMatchObject({
      code: 'conflict',
    });
    allowed = false;
    expect(await cards.publicCard('owner')).toBeNull();
  });
});

describe('what a member may not do', () => {
  it('refuses Hub administration and the Hub machine, by route pattern', () => {
    expect(ownerOnlyReason('PATCH', '/api/v1/settings')).toBe("the Hub's settings");
    expect(ownerOnlyReason('GET', '/api/v1/settings')).toBe("the Hub's settings");
    expect(ownerOnlyReason('POST', '/api/v1/network/setup')).toBe("the Hub's network");
    expect(ownerOnlyReason('GET', '/api/v1/files/content')).toBe("the Hub's files");
    expect(ownerOnlyReason('PUT', '/api/v1/cloud/runner')).toBe("the Hub's cloud runner");
    expect(ownerOnlyReason('POST', '/api/v1/agent-adapters')).toBe('programs on the Hub machine');
    expect(ownerOnlyReason('POST', '/api/v1/delegations/:id/cancel')).toBe(
      'Code sessions on the Hub',
    );
    expect(ownerOnlyReason('POST', '/api/v1/terminals')).toBe('a shell on the Hub machine');
    expect(ownerOnlyReason('DELETE', '/api/v1/plugins/:id')).not.toBeNull();
    expect(ownerOnlyReason('GET', '/api/v1/plugins')).toBeNull();
    expect(ownerOnlyReason('POST', '/api/v1/code/sessions')).not.toBeNull();
    expect(ownerOnlyReason('POST', '/api/v1/projects/:id/folders')).not.toBeNull();
    expect(ownerOnlyReason('GET', '/api/v1/trust')).not.toBeNull();
    expect(ownerOnlyReason('GET', '/api/v1/trust/ca.pem')).toBeNull();
    // The Hub's people, sign-in providers and team agents (checked in their services too, M8).
    expect(ownerOnlyReason('POST', '/api/v1/team/invitations')).toBe("the Hub's people");
    expect(ownerOnlyReason('POST', '/api/v1/team/removed/:id/purge')).toBe("the Hub's people");
    expect(ownerOnlyReason('PATCH', '/api/v1/team/oidc/:id')).toBe("the Hub's sign-in providers");
    expect(ownerOnlyReason('POST', '/api/v1/team/agents')).toBe("the Hub's team agents");
    expect(ownerOnlyReason('HEAD', '/api/v1/settings')).toBe("the Hub's settings");
    // Public routes that authenticate another way stay open, and so do a member's own areas.
    expect(ownerOnlyReason('POST', '/api/v1/devices/add/complete')).toBeNull();
    expect(ownerOnlyReason('POST', '/api/v1/threads/:id/messages')).toBeNull();
    expect(ownerOnlyReason('GET', '/api/v1/team/agents')).toBeNull();
    expect(ownerOnlyReason('POST', '/agent/v1/heartbeat')).toBeNull();
    expect(ownerOnlyReason('GET', undefined)).toBeNull();
    // The web shell's files are public; an API route nobody classified is refused (fail closed).
    expect(ownerOnlyReason('GET', '/index.html')).toBeNull();
    expect(ownerOnlyReason('GET', '/api/v1/networks')).toBe(UNCLASSIFIED_WHY);
    expect(ownerOnlyReason('DELETE', '/api/v1/threads')).toBe(UNCLASSIFIED_WHY);
    expect(ownerOnlyReason('POST', '/node/v1/elsewhere')).toBe(UNCLASSIFIED_WHY);
    expect(
      memberBodyReason('POST', '/api/v1/mcp/servers', { transport: 'stdio', command: 'sh' }),
    ).not.toBeNull();
    expect(memberBodyReason('PATCH', '/api/v1/mcp/servers/:id', { args: ['-c'] })).not.toBeNull();
    expect(
      memberBodyReason('POST', '/api/v1/mcp/servers', { transport: 'http', url: 'https://x' }),
    ).toBeNull();
    expect(memberBodyReason('POST', '/api/v1/threads/:id/messages', { command: 'x' })).toBeNull();
    expect(memberBodyReason('POST', undefined, null)).toBeNull();
    expect(ownerOnlyError("the Hub's files")).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'owner_only' },
    });
  });

  it("puts a member's threads in their own folder, leaving others' policies alone", async () => {
    const isMember = (id: string) => id === 'bea';
    const root = (id: string) => memberWorkspace('/data', id);
    expect(root('bea')).toBe('/data/members/bea/workspace');
    const run = {
      forThread: (_a: string, t: string) =>
        Promise.resolve(
          t === 'run'
            ? {
                approvalPolicy: 'defaults' as const,
                profileId: null,
                roots: null,
                permissionMode: null,
                autoAcceptEdits: false,
              }
            : t === 'agent'
              ? {
                  approvalPolicy: null,
                  profileId: null,
                  roots: [{ path: '/c', access: 'write' as const, label: 'Computer' }],
                  permissionMode: null,
                  autoAcceptEdits: false,
                }
              : null,
        ),
    };
    const wrapped = memberScoped(isMember, root, run);
    expect((await wrapped.forThread('bea', 'run'))?.roots?.[0]?.path).toBe(
      '/data/members/bea/workspace',
    );
    expect((await wrapped.forThread('bea', 'run'))?.approvalPolicy).toBe('defaults');
    expect((await wrapped.forThread('bea', 'agent'))?.roots?.[0]?.path).toBe('/c');
    expect(await wrapped.forThread('bea', 'chat')).toBeNull();
    expect((await wrapped.forThread('owner', 'run'))?.roots).toBeNull();
    const fallback = memberScoped(isMember, root);
    expect((await fallback.forThread('bea', 'chat'))?.roots?.[0]?.label).toBe('My files');
    expect(await fallback.forThread('owner', 'chat')).toBeNull();
  });
});
