// Retention sweeps (FR-105, ADR-097 D5): each item prunes only once its days are set, never a pinned
// item, never audit entries younger than the 365-day floor; a pruned audit chain still verifies
// from its anchor, and tampering after the anchor is still caught.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RetentionItem } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  AuditLog,
  RetentionService,
  auditAnchor,
  verifyAuditChain,
  type AuditRecord,
} from '../src/index.ts';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const DAY = 86_400_000;
const NOW = new Date('2027-06-01T00:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let dir: string;
let db: NovaDatabase;
let days: Partial<Record<RetentionItem, number | null>>;
let audited: AuditRecord[];
let svc: RetentionService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-ret-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(OWNER, ago(900), ago(900));
  days = {};
  audited = [];
  svc = new RetentionService({
    db,
    dataDir: dir,
    days: (item) => Promise.resolve(days[item] ?? null),
    audit: { append: (r) => Promise.resolve(void audited.push(r)) },
    ownerAccountId: () => OWNER,
    now: () => NOW,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function thread(
  id: string,
  updated: string,
  opts: { pinned?: boolean; parent?: string; deleted?: string } = {},
) {
  db.raw
    .prepare(
      `INSERT INTO thread (id, account_id, mode, parent_thread_id, pinned, created_at, updated_at, deleted_at)
       VALUES (?, ?, 'chat', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      OWNER,
      opts.parent ?? null,
      opts.pinned ? 1 : 0,
      updated,
      updated,
      opts.deleted ?? null,
    );
  db.raw
    .prepare(
      "INSERT INTO message (id, thread_id, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)",
    )
    .run(`${id}-m`, id, updated, updated);
}

const ids = (sql: string) => (db.raw.prepare(sql).all() as { id: string }[]).map((r) => r.id);

describe('retention', () => {
  it('prunes nothing while every item keeps everything', async () => {
    thread('t-old', ago(400));
    const view = await svc.view();
    expect(view.items.map((i) => [i.item, i.days, i.due])).toEqual([
      ['threads', null, 0],
      ['runs', null, 0],
      ['audit', null, 0],
      ['artifacts', null, 0],
      ['traces', null, 0],
    ]);
    expect(view.items.find((i) => i.item === 'audit')!.floorDays).toBe(365);
    const r = await svc.sweep('manual');
    expect(r.removed).toEqual({});
    expect(ids('SELECT id FROM thread WHERE deleted_at IS NULL')).toEqual(['t-old']);
    expect(svc.lastSweep()).toMatchObject({ id: r.id, trigger: 'manual' });
  });

  it('deletes stale chats (not pinned ones), then purges them after 30 days', async () => {
    thread('t-old', ago(100));
    thread('t-pinned', ago(100), { pinned: true });
    thread('t-new', ago(5));
    // A family with a recent branch is not stale.
    thread('t-root', ago(100));
    thread('t-branch', ago(1), { parent: 't-root' });
    thread('t-gone', ago(200), { deleted: ago(45) });
    days.threads = 30;
    expect((await svc.view()).items[0]!.due).toBe(2);
    const r = await svc.sweep('manual');
    expect(r.removed.threads).toBe(2);
    expect(ids('SELECT id FROM thread WHERE deleted_at IS NULL ORDER BY id')).toEqual([
      't-branch',
      't-new',
      't-pinned',
      't-root',
    ]);
    expect(ids("SELECT id FROM thread WHERE id = 't-gone'")).toEqual([]);
    expect(ids("SELECT id FROM thread WHERE id = 't-old'")).toEqual(['t-old']);
    expect(db.raw.prepare("SELECT deleted_at FROM message WHERE id = 't-old-m'").get()).toEqual({
      deleted_at: NOW.toISOString(),
    });
  });

  it('purges ended runs with their threads and steps, keeping active and pinned ones', async () => {
    const run = (id: string, status: string, ended: string | null, pinned = false) => {
      thread(`${id}-thread`, ended ?? ago(1), { pinned });
      db.raw.prepare("UPDATE thread SET mode = 'work' WHERE id = ?").run(`${id}-thread`);
      db.raw
        .prepare(
          `INSERT INTO run (id, account_id, thread_id, title, objective, status, pause_reason, created_at, updated_at, ended_at)
           VALUES (?, ?, ?, 't', 'o', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          OWNER,
          `${id}-thread`,
          status,
          status === 'paused' ? 'user' : null,
          ago(300),
          ended ?? ago(1),
          ended,
        );
      db.raw
        .prepare(
          "INSERT INTO run_step (id, run_id, idx, title, status) VALUES (?, ?, 0, 's', 'done')",
        )
        .run(`${id}-s`, id);
    };
    run('r-old', 'done', ago(100));
    run('r-pinned', 'done', ago(100), true);
    run('r-active', 'paused', null);
    run('r-recent', 'failed', ago(2));
    days.runs = 30;
    const r = await svc.sweep('manual');
    expect(r.removed.runs).toBe(1);
    expect(ids('SELECT id FROM run ORDER BY id')).toEqual(['r-active', 'r-pinned', 'r-recent']);
    expect(ids("SELECT id FROM thread WHERE id = 'r-old-thread'")).toEqual([]);
    expect(ids("SELECT id FROM run_step WHERE run_id = 'r-old'")).toEqual([]);
  });

  it('prunes audit entries past the days but never under the floor; the chain still verifies', async () => {
    let clock = new Date(ago(800));
    const audit = new AuditLog({ db, now: () => clock });
    for (const d of [800, 700, 500, 300, 10]) {
      clock = new Date(ago(d));
      await audit.append({ accountId: OWNER, actor: 'user', kind: 'settings', action: `a${d}` });
    }
    clock = NOW;
    // The prune writes its entry into the chain it pruned, in the same transaction.
    const real = new RetentionService({
      db,
      dataDir: dir,
      days: (item) => Promise.resolve(item === 'audit' ? 100 : null),
      audit,
      ownerAccountId: () => OWNER,
      now: () => NOW,
    });
    // 100 days is below the floor: 365 applies.
    expect((await real.view()).items.find((i) => i.item === 'audit')).toMatchObject({
      days: 365,
      due: 3,
    });
    const r = await real.sweep('manual');
    expect(r.removed.audit).toBe(3);
    const rows = db.raw
      .prepare('SELECT action, input_hash, detail_json FROM audit_event ORDER BY seq')
      .all() as { action: string; input_hash: string | null; detail_json: string }[];
    expect(rows.map((x) => x.action)).toEqual(['a300', 'a10', 'data.retention.audit_pruned']);
    const anchor = auditAnchor(db.raw)!;
    expect(anchor).toMatchObject({ seq: 3 });
    expect(rows[2]!.input_hash).toBe(anchor.hash);
    expect(JSON.parse(rows[2]!.detail_json)).toMatchObject({ removed: 3, anchorSeq: 3 });
    expect(verifyAuditChain(db.raw)).toEqual({ ok: true, checked: 3, brokenAt: null });
    // Editing a kept entry is still caught, and so is a forged anchor.
    db.raw.exec('DROP TRIGGER audit_event_no_update');
    db.raw.prepare("UPDATE audit_event SET action = 'forged' WHERE action = 'a10'").run();
    expect(verifyAuditChain(db.raw).ok).toBe(false);
    db.raw.prepare("UPDATE audit_event SET action = 'a10' WHERE action = 'forged'").run();
    expect(verifyAuditChain(db.raw).ok).toBe(true);
    db.raw.prepare("UPDATE audit_anchor SET hash = 'x'").run();
    expect(verifyAuditChain(db.raw).ok).toBe(false);
  });

  it('refuses an anchor no prune entry vouches for (the head of the log dropped by hand)', async () => {
    const audit = new AuditLog({ db });
    for (const a of ['one', 'two', 'three'])
      await audit.append({ accountId: OWNER, actor: 'user', kind: 'settings', action: a });
    const head = db.raw.prepare('SELECT seq, hash FROM audit_event WHERE seq = 1').get() as {
      seq: number;
      hash: string;
    };
    // An attacker with the database drops the first entry and writes a matching anchor.
    db.raw.exec('DROP TRIGGER audit_event_no_delete');
    db.raw.prepare('DELETE FROM audit_event WHERE seq = 1').run();
    db.raw
      .prepare("INSERT INTO audit_anchor (id, seq, hash, pruned_at) VALUES (1, ?, ?, 'x')")
      .run(head.seq, head.hash);
    expect(verifyAuditChain(db.raw)).toMatchObject({ ok: false, checked: 0 });
  });

  it('prunes nothing without an audit sink (the anchor would have no entry)', async () => {
    const audit = new AuditLog({ db, now: () => new Date(ago(800)) });
    await audit.append({ accountId: OWNER, actor: 'user', kind: 'settings', action: 'old' });
    const bare = new RetentionService({
      db,
      dataDir: dir,
      days: (item) => Promise.resolve(item === 'audit' ? 365 : null),
      now: () => NOW,
    });
    const r = await bare.sweep('manual');
    expect(r).toMatchObject({ removed: { audit: 0 }, skipped: { audit: 1 } });
    expect(db.raw.prepare('SELECT count(*) AS n FROM audit_event').get()).toEqual({ n: 1 });
  });

  it('prunes old artifacts and traces, keeping live and pinned ones', async () => {
    thread('t-pinned', ago(1), { pinned: true });
    const art = (id: string, updated: string, threadId: string | null, live = 0) =>
      db.raw
        .prepare(
          "INSERT INTO artifact (id, account_id, thread_id, kind, live, created_at, updated_at) VALUES (?, ?, ?, 'markdown', ?, ?, ?)",
        )
        .run(id, OWNER, threadId, live, updated, updated);
    art('a-old', ago(90), null);
    art('a-live', ago(90), null, 1);
    art('a-pinned', ago(90), 't-pinned');
    art('a-new', ago(1), null);
    const ev = (id: string, ts: string) =>
      db.raw
        .prepare(
          "INSERT INTO event (id, name, schema_version, ts, actor, payload_json) VALUES (?, 'x', 1, ?, 'system', '{}')",
        )
        .run(id, ts);
    ev('e-old', ago(40));
    ev('e-new', ago(2));
    days.artifacts = 30;
    days.traces = 14;
    const r = await svc.sweep('manual');
    expect(r.removed).toMatchObject({ artifacts: 1, traces: 1 });
    expect(ids('SELECT id FROM artifact ORDER BY id')).toEqual(['a-live', 'a-new', 'a-pinned']);
    expect(ids('SELECT id FROM event ORDER BY id')).toEqual(['e-new']);
  });

  it('runs the scheduled sweep once a day', async () => {
    expect(svc.isDue()).toBe(true);
    await svc.sweep('schedule');
    expect(svc.isDue()).toBe(false);
    const later = new RetentionService({
      db,
      dataDir: dir,
      days: () => Promise.resolve(null),
      now: () => new Date(NOW.getTime() + DAY),
    });
    expect(later.isDue()).toBe(true);
    expect((await later.view()).nextSweepAt).toBe(new Date(NOW.getTime() + DAY).toISOString());
  });
});
