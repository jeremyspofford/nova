// A database upgrade that fails under plain `npm start` (F-020): one plain "Nova didn't start" line
// naming the copy from before, no stack trace, the database left as it was, and a second start
// adds no second copy and no second checkpoint. A database newer than this Nova is said the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { listCheckpoints, loadMigrations } from '../../src/core/index.ts';
import { open } from './resilience-support.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const start = (home: string, dir: string) => spawnSync(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT, encoding: 'utf8', timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: dir, NOVA_HOME: home, NOVA_VAULT_KEY: 'file', NOVA_PORT: '0' },
});
const sql = (home: string, q: string) => { const d = new DatabaseSync(join(home, 'nova.db')); try { d.exec(q); } finally { d.close(); } };
const version = (home: string) => { const d = new DatabaseSync(join(home, 'nova.db'), { readOnly: true }); try { return (d.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v; } finally { d.close(); } };
const copies = (home: string) => (existsSync(join(home, 'backups')) ? readdirSync(join(home, 'backups')).filter((f) => f.endsWith('.db')) : []);
const checkpoints = (home: string) => listCheckpoints(home);

test('a failed upgrade under npm start is one plain line, leaves the database as it was, and doesn’t pile up copies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-upgrade-'));
  const home = join(dir, 'home');
  await open(home).close();
  const all = loadMigrations();
  const last = all.at(-1)!;
  // The newest migration that adds a column: the database says it (and any after it) hasn't run,
  // though what it adds is there, so running it again fails.
  const adds = [...all].reverse().find((m) => /ADD COLUMN/i.test(m.sql))!;
  sql(home, `DELETE FROM schema_migrations WHERE version >= ${adds.version}`);
  const before = { cps: checkpoints(home).length };

  const first = start(home, dir);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, new RegExp(`^Nova didn't start: Nova couldn’t upgrade its database from version ${adds.version - 1} to ${last.version}: migration ${adds.version} \\(${adds.name}\\) failed`));
  assert.match(first.stderr, /Nothing was changed: your data is as it was before the upgrade, and a copy of it is at .*-v\d+\.db/);
  assert.doesNotMatch(first.stderr, /^\s+at /m, 'no stack trace');
  assert.equal(version(home), adds.version - 1, 'the database is as it was');
  assert.equal(copies(home).length, 1);
  const cps = checkpoints(home).length;
  assert.equal(cps, before.cps + 1, 'one checkpoint before the upgrade');

  const second = start(home, dir);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /^Nova didn't start: Nova couldn’t upgrade/);
  assert.equal(copies(home).length, 1, 'no second copy');
  assert.equal(checkpoints(home).length, cps, 'no second checkpoint');
});

test('a database newer than this Nova is refused in one plain line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-newer-'));
  const home = join(dir, 'home');
  await open(home).close();
  sql(home, `INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'from_the_future', 'x', '2026-11-10T00:00:00Z')`);
  const r = start(home, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Nova didn't start: The database is at migration 999, newer than this version of Nova knows/);
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});
