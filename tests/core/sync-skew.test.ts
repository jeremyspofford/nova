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
  assert.deepEqual(ADDED_COLUMNS[21], { problem: ['stops'] });
  assert.deepEqual(ADDED_COLUMNS[22], { capture_event: ['sensitivity', 'sensitivity_why', 'sensitivity_decision', 'sensitivity_detail', 'sensitivity_at', 'sensitivity_tries', 'sensitivity_next'] });
  assert.ok(newest >= 22);
  // Every column a replicated table has on the newest schema is either in the oldest supported
  // schema or registered: a release can't add one and forget to say so.
  const old = new Db(':memory:'); old.migrate({ migrations: upTo(UNSTATED_SCHEMA - 1) });
  const now = new Db(':memory:'); now.migrate({ migrations: all });
  const cols = (db: Db, t: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
  for (const t of ['device', 'receipt', 'task', 'memory', 'profile', 'capture_source', 'capture_event', 'change_record', 'problem']) {
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

test('a 0021 standby against a 0022 hub: the hub leaves out capture_event’s screening columns for it; a 0022 standby gets them', () => {
  const { hub, sync: hubSync } = hubBatch();
  hub.run(`INSERT INTO capture_event (id, source_id, device_id, adapter, kind, at, received_at, app, text, via, consent_at, sensitivity, sensitivity_why, sensitivity_decision, sensitivity_detail, sensitivity_at)
    VALUES ('e1', 'screenpipe:hub', 'hub', 'screenpipe', 'screen', ?, ?, 'Notes', 'kept words', 'pull', ?, 'hold', 'a reason', 'dec-1', '{}', ?)`, at, at, at, at);
  const cols = ['sensitivity', 'sensitivity_why', 'sensitivity_decision', 'sensitivity_detail', 'sensitivity_at', 'sensitivity_tries', 'sensitivity_next'];
  const old = standby(21);
  const now = standby(22);
  try {
    const behind = hubSync.batch(0, { peerSchema: 21 });
    const row = JSON.parse(behind.rows.find((r) => r.tbl === 'capture_event' && r.op === 'put')!.row!);
    for (const c of cols) assert.equal(Object.hasOwn(row, c), false, `${c} left out by the hub`);
    old.sync.apply(behind, () => {});
    assert.equal(old.db.get<{ text: string }>(`SELECT text FROM capture_event WHERE id = 'e1'`)?.text, 'kept words');
    now.sync.apply(hubSync.batch(0, { peerSchema: 22 }), () => {});
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

// A table a release added (0023, 0024 and the coming 0025 each add one). A standby a release behind
// doesn't have it: it must keep copying everything else, hold that table's entries without losing
// any, and apply them once it is updated. 0024's console_passkey stands for a table this code knows
// but the standby's schema lacks; `future_table` for one this code doesn't know at all (0025's).
function hubWithNewTables() {
  const { hub, sync } = hubBatch();
  const key = (id: string, name: string) => hub.run(`INSERT INTO console_passkey (id, name, public_key, rp_id, origins, sign_count, created_at) VALUES (?, ?, 'pk', 'nova.local', '[]', 0, ?)`, id, name, at);
  key('k1', 'Laptop');
  key('k2', 'Old phone');
  // A forget of a row in the new table: the delete must win when the standby catches up.
  hub.run(`DELETE FROM console_passkey WHERE id = 'k2'`);
  hub.run(`INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('future_table', 'f1', 'put', '{"id":"f1","what":"from 0025"}', 'placeholder')`);
  hub.run(`INSERT INTO profile (section, key, value, source, updated_at) VALUES ('user', 'timezone', '"UTC"', 'setup', ?)`, at);
  return { hub, sync, key };
}

test('a 0023 standby against a hub with new tables: it applies the rest, keeps its position, and holds the new tables’ entries', () => {
  const { hub, sync: hubSync, key } = hubWithNewTables();
  const s = standby(23);
  try {
    const first = hubSync.batch(0, { peerSchema: 23 });
    assert.ok(first.rows.some((r) => r.tbl === 'console_passkey'), 'the batch mixes in entries for a table the standby lacks');
    assert.ok(first.rows.some((r) => r.tbl === 'future_table'));
    s.sync.apply(first, () => {});
    // Everything it understands landed, and its cursor is where the hub said it may be.
    assert.equal(s.db.get<{ value: string }>(`SELECT value FROM profile WHERE section = 'user' AND key = 'name'`)?.value, '"Sam"');
    assert.equal(s.db.get<{ value: string }>(`SELECT value FROM profile WHERE section = 'user' AND key = 'timezone'`)?.value, '"UTC"', 'entries after the unknown ones land too');
    assert.equal(s.db.get<{ name: string }>(`SELECT name FROM device WHERE id = 'c'`)?.name, 'Desk');
    assert.equal(s.sync.cursor(), first.upto);
    // It keeps copying: the next batch lands as well.
    hub.run(`UPDATE profile SET value = '"Alex"' WHERE section = 'user' AND key = 'name'`);
    key('k3', 'Desk key');
    const second = hubSync.batch(s.sync.cursor(), { peerSchema: 23 });
    s.sync.apply(second, () => {});
    assert.equal(s.db.get<{ value: string }>(`SELECT value FROM profile WHERE section = 'user' AND key = 'name'`)?.value, '"Alex"');
    assert.equal(s.sync.cursor(), hubSync.head());
    // The person is told once that this standby is behind.
    const said = s.db.all<{ message: string }>(`SELECT message FROM problem WHERE message LIKE '%console_passkey%'`);
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.match(said[0]!.message, /release behind/);
    // Promoted while still behind, it serves the held entries on under their own names, so nothing
    // the old hub had is lost to the next standby.
    const served = s.sync.batch(0, { peerSchema: 24 });
    assert.deepEqual(served.rows.filter((r) => r.tbl === 'console_passkey').map((r) => [r.pk, r.op]).sort(), [['k1', 'put'], ['k2', 'delete'], ['k3', 'put']]);
    assert.ok(served.rows.some((r) => r.tbl === 'future_table'));
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('once the standby is updated, the entries it held are applied in order, forgets included, without the hub sending them again', () => {
  const { hub, sync: hubSync } = hubWithNewTables();
  const s = standby(23);
  try {
    s.sync.apply(hubSync.batch(0, { peerSchema: 23 }), () => {});
    const cursor = s.sync.cursor();
    // The update: the migration adds the table, and Nova starts again.
    s.db.migrate({ migrations: all });
    const restarted = new SyncLog({ db: s.db, log: s.log, home: s.home, node: 'standby', now: () => new Date(at) });
    restarted.replayHeld();
    assert.deepEqual(s.db.all<{ id: string }>(`SELECT id FROM console_passkey ORDER BY id`).map((r) => r.id), ['k1'], 'k1 is there; the forgotten k2 is not');
    assert.equal(restarted.cursor(), cursor, 'its position is unchanged');
    // Applied once: the entries are kept as ordinary ones now, with the hub's seq.
    assert.equal(s.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_log WHERE tbl = 'console_passkey'`)!.n, 2);
    // A table this release still doesn't know stays held.
    assert.ok(restarted.batch(0, { peerSchema: 24 }).rows.some((r) => r.tbl === 'future_table'));
    // A newer change from the hub after the update replaces the replayed one, as any entry would.
    hub.run(`UPDATE console_passkey SET name = 'Work laptop' WHERE id = 'k1'`);
    restarted.apply(hubSync.batch(cursor, { peerSchema: 24 }), () => {});
    assert.equal(s.db.get<{ name: string }>(`SELECT name FROM console_passkey WHERE id = 'k1'`)?.name, 'Work laptop');
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('a standby promoted while behind, then updated: the held changes land and its own log carries them on, the forget included', () => {
  const { sync: hubSync } = hubWithNewTables();
  const s = standby(23);
  try {
    s.sync.apply(hubSync.batch(0, { peerSchema: 23 }), () => {});
    s.sync.setLogging(true);
    s.db.migrate({ migrations: all });
    const restarted = new SyncLog({ db: s.db, log: s.log, home: s.home, node: 'standby', now: () => new Date(at) });
    restarted.replayHeld();
    assert.deepEqual(s.db.all<{ id: string }>(`SELECT id FROM console_passkey`).map((r) => r.id), ['k1']);
    const served = restarted.batch(0, { peerSchema: 24 }).rows.filter((r) => r.tbl === 'console_passkey').map((r) => [r.pk, r.op]).sort();
    assert.deepEqual(served, [['k1', 'put'], ['k2', 'delete']]);
    assert.equal(s.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_log WHERE tbl = 'held:console_passkey'`)!.n, 0);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('a held entry is still checked: a malformed one, or one naming a table that isn’t a name, refuses the batch as before', () => {
  const s = standby(23);
  try {
    const row = { seq: 1, tbl: 'console_passkey', pk: 'k1', op: 'put' as const, row: '{"id":"k1"}', hlc: 'h' };
    assert.throws(() => s.sync.apply({ rows: [{ ...row, tbl: 'x"; DROP TABLE profile; --' }], upto: 1 }, () => {}), /can’t apply/);
    assert.throws(() => s.sync.apply({ rows: [{ ...row, op: 'file_put' }], upto: 1 }, () => {}), /can’t apply/);
    assert.throws(() => s.sync.apply({ rows: [{ ...row, row: '{"id":{"nested":1}}' }], upto: 1 }, () => {}), /can’t apply/);
    assert.throws(() => s.sync.apply({ rows: [{ ...row, row: '[1]' }], upto: 1 }, () => {}), /can’t apply/);
    assert.equal(s.sync.cursor(), 0, 'a refused batch moves nothing');
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

// The orb's red (owner decision 2026-10-31): problem.stops, added by 0021. A 0020 standby has no such
// column; it takes the problem without it, and shows it amber, as every problem was before.
function hubWithProblem() {
  const { hub, sync } = hubBatch();
  const log = new Log(hub, null);
  log.problem('ledger', 'A task failed: Backup now.', { stops: true });
  return { hub, sync };
}

test('a 0020 standby against a 0021 hub: the hub leaves out problem.stops for it, and the problem lands', () => {
  const { sync: hubSync } = hubWithProblem();
  const s = standby(20);
  try {
    const batch = hubSync.batch(0, { peerSchema: 20 });
    const p = JSON.parse(batch.rows.find((r) => r.tbl === 'problem' && r.op === 'put')!.row!);
    assert.equal(Object.hasOwn(p, 'stops'), false, 'left out by the hub');
    assert.deepEqual(JSON.parse(hubSync.batch(0, { peerSchema: 21 }).rows.find((r) => r.tbl === 'problem' && r.op === 'put')!.row!).stops, 1, 'a 0021 standby gets it');
    s.sync.apply(batch, () => {});
    assert.equal(s.db.get<{ message: string }>(`SELECT message FROM problem WHERE source = 'ledger'`)?.message, 'A task failed: Backup now.');
    assert.equal(s.db.get<{ purposes: string }>(`SELECT purposes FROM device WHERE id = 'c'`)?.purposes, '["compute"]', 'the 0020 column still arrives');
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('a 0021 standby keeps problem.stops: the problem that stops Nova is red there too', () => {
  const { sync: hubSync } = hubWithProblem();
  const s = standby(21);
  try {
    s.sync.apply(hubSync.batch(0, { peerSchema: 21 }), () => {});
    assert.equal(s.db.get<{ stops: number }>(`SELECT stops FROM problem WHERE source = 'ledger'`)?.stops, 1);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('a hub that didn’t adapt to a 0020 standby: it leaves problem.stops out, says once it is behind, and the problem lands', () => {
  const { sync: hubSync } = hubWithProblem();
  const s = standby(20);
  // A standby's own problems take ids below zero, so the hub's (copied as they are) never replace them.
  s.log.local = () => true;
  try {
    s.sync.apply(hubSync.batch(0, { peerSchema: 21 }), () => {});
    assert.equal(s.db.get<{ message: string }>(`SELECT message FROM problem WHERE source = 'ledger'`)?.message, 'A task failed: Backup now.');
    const said = s.db.all<{ message: string }>(`SELECT message FROM problem WHERE message LIKE '%problem.stops%'`);
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.match(said[0]!.message, /release behind/);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});
