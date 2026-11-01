// A standby one release behind (M10f review, finding 3): one mechanism for every column a release
// adds to a replicated table (`ADDED_COLUMNS` in mesh/sync.ts). The hub leaves out the columns its
// standby's schema doesn't have (the standby says its schema when it pulls); a standby that gets one
// anyway (a hub that didn't adapt) leaves it out and says once that it is behind. #258's
// receipt.opt_in and M10f's device.purposes both go through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, loadMigrations } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { ADDED_COLUMNS, SyncLog, UNSTATED_SCHEMA } from '../../src/core/mesh/sync.ts';

const at = '2026-10-01T00:00:00.000Z';
const all = loadMigrations();
const upTo = (v: number) => all.filter((m) => m.version <= v);

// A hub on the newest schema, logging, with a computer that has roles, a receipt with an opt-in, and
// a profile row: one batch with all three.
function hubBatch() {
  const hub = new Db(':memory:');
  hub.migrate({ migrations: all });
  hub.run('UPDATE sync_state SET logging = 1 WHERE id = 1');
  hub.run(`INSERT INTO device (id, name, platform, kind, role, public_key, x25519_public_key, fingerprint, capabilities, purposes, trust, can_approve, created_at) VALUES ('c', 'Desk', 'linux x64', 'computer', 'spoke', 'pk', 'xk', 'fp', '[]', '["compute"]', 'trusted', 0, ?)`, at);
  hub.run(`INSERT INTO receipt (id, at, provider, model, purpose, privacy_mode, egress, opt_in, context_items) VALUES ('r1', ?, 'jev', 'example', 'screening', 'local-only', 'remote', 'screening', '[]')`, at);
  hub.run(`INSERT INTO profile (section, key, value, source, updated_at) VALUES ('user', 'name', '"Sam"', 'setup', ?)`, at);
  return { hub, sync: new SyncLog({ db: hub, log: new Log(hub, null), home: mkdtempSync(join(tmpdir(), 'nova-skew-hub-')), node: 'hub', now: () => new Date(at) }) };
}

function standby(version: number) {
  const db = new Db(':memory:');
  db.migrate({ migrations: upTo(version) });
  // A standby copies; it doesn't log its own writes.
  db.run('UPDATE sync_state SET logging = 0 WHERE id = 1');
  const home = mkdtempSync(join(tmpdir(), 'nova-skew-'));
  const log = new Log(db, null);
  return { db, home, log, sync: new SyncLog({ db, log, home, node: 'standby', now: () => new Date(at) }) };
}

