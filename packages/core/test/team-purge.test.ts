// A removed member's data (decision 5; M8, ADR-097): kept after removal so the owner can export
// it, purged after the owner's grace period or at once on request. The purge deletes every row the
// account owned (and the rows hanging off them), the blobs only they named, the vault entries of
// their rows and their folder; the owner's data, the audit chain and spend accounting stay.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import {
  AuditLog,
  MemberPurgeService,
  PURGE_KEEPS,
  REDACTED_MESSAGE_TEXT,
  memberWorkspace,
  purgeAccountRows,
  secretsOfIds,
  type AuditRecord,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { makeTeamEnv, type TeamEnv } from './team-env.ts';

let env: TeamEnv;
let dataDir: string;
let clock: Date;
let days: number;
let audit: AuditRecord[];
let purges: MemberPurgeService;

beforeEach(async () => {
  env = await makeTeamEnv();
  dataDir = join(env.dir, 'data');
  clock = new Date('2026-10-01T00:00:00.000Z');
  days = 30;
  audit = [];
  purges = new MemberPurgeService({
    db: env.db,
    dataDir,
    team: env.team,
    events: env.events,
    secrets: env.secrets,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    now: () => clock,
    graceDays: () => Promise.resolve(days),
  });
});
afterEach(() => env.close());

/** Every account-scoped row count of an account (keeps excluded), by table. */
function accountRows(accountId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const tables = env.db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const cols = env.db.raw.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'account_id') || PURGE_KEEPS.has(name)) continue;
    const n = (
      env.db.raw
        .prepare(`SELECT count(*) AS n FROM "${name}" WHERE account_id = ?`)
        .get(accountId) as {
        n: number;
      }
    ).n;
    if (n) out[name] = n;
  }
  return out;
}

/** Remove a member at the test clock's time. */
async function remove(accountId: string) {
  await env.team.removeMember(ACCOUNT, accountId);
  env.db.raw
    .prepare('UPDATE team_member SET removed_at = ? WHERE account_id = ?')
    .run(clock.toISOString(), accountId);
}

const blob = (rel: string, body: string) => {
  mkdirSync(join(dataDir, rel, '..'), { recursive: true });
  writeFileSync(join(dataDir, rel), body);
};

/** A member with chats, memory, settings, tokens, files, vault entries and a shared chat. */
async function busyMember(name: string) {
  const bea = await env.addMember(name);
  const mine = await env.threads.create(bea, {});
  await env.chat.send(bea, mine.id, { text: 'my secret garden plan' });
  await env.chat.idle();
  const side = await env.threads.create(bea, {});
  env.db.raw.prepare('UPDATE thread SET parent_thread_id = ? WHERE id = ?').run(mine.id, side.id);
  await env.memory.create(bea, { content: 'Bea keeps honey bees' });
  await env.team.setMemberSetting(bea, 'appearance.theme', 'dark');
  const now = clock.toISOString();
  env.db.raw
    .prepare(
      "INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES (?, 'session', ?, ?, ?)",
    )
    .run(uuidv7(), `hash-${uuidv7()}`, bea, now);
  // An attachment whose blob only she names, and one the owner's attachment shares.
  const msg = (
    env.db.raw.prepare('SELECT id FROM message WHERE thread_id = ? LIMIT 1').get(mine.id) as {
      id: string;
    }
  ).id;
  for (const [path, body] of [
    ['blobs/aa/only-bea', 'bea'],
    ['blobs/bb/shared', 'same'],
  ] as const) {
    blob(path, body);
    env.db.raw
      .prepare(
        `INSERT INTO attachment (id, thread_id, message_id, name, mime, size, blob_path, sha256, created_at)
         VALUES (?, ?, ?, 'f.txt', 'text/plain', 4, ?, ?, ?)`,
      )
      .run(uuidv7(), mine.id, msg, path, `sha-${path}`, now);
  }
  // Her provider's key, keyed by its row id; a message naming the owner's key changes nothing.
  const provider = (
    env.db.raw.prepare('SELECT id FROM provider_account WHERE account_id = ?').get(bea) as {
      id: string;
    }
  ).id;
  await env.secrets.put(`secret://provider/${provider}/api_key`, 'bea-key');
  // What she installed from the marketplace and how she rated it (migration 0046).
  env.db.raw
    .prepare(
      `INSERT INTO market_install (id, account_id, kind, item_id, name, version, catalog_id, origin,
         signature, installed_at, updated_at)
       VALUES (?, ?, 'theme', 'com.test.dusk', 'Dusk', '1.0.0', 'c', 'c/com.test.dusk@1.0.0',
         'verified', ?, ?)`,
    )
    .run(uuidv7(), bea, now, now);
  env.db.raw
    .prepare(
      `INSERT INTO market_rating (id, account_id, kind, item_id, stars, created_at, updated_at)
       VALUES (?, ?, 'theme', 'com.test.dusk', 4, ?, ?)`,
    )
    .run(uuidv7(), bea, now, now);
  // Her own folder.
  const ws = memberWorkspace(dataDir, bea);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'notes.md'), 'hers');
  // The owner's chat, shared with her, where she wrote.
  const owners = await env.threads.create(ACCOUNT, {});
  await env.shared.share(ACCOUNT, owners.id, [bea]);
  await env.chat.send(bea, owners.id, { text: 'hello from bea' });
  await env.chat.idle();
  // A file she attached there, which nothing else names.
  const said = (
    env.db.raw
      .prepare(
        "SELECT id FROM message WHERE thread_id = ? AND role = 'user' ORDER BY created_at DESC",
      )
      .get(owners.id) as { id: string }
  ).id;
  blob('blobs/cc/bea-in-shared', 'pic');
  env.db.raw
    .prepare(
      `INSERT INTO attachment (id, thread_id, message_id, name, mime, size, blob_path, sha256, created_at)
       VALUES (?, ?, ?, 'p.png', 'image/png', 3, 'blobs/cc/bea-in-shared', 'sha-p', ?)`,
    )
    .run(uuidv7(), owners.id, said, now);
  return { bea, mine, side, provider, owners };
}

