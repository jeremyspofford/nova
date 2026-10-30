// What Nova trusts in a backup folder, and who may read or choose it (M7 review): only backups
// Nova recorded and sealed count (a planted folder is ignored and reported, never "latest", never
// pushing real ones out of retention); a manifest can't send a restore or a clean outside the
// backup; backups are the person's alone (0700/0600) in a folder only they can write; and the
// encrypted copy opens with a recovery key the person was shown, without this machine's vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanBackup, openEncrypted, restoreInto } from '../../src/core/resilience/backup.ts';
import { open, world } from './resilience-support.ts';

const SECRET = 'The spare key is under the third flowerpot';
const mode = (p: string) => statSync(p).mode & 0o777;

test('a manifest naming a path outside the backup restores and cleans nothing outside it', async () => {
  const w = world('nova-trav-');
  const backup = join(w.target, 'nova-backup-000001');
  mkdirSync(join(backup, 'files'), { recursive: true });
  writeFileSync(join(backup, 'nova.db'), '');
  const rel = '../../outside/planted.txt';
  mkdirSync(join(backup, 'files', rel, '..'), { recursive: true });
  writeFileSync(join(backup, 'files', rel), `planted ${SECRET}\n`);
  writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ v: 1, id: 'nova-backup-000001', seq: 1, files: [{ path: rel, sha256: 'x', bytes: 1 }], db: {}, cleaned: [] }));
  const into = join(w.dir, 'drill', 'scratch', 'home');
  assert.throws(() => restoreInto(backup, into), /outside the backup/);
  assert.equal(existsSync(join(into, rel)), false, 'nothing written outside the scratch home');

  // Cleaning follows the same rule: the planted file outside the backup is never rewritten.
  const outside = join(backup, 'files', rel);
  assert.throws(() => cleanBackup(backup, 'memory', ['m-1'], [SECRET], new Date(), Buffer.alloc(32, 1)), /outside the backup/);
  assert.ok(readFileSync(outside, 'utf8').includes(SECRET), 'left as it was');
});

test('only backups Nova recorded count: planted folders are ignored, reported, and push nothing out', async () => {
  const w = world('nova-planted-');
  const c = open(w.home);
  try {
    c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target, keep: 2 });
    const a = c.resilience.nightly.run();
    const b = c.resilience.nightly.run();
    // Someone who can write the folder plants two "newer" backups, copies of a real one.
    for (const seq of ['999998', '999999']) {
      const p = join(w.target, `nova-backup-${seq}`);
      cpSync(b.path!, p, { recursive: true });
      const m = JSON.parse(readFileSync(join(p, 'manifest.json'), 'utf8'));
      writeFileSync(join(p, 'manifest.json'), JSON.stringify({ ...m, id: `nova-backup-${seq}`, seq: Number(seq) }));
    }
    assert.deepEqual(c.resilience.nightly.complete().map((x) => x.path), [b.path, a.path], 'the planted ones are not backups');
    c.resilience.nightly.prune();
    assert.ok(existsSync(a.path!) && existsSync(b.path!), 'retention kept the real ones');
    const strays = c.resilience.view().backups.strays;
    assert.equal(strays.length, 2, JSON.stringify(strays));
    assert.ok(strays.every((s: string) => /nova-backup-99999[89]$/.test(s)));
    // A real backup whose manifest was changed afterwards isn't trusted either.
    const m = JSON.parse(readFileSync(join(a.path!, 'manifest.json'), 'utf8'));
    writeFileSync(join(a.path!, 'manifest.json'), JSON.stringify({ ...m, files: [] }));
    assert.deepEqual(c.resilience.nightly.complete().map((x) => x.path), [b.path]);
  } finally {
    await c.close();
  }
});

test('backups are the person’s alone: folders 0700, files 0600, and a folder others can write is refused', async () => {
  const w = world('nova-modes-');
  const before = process.umask(0o022);
  const c = open(w.home);
  try {
    mkdirSync(join(w.home, 'notes'), { recursive: true });
    writeFileSync(join(w.home, 'notes', 'garden.md'), 'Water the tomatoes.\n');
    c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
    const r = c.resilience.nightly.run();
    for (const d of [r.path!, join(r.path!, 'files'), join(r.path!, 'files', 'notes')]) assert.equal(mode(d), 0o700, d);
    for (const f of [join(r.path!, 'nova.db'), join(r.path!, 'manifest.json'), join(r.path!, 'files', 'notes', 'garden.md'), r.encrypted_path!]) assert.equal(mode(f), 0o600, f);

    const shared = join(w.dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    assert.throws(() => c.resilience.setSettings({ target: shared }), /other users can write/);
    // A folder that became writable by others after it was chosen is refused at backup time.
    chmodSync(w.target, 0o777);
    assert.throws(() => c.resilience.nightly.run(), /other users can write/);
    chmodSync(w.target, 0o755);
  } finally {
    process.umask(before);
    await c.close();
  }
});

test('the encrypted copy opens with the recovery key shown once, without this machine’s vault', async () => {
  const w = world('nova-recovery-');
  const c = open(w.home);
  try {
    c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target });
    const set = c.resilience.setSettings({ encrypted_target: w.second }) as { recovery_key?: string };
    assert.match(set.recovery_key ?? '', /^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/, 'shown when the encrypted copy is set up');
    const key = set.recovery_key!;
    assert.equal((c.resilience.setSettings({ keep: 3 }) as { recovery_key?: string }).recovery_key, undefined, 'shown once');
    assert.equal(JSON.stringify(c.resilience.view()).includes(key), false);
    const r = c.resilience.nightly.run();
    assert.equal(readFileSync(r.encrypted_path!).includes(Buffer.from(key.replaceAll('-', ''))), false);
    for (const f of readdirSync(join(r.path!, 'files'), { recursive: true }) as string[]) {
      const p = join(r.path!, 'files', f);
      if (statSync(p).isFile()) assert.equal(readFileSync(p).includes(Buffer.from(key.replaceAll('-', ''))), false, `${f} doesn’t hold it`);
    }

    // This machine is lost: no home, no vault. The recovery key alone opens the copy.
    const out = join(w.dir, 'elsewhere');
    const m = openEncrypted(r.encrypted_path!, key, out);
    assert.equal(m.id, r.id);
    assert.ok(readFileSync(join(out, 'nova.db')).includes(Buffer.from(SECRET)));
    assert.throws(() => openEncrypted(r.encrypted_path!, key.replace(/^./, (x) => (x === 'a' ? 'b' : 'a')), join(w.dir, 'wrong')), /recovery key/);

    // The drill opens the encrypted copy with the recovery key, not the live vault: a vault whose
    // key changed doesn't make it pass or fail.
    c.vault.put('nova/backup-key', Buffer.alloc(32, 7).toString('base64'));
    const d = await c.resilience.drill({ source: 'encrypted', recoveryKey: key });
    assert.equal(d.ok, true, JSON.stringify(d.checks));
    assert.match(d.checks.find((x) => x.name === 'decrypt')?.said ?? '', /recovery key/);
    const bad = await c.resilience.drill({ source: 'encrypted', recoveryKey: '0'.repeat(64) });
    assert.equal(bad.ok, false);
  } finally {
    await c.close();
  }
});
