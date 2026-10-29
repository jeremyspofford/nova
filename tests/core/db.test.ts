import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, loadMigrations, restoreBackup, type Migration } from '../../src/core/db.ts';

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