test('the registry names every column a release added to a replicated table, the newest included', () => {
  const newest = Math.max(...all.map((m) => m.version));
  assert.deepEqual(ADDED_COLUMNS[19], { receipt: ['opt_in'] });
  assert.deepEqual(ADDED_COLUMNS[20], { device: ['purposes'] });
  assert.deepEqual(ADDED_COLUMNS[21], { capture_event: ['sensitivity', 'sensitivity_why', 'sensitivity_decision', 'sensitivity_detail', 'sensitivity_at'] });
  assert.ok(newest >= 21);
  // Every column a replicated table has on the newest schema is either in the oldest supported
  // schema or registered: a release can't add one and forget to say so.
  const old = new Db(':memory:'); old.migrate({ migrations: upTo(UNSTATED_SCHEMA - 1) });
  const now = new Db(':memory:'); now.migrate({ migrations: all });
  const cols = (db: Db, t: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
  for (const t of ['device', 'receipt', 'task', 'memory', 'profile', 'capture_source', 'capture_event', 'change_record']) {
    const added = cols(now, t).filter((c) => !cols(old, t).includes(c));
    const said = Object.values(ADDED_COLUMNS).flatMap((m) => m[t] ?? []);
    assert.deepEqual(added.sort(), [...said].sort(), t);
  }
});

test('a 0019 standby against a 0020 hub: the hub leaves out device.purposes for it, and the whole batch lands', () => {
  const { sync: hubSync } = hubBatch();
  const s = standby(19);
  try {
    const batch = hubSync.batch(0, { peerSchema: 19 });
    const device = batch.rows.find((r) => r.tbl === 'device' && r.op === 'put')!;
    assert.equal(Object.hasOwn(JSON.parse(device.row!), 'purposes'), false, 'left out by the hub');
    assert.equal(JSON.parse(batch.rows.find((r) => r.tbl === 'receipt')!.row!).opt_in, 'screening', 'a 0019 standby has opt_in, so it gets it');
    s.sync.apply(batch, () => {});
    assert.equal(s.db.get<{ value: string }>(`SELECT value FROM profile WHERE section = 'user' AND key = 'name'`)?.value, '"Sam"');
    assert.equal(s.db.get<{ name: string }>(`SELECT name FROM device WHERE id = 'c'`)?.name, 'Desk');
    assert.equal(s.db.get<{ opt_in: string }>(`SELECT opt_in FROM receipt WHERE id = 'r1'`)?.opt_in, 'screening');
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('a standby that doesn’t say its schema is taken to be on 19 (code from before this); an 0018 standby gets neither new column', () => {
  const { sync: hubSync } = hubBatch();
  const unstated = hubSync.batch(0, {});
  const put = (t: string) => JSON.parse(unstated.rows.find((x) => x.op === 'put' && x.tbl === t)!.row!);
  assert.equal(Object.hasOwn(put('device'), 'purposes'), false);
  assert.equal(put('receipt').opt_in, 'screening');
  const eighteen = hubSync.batch(0, { peerSchema: 18 });
  assert.equal(Object.hasOwn(JSON.parse(eighteen.rows.find((x) => x.op === 'put' && x.tbl === 'receipt')!.row!), 'opt_in'), false);
  const s = standby(18);
  try {
    s.sync.apply(hubSync.batch(0, { peerSchema: 18 }), () => {});
    assert.equal(s.db.get<{ id: string }>(`SELECT id FROM receipt WHERE id = 'r1'`)?.id, 'r1');
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('a hub that didn’t adapt: the standby leaves the column out, says once it is behind, and the rest of the batch lands', () => {
  const { hub, sync: hubSync } = hubBatch();
  const s = standby(19);
  try {
    const first = hubSync.batch(0, { peerSchema: 20 });
    s.sync.apply(first, () => {});
    assert.equal(s.db.get<{ name: string }>(`SELECT name FROM device WHERE id = 'c'`)?.name, 'Desk');
    hub.run(`UPDATE device SET last_seen = ? WHERE id = 'c'`, at);
    s.sync.apply(hubSync.batch(first.upto, { peerSchema: 20 }), () => {});
    assert.equal(s.db.get<{ last_seen: string }>(`SELECT last_seen FROM device WHERE id = 'c'`)?.last_seen, at);
    const said = s.db.all<{ message: string }>(`SELECT message FROM problem WHERE message LIKE '%device.purposes%'`);
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.match(said[0]!.message, /release behind/);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('a 0020 standby against a 0021 hub: the hub leaves out capture_event’s screening columns for it; a 0021 standby gets them', () => {
  const { hub, sync: hubSync } = hubBatch();
  hub.run(`INSERT INTO capture_event (id, source_id, device_id, adapter, kind, at, received_at, app, text, via, consent_at, sensitivity, sensitivity_why, sensitivity_decision, sensitivity_detail, sensitivity_at)
    VALUES ('e1', 'screenpipe:hub', 'hub', 'screenpipe', 'screen', ?, ?, 'Notes', 'kept words', 'pull', ?, 'hold', 'a reason', 'dec-1', '{}', ?)`, at, at, at, at);
  const cols = ['sensitivity', 'sensitivity_why', 'sensitivity_decision', 'sensitivity_detail', 'sensitivity_at'];
  const old = standby(20);
  const now = standby(21);
  try {
    const behind = hubSync.batch(0, { peerSchema: 20 });
    const row = JSON.parse(behind.rows.find((r) => r.tbl === 'capture_event' && r.op === 'put')!.row!);
    for (const c of cols) assert.equal(Object.hasOwn(row, c), false, `${c} left out by the hub`);
    old.sync.apply(behind, () => {});
    assert.equal(old.db.get<{ text: string }>(`SELECT text FROM capture_event WHERE id = 'e1'`)?.text, 'kept words');
    now.sync.apply(hubSync.batch(0, { peerSchema: 21 }), () => {});
    assert.deepEqual({ ...now.db.get<Record<string, unknown>>(`SELECT sensitivity, sensitivity_why, sensitivity_decision FROM capture_event WHERE id = 'e1'`) }, { sensitivity: 'hold', sensitivity_why: 'a reason', sensitivity_decision: 'dec-1' });
  } finally { rmSync(old.home, { recursive: true, force: true }); rmSync(now.home, { recursive: true, force: true }); }
});

test('the receipt’s triggers carry opt_in always now: the sender adapts, not the trigger', () => {
  const { hub } = hubBatch();
  hub.run(`INSERT INTO receipt (id, at, provider, model, purpose, privacy_mode, egress, context_items) VALUES ('r2', ?, 'ollama', 'example', 'chat', 'local-only', 'local', '[]')`, at);
  const row = JSON.parse(hub.get<{ row: string }>(`SELECT row FROM sync_log WHERE tbl = 'receipt' AND pk = 'r2'`)!.row);
  assert.equal(Object.hasOwn(row, 'opt_in'), true);
  assert.equal(row.opt_in, null);
});
