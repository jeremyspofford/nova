import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, UPGRADE_FAILED, UpgradeError, loadMigrations, restoreBackup, type Migration } from '../../src/core/db.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'nova-db-'));
const mig = (version: number, sql: string): Migration => ({ version, name: `m${version}`, sql, checksum: `c${version}:${sql}` });

test('the shipped migrations load in order and apply to an empty database', () => {
  const ms = loadMigrations();
  assert.ok(ms.length >= 1);
  assert.deepEqual(ms.map((m) => m.version), ms.map((_, i) => i + 1));
  const db = new Db(':memory:');
  const r = db.migrate();
  assert.equal(r.from, 0);
  assert.equal(r.to, ms.length);
  assert.equal(db.version(), ms.length);
  for (const table of ['profile', 'task', 'task_event', 'extension', 'problem']) {
    assert.ok(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table), `${table} exists`);
  }
  assert.deepEqual(db.migrate().applied, [], 'a second run applies nothing');
});

test('a gap in migration numbers is refused', () => {
  const dir = tmp();
  writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
  writeFileSync(join(dir, '0003_c.sql'), 'SELECT 1;');
  assert.throws(() => loadMigrations(dir), /without gaps/);
});

test('an edited migration is refused, and so is a database newer than the build', () => {
  const db = new Db(':memory:');
  db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)')] });
  assert.throws(() => db.migrate({ migrations: [{ ...mig(1, 'CREATE TABLE a (x)'), checksum: 'other' }] }), /edited after it was applied/);
  db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)'), mig(2, 'CREATE TABLE b (x)')] });
  assert.throws(() => db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)')] }), /newer than this version/);
});

test('upgrading a file database backs it up first, and the backup restores', () => {
  const dir = tmp();
  const path = join(dir, 'nova.db');
  const backups = join(dir, 'backups');
  let db = new Db(path);
  db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)')] });
  db.run('INSERT INTO a VALUES (?)', 'before');
  assert.throws(() => db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)'), mig(2, 'CREATE TABLE b (x)')] }), /backup folder is required/);
  const r = db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)'), mig(2, 'CREATE TABLE b (x)')], backupDir: backups });
  assert.ok(r.backup && existsSync(r.backup));
  db.run('INSERT INTO a VALUES (?)', 'after');
  db.close();
  restoreBackup(path, r.backup);
  db = new Db(path);
  assert.deepEqual(db.all<{ x: string }>('SELECT x FROM a').map((row) => row.x), ['before']);
  assert.equal(db.version(), 1);
  db.close();
});

test('an upgrade that fails at a later step leaves the database as it was, says so plainly, and adds no copy when tried again (F-020)', () => {
  const dir = tmp();
  const path = join(dir, 'nova.db');
  const backups = join(dir, 'backups');
  const one = mig(1, 'CREATE TABLE a (x)');
  const steps = [one, mig(2, 'CREATE TABLE b (x)'), mig(3, 'INSERT INTO nowhere VALUES (1)')];
  let db = new Db(path);
  db.migrate({ migrations: [one] });
  db.run('INSERT INTO a VALUES (?)', 'kept');
  let checkpoints = 0;
  const before = () => { checkpoints++; };
  let t = Date.parse('2026-11-10T00:00:00Z');
  const clock = () => new Date(t += 1000);
  const tables = () => db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'b')`).map((r) => r.name);

  assert.throws(() => db.migrate({ migrations: steps, backupDir: backups, before, now: clock }), (e: Error) => {
    assert.ok(e instanceof UpgradeError);
    assert.match(e.message, /from version 1 to 3: migration 3 \(m3\) failed: no such table: nowhere\. Nothing was changed/);
    assert.match(e.message, /a copy of it is at .*-v1\.db/);
    return true;
  });
  assert.equal(db.version(), 1, 'migration 2 is undone with 3');
  assert.deepEqual(tables(), ['a']);
  assert.deepEqual(db.all<{ x: string }>('SELECT x FROM a').map((r) => r.x), ['kept']);
  const copies = () => readdirSync(backups).filter((f) => f.endsWith('.db'));
  assert.equal(copies().length, 1);
  assert.equal(checkpoints, 1);
  db.close();

  // The next start tries again on the same database: the same copy, no new checkpoint.
  db = new Db(path);
  assert.throws(() => db.migrate({ migrations: steps, backupDir: backups, before, now: clock }), UpgradeError);
  assert.equal(copies().length, 1, 'no second copy');
  assert.equal(checkpoints, 1, 'no second checkpoint');

  // Something written since (the older version ran in between): a new copy, since the old one is stale.
  db.run('INSERT INTO a VALUES (?)', 'later');
  assert.throws(() => db.migrate({ migrations: steps, backupDir: backups, before, now: clock }), UpgradeError);
  assert.equal(copies().length, 2);
  assert.equal(checkpoints, 2);

  // A release with the step fixed upgrades, and the record of the failure goes.
  const r = db.migrate({ migrations: [...steps.slice(0, 2), mig(3, 'CREATE TABLE c (x)')], backupDir: backups, before, now: clock });
  assert.deepEqual(r.applied, [2, 3]);
  assert.equal(existsSync(join(backups, UPGRADE_FAILED)), false);
  db.close();
});

test('a database newer than this Nova is refused as an UpgradeError', () => {
  const db = new Db(':memory:');
  db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)'), mig(2, 'CREATE TABLE b (x)')] });
  assert.throws(() => db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)')] }), (e: Error) => e instanceof UpgradeError && /newer than this version/.test(e.message));
});

test('a failed migration rolls back completely', () => {
  const db = new Db(':memory:');
  assert.throws(() => db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x); INSERT INTO nowhere VALUES (1);')] }));
  assert.equal(db.version(), 0);
  assert.equal(db.get(`SELECT name FROM sqlite_master WHERE name='a'`), undefined);
});

test('transactions roll back on a throw and nest into the outer one', () => {
  const db = new Db(':memory:');
  db.migrate({ migrations: [mig(1, 'CREATE TABLE a (x)')] });
  assert.throws(() => db.tx(() => { db.run('INSERT INTO a VALUES (1)'); db.tx(() => db.run('INSERT INTO a VALUES (2)')); throw new Error('no'); }));
  assert.equal(db.all('SELECT * FROM a').length, 0);
});

test('a nested transaction that fails is undone on its own; the outer one keeps the rest', () => {
  const db = new Db(':memory:');
  db.raw.exec('CREATE TABLE t (x TEXT)');
  db.tx(() => {
    db.run("INSERT INTO t VALUES ('outer-before')");
    assert.throws(() => db.tx(() => {
      db.run("INSERT INTO t VALUES ('inner')");
      throw new Error('placeholder failure');
    }), /placeholder failure/);
    db.tx(() => db.run("INSERT INTO t VALUES ('inner-ok')"));
    db.run("INSERT INTO t VALUES ('outer-after')");
  });
  assert.deepEqual(db.all<{ x: string }>('SELECT x FROM t ORDER BY rowid').map((r) => r.x), ['outer-before', 'inner-ok', 'outer-after']);
  db.close();
});
