// Forgetting holds in backups too: a forgotten memory is gone from every pre-upgrade backup, the
// backups stay restorable, and restoring one cannot bring it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCore } from '../../src/core/index.ts';
import { restoreBackup } from '../../src/core/db.ts';

const SECRET = 'The spare key is under the third flowerpot';
const contains = (path: string, text: string) => readFileSync(path).includes(Buffer.from(text));

function core(home: string) {
  return createCore({ home, version: '0.1.0', trustedOrigin: () => true });
}

test('a forgotten memory is gone from every backup, which stays restorable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-backups-'));
  let c = core(home);
  const forgotten = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
  const kept = c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
  // Two backups that hold it, as an upgrade would leave them.
  mkdirSync(join(home, 'backups'), { recursive: true });
  for (const name of ['nova-a-v3.db', 'nova-b-v3.db']) c.db.raw.exec(`VACUUM INTO '${join(home, 'backups', name)}'`);
  const files = c.backups.list().map((b) => b.path);
  assert.equal(files.length, 2);
  for (const f of files) assert.ok(contains(f, SECRET), 'the backup holds it before forgetting');

  c.memory.forget(forgotten.id);
  for (const f of files) {
    assert.equal(contains(f, SECRET), false, `${f} no longer holds the forgotten words anywhere in the file`);
    const db = new DatabaseSync(f);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE id = ?').get(forgotten.id)?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE id = ?').get(kept.id)?.n, 1, 'everything else is still there');
    db.close();
  }
  assert.equal(c.log.problems().length, 0);

  // Restoring a cleaned backup brings back the rest, but not what was forgotten.
  await c.close();
  restoreBackup(join(home, 'nova.db'), files[0]!);
  c = core(home);
  assert.equal(c.memory.get(kept.id).content, 'Bins go out on the first weekday.');
  assert.throws(() => c.memory.get(forgotten.id));
  assert.equal(contains(join(home, 'nova.db'), SECRET), false);
  await c.close();
});

test('a backup that cannot be cleaned is destroyed, and that is reported', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-backups-'));
  const c = core(home);
  const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
  mkdirSync(join(home, 'backups'), { recursive: true });
  const broken = join(home, 'backups', 'nova-broken-v3.db');
  writeFileSync(broken, `not a database, but it mentions: ${SECRET}`);
  const old = join(home, 'backups', 'nova-old-v1.db');
  const pre = new DatabaseSync(old);
  pre.exec('CREATE TABLE profile (k TEXT)');
  pre.close();

  c.memory.forget(m.id);
  assert.equal(existsSync(broken), false, 'kept forgotten content is worse than no backup');
  assert.equal(existsSync(old), true, 'a backup from before memory existed has nothing to clean and is kept');
  const [p] = c.log.problems();
  assert.match(p?.message ?? '', /couldn’t be cleaned of something you asked Nova to forget/);
  await c.close();
});

test('forgetting a corrected memory cleans the backups; it does not destroy them (review finding)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-backups-'));
  const c = core(home);
  const first = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
  const fixed = c.memory.correct(first.id, `${SECRET}, the left one`, 'person');
  mkdirSync(join(home, 'backups'), { recursive: true });
  const file = join(home, 'backups', 'nova-chain-v3.db');
  c.db.raw.exec(`VACUUM INTO '${file}'`);
  c.memory.forget(fixed.id);
  assert.equal(existsSync(file), true, 'the backup is still there');
  assert.equal(contains(file, SECRET), false);
  assert.equal(c.log.problems().length, 0);
  await c.close();
});