async function ownerData() {
  const t = await env.threads.create(ACCOUNT, {});
  await env.chat.send(ACCOUNT, t.id, { text: 'the owner thinks' });
  await env.chat.idle();
  await env.memory.create(ACCOUNT, { content: 'The owner paints with teal' });
  const msg = (
    env.db.raw.prepare('SELECT id FROM message WHERE thread_id = ? LIMIT 1').get(t.id) as {
      id: string;
    }
  ).id;
  env.db.raw
    .prepare(
      `INSERT INTO attachment (id, thread_id, message_id, name, mime, size, blob_path, sha256, created_at)
       VALUES (?, ?, ?, 'g.txt', 'text/plain', 4, 'blobs/bb/shared', 'sha-o', ?)`,
    )
    .run(uuidv7(), t.id, msg, clock.toISOString());
  const provider = (
    env.db.raw.prepare('SELECT id FROM provider_account WHERE account_id = ?').get(ACCOUNT) as {
      id: string;
    }
  ).id;
  await env.secrets.put(`secret://provider/${provider}/api_key`, 'owner-key');
  return { thread: t, provider };
}

describe('purging a removed member', () => {
  it('deletes everything the account owned and nothing of anyone else', async () => {
    const owner = await ownerData();
    const { bea, provider, owners } = await busyMember('Bea');
    // She typed the owner's vault reference into a chat: it must never delete that entry.
    await env.chat.send(bea, (await env.threads.create(bea, {})).id, {
      text: `see secret://provider/${owner.provider}/api_key`,
    });
    await env.chat.idle();
    const auditLog = new AuditLog({ db: env.db });
    await auditLog.append({ accountId: bea, actor: 'user', kind: 'auth', action: 'x' });
    const ownerBefore = accountRows(ACCOUNT);
    expect(Object.keys(accountRows(bea))).toEqual(
      expect.arrayContaining(['thread', 'memory_item', 'member_setting', 'auth_token']),
    );
    const usageBefore = (
      env.db.raw.prepare('SELECT count(*) AS n FROM usage_event WHERE account_id = ?').get(bea) as {
        n: number;
      }
    ).n;

    await remove(bea);
    // Removal keeps the data.
    expect(accountRows(bea).thread).toBeGreaterThan(0);
    const [kept] = await purges.removed(ACCOUNT);
    expect(kept).toMatchObject({
      accountId: bea,
      displayName: 'Bea',
      status: 'scheduled',
      purgeAfter: '2026-10-31T00:00:00.000Z',
      exportable: true,
    });

    const view = await purges.purge(ACCOUNT, bea);
    expect(view).toMatchObject({ status: 'purged', cause: 'request', displayName: null });
    expect(view.exportable).toBe(false);
    expect(accountRows(bea)).toEqual({});
    expect(accountRows(ACCOUNT)).toEqual(ownerBefore);
    // The owner's shared chat stays, without her participation.
    expect(
      env.db.raw.prepare('SELECT 1 AS x FROM thread WHERE id = ?').get(owners.id),
    ).toBeDefined();
    expect(
      env.db.raw
        .prepare('SELECT count(*) AS n FROM thread_share WHERE thread_id = ?')
        .get(owners.id),
    ).toEqual({ n: 0 });
    // Blobs only she named go; one the owner shares stays.
    expect(existsSync(join(dataDir, 'blobs/aa/only-bea'))).toBe(false);
    expect(existsSync(join(dataDir, 'blobs/bb/shared'))).toBe(true);
    // Her vault entry goes; the owner's stays although she named it.
    expect(await env.secrets.get(`secret://provider/${provider}/api_key`)).toBeNull();
    expect(await env.secrets.get(`secret://provider/${owner.provider}/api_key`)).toBe('owner-key');
    expect(existsSync(join(dataDir, 'members', bea))).toBe(false);
    // The account row stays (the audit names it) without personal fields; so do her member row,
    // the audit chain and usage rows (without their threads).
    expect(
      env.db.raw
        .prepare('SELECT display_name, username, email, deleted_at FROM account WHERE id = ?')
        .get(bea),
    ).toMatchObject({ display_name: null, username: null, email: null });
    expect(env.team.roleOf(bea)).toBeNull();
    expect(
      env.db.raw.prepare('SELECT count(*) AS n FROM audit_event WHERE account_id = ?').get(bea),
    ).toEqual({ n: 1 });
    expect((await auditLog.verify()).ok).toBe(true);
    const usage = env.db.raw
      .prepare('SELECT count(*) AS n, max(thread_id) AS t FROM usage_event WHERE account_id = ?')
      .get(bea) as { n: number; t: string | null };
    expect(usage).toEqual({ n: usageBefore, t: null });
    // Audited and announced to the owner.
    expect(audit.find((a) => a.action === 'team.member.purge')).toMatchObject({
      accountId: ACCOUNT,
      actor: 'user',
      resource: `account:${bea}`,
      result: 'ok',
      detail: { cause: 'request', redactedMessages: 1 },
    });
    expect(env.envelopes.find((e) => e.name === 'team.member.purged')).toMatchObject({
      accountId: ACCOUNT,
      payload: { accountId: bea, cause: 'request' },
    });
    expect(view.counts?.rows.thread).toBe(3);
    expect(view.counts?.rows).toMatchObject({ market_install: 1, market_rating: 1 });
    expect(view.counts).toMatchObject({ secrets: 1, folders: 1 });
    expect(view.cleanupPending).toBe(false);
    expect(
      env.db.raw
        .prepare('SELECT status, cleanup_json FROM member_purge WHERE account_id = ?')
        .get(bea),
    ).toEqual({ status: 'purged', cleanup_json: null });
    // Twice is a conflict.
    await expect(purges.purge(ACCOUNT, bea)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'already_purged' },
    });
  });

  it('purges after the grace period, keeps data while it is 0, and only for the owner', async () => {
    const { bea } = await busyMember('Bea');
    const cy = await env.addMember('Cy');
    await remove(bea);
    expect((await purges.sweep()).purged).toEqual([]);
    clock = new Date('2026-10-30T23:59:00.000Z');
    expect((await purges.sweep()).purged).toEqual([]);
    days = 0;
    clock = new Date('2027-01-01T00:00:00.000Z');
    expect(await purges.sweep()).toEqual({ purged: [], failed: [] });
    expect((await purges.removed(ACCOUNT))[0]).toMatchObject({ status: 'kept', purgeAfter: null });
    days = 30;
    expect(await purges.sweep()).toEqual({ purged: [bea], failed: [] });
    expect(accountRows(bea)).toEqual({});
    expect((await purges.removed(ACCOUNT))[0]).toMatchObject({ status: 'purged', cause: 'grace' });
    expect(audit.find((a) => a.action === 'team.member.purge')).toMatchObject({
      actor: 'system',
      detail: { cause: 'grace' },
    });
    // Nobody but the owner, and never an active member or the owner themself.
    await expect(purges.removed(cy)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(purges.purge(cy, bea)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(purges.purge(ACCOUNT, cy)).rejects.toMatchObject({ code: 'not_found' });
    await expect(purges.purge(ACCOUNT, ACCOUNT)).rejects.toMatchObject({ code: 'not_found' });
    await expect(purges.get(ACCOUNT, uuidv7())).rejects.toMatchObject({ code: 'not_found' });
    expect(accountRows(cy).thread ?? 0).toBe(0);
  });

  it('leaves the data whole when the purge fails, records it and tries again a day later', async () => {
    const { bea } = await busyMember('Bea');
    await remove(bea);
    const before = accountRows(bea);
    // A table whose reference cannot be cleared stops the purge midway (a later table's mistake).
    env.db.raw.exec(
      `CREATE TABLE purge_blocker (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES thread (id),
         account_id TEXT REFERENCES account (id))`,
    );
    const mine = (
      env.db.raw.prepare('SELECT id FROM thread WHERE account_id = ?').get(bea) as {
        id: string;
      }
    ).id;
    env.db.raw
      .prepare('INSERT INTO purge_blocker (id, thread_id, account_id) VALUES (?, ?, ?)')
      .run(uuidv7(), mine, ACCOUNT);
    env.db.raw.exec(
      `CREATE TRIGGER purge_blocker_guard BEFORE DELETE ON purge_blocker
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    clock = new Date('2026-11-15T00:00:00.000Z');
    expect(await purges.sweep()).toEqual({ purged: [], failed: [bea] });
    expect(accountRows(bea)).toEqual(before);
    expect((await purges.removed(ACCOUNT))[0]).toMatchObject({ status: 'failed', cause: 'grace' });
    expect((await purges.removed(ACCOUNT))[0]!.error).toMatch(/blocked/);
    expect(audit.find((a) => a.action === 'team.member.purge')).toMatchObject({ result: 'error' });
    // Not again within a day; once the blocker is gone, the next day's sweep purges.
    expect(await purges.sweep()).toEqual({ purged: [], failed: [] });
    env.db.raw.exec('DROP TRIGGER purge_blocker_guard');
    clock = new Date('2026-11-16T00:00:01.000Z');
    expect(await purges.sweep()).toEqual({ purged: [bea], failed: [] });
    expect(env.db.raw.prepare('SELECT count(*) AS n FROM purge_blocker').get()).toEqual({ n: 0 });
  });
});

describe('the purge walk', () => {
  it('runs over the whole schema for an account with no rows, changing nothing else', async () => {
    const ghost = uuidv7();
    const at = clock.toISOString();
    env.db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'G', ?, ?)",
      )
      .run(ghost, at, at);
    const owner = accountRows(ACCOUNT);
    const out = await env.db.transaction(() => purgeAccountRows(env.db, ghost, at));
    expect(out.rows).toEqual({});
    expect(accountRows(ACCOUNT)).toEqual(owner);
  });

  it('matches vault references by a whole path segment', () => {
    const ids = new Set(['0192aaaa-0000-7000-8000-000000000001']);
    expect(
      secretsOfIds(
        [
          'secret://provider/0192aaaa-0000-7000-8000-000000000001/api_key',
          'secret://provider/0192aaaa-0000-7000-8000-0000000000012/api_key',
          'secret://hub/identity',
          'plain://0192aaaa-0000-7000-8000-000000000001',
        ],
        ids,
      ),
    ).toEqual(['secret://provider/0192aaaa-0000-7000-8000-000000000001/api_key']);
  });
});

describe("a purged member's words in shared chats (decision: redacted)", () => {
  it("keeps the owner's chat whole and redacts only what the member wrote there", async () => {
    const { bea, owners } = await busyMember('Bea');
    await env.chat.send(ACCOUNT, owners.id, { text: 'the owner answers' });
    await env.chat.idle();
    const before = env.db.raw
      .prepare('SELECT id, role FROM message WHERE thread_id = ? ORDER BY created_at, id')
      .all(owners.id) as { id: string; role: string }[];
    const theirs = (
      env.db.raw
        .prepare('SELECT message_id AS id FROM shared_message WHERE account_id = ?')
        .all(bea) as { id: string }[]
    ).map((r) => r.id);
    expect(theirs).toHaveLength(1);
    await remove(bea);
    await purges.purge(ACCOUNT, bea);
    // Every message is still there, in order; only hers changed.
    const after = env.db.raw
      .prepare('SELECT id, role FROM message WHERE thread_id = ? ORDER BY created_at, id')
      .all(owners.id) as { id: string; role: string }[];
    expect(after).toEqual(before);
    const text = (id: string) =>
      (
        env.db.raw
          .prepare("SELECT group_concat(content, '') AS t FROM message_part WHERE message_id = ?")
          .get(id) as { t: string | null }
      ).t;
    expect(text(theirs[0]!)).toBe(REDACTED_MESSAGE_TEXT);
    expect(after.filter((m) => m.role === 'assistant').every((m) => text(m.id) !== null)).toBe(
      true,
    );
    expect(after.some((m) => text(m.id)?.includes('the owner answers'))).toBe(true);
    // Not findable, its file gone, and nobody is named as its author any more.
    // Her message is no longer found by search (what the assistant answered is the chat's own).
    expect(
      env.db.raw
        .prepare(
          "SELECT count(*) AS n FROM message_search WHERE message_id = ? AND text LIKE '%hello from bea%'",
        )
        .get(theirs[0]!),
    ).toEqual({ n: 0 });
    expect(
      env.db.raw
        .prepare('SELECT count(*) AS n FROM attachment WHERE message_id = ?')
        .get(theirs[0]!),
    ).toEqual({ n: 0 });
    expect(existsSync(join(dataDir, 'blobs/cc/bea-in-shared'))).toBe(false);
    expect(
      env.db.raw.prepare('SELECT count(*) AS n FROM shared_message WHERE account_id = ?').get(bea),
    ).toEqual({ n: 0 });
    expect((await purges.get(ACCOUNT, bea)).counts?.rows.redacted_messages).toBe(1);
  });
});

describe('the cleanup after the commit', () => {
  it('is recorded with the purge and finished by the next sweep when it is cut short', async () => {
    const { bea, provider } = await busyMember('Bea');
    await remove(bea);
    const ref = `secret://provider/${provider}/api_key`;
    // The vault fails once while the files are removed (a crash right after the commit).
    const del = env.secrets.delete.bind(env.secrets);
    let fail = true;
    env.secrets.delete = (r: string) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('vault unavailable'));
      }
      return del(r);
    };
    const view = await purges.purge(ACCOUNT, bea);
    expect(view).toMatchObject({ status: 'purged', cleanupPending: true, exportable: false });
    expect(accountRows(bea)).toEqual({});
    const pending = env.db.raw
      .prepare('SELECT status, cleanup_json FROM member_purge WHERE account_id = ?')
      .get(bea) as { status: string; cleanup_json: string };
    expect(pending.status).toBe('cleaning');
    expect(JSON.parse(pending.cleanup_json)).toMatchObject({
      secrets: [ref],
      folders: expect.arrayContaining([join(dataDir, 'members', bea, 'workspace', '..')]),
    });
    expect(await env.secrets.get(ref)).toBe('bea-key');
    // A grace of 0 does not stop finishing what a purge left.
    days = 0;
    await purges.sweep();
    expect(await env.secrets.get(ref)).toBeNull();
    expect(existsSync(join(dataDir, 'members', bea))).toBe(false);
    expect(await purges.get(ACCOUNT, bea)).toMatchObject({
      status: 'purged',
      cleanupPending: false,
      counts: { secrets: 1 },
    });
    // Once finished, a second purge is a conflict.
    await expect(purges.purge(ACCOUNT, bea)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('is finished by a purge request on a record left cleaning', async () => {
    const { bea, provider } = await busyMember('Bea');
    await remove(bea);
    const del = env.secrets.delete.bind(env.secrets);
    let fail = true;
    env.secrets.delete = (r: string) => {
      if (!fail) return del(r);
      fail = false;
      return Promise.reject(new Error('vault unavailable'));
    };
    expect((await purges.purge(ACCOUNT, bea)).cleanupPending).toBe(true);
    const done = await purges.purge(ACCOUNT, bea);
    expect(done).toMatchObject({ status: 'purged', cleanupPending: false });
    expect(await env.secrets.get(`secret://provider/${provider}/api_key`)).toBeNull();
    // Audited once: the purge itself, not its cleanup.
    expect(audit.filter((a) => a.action === 'team.member.purge')).toHaveLength(1);
  });
});
