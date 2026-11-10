// Restoring a nightly backup (F-018, ruling D7: command first): a backup folder, or an encrypted
// copy opened with its recovery key alone, becomes a new home that a real core starts on with the
// backup's data, and nothing the person forgot comes back. The vault (F-014) is never brought back
// from somewhere it shouldn't be: a backup never holds its key. The command is the entry point a
// person uses (scripts/restore-backup.js, docs/restore.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from '../../src/core/vault.ts';
import { loadMigrations, openEncrypted, restoreFromBackup } from '../../src/core/index.ts';
import { open, world } from './resilience-support.ts';

const KEEP = 'Bins go out on the first weekday.';
const SECRET = 'The spare key is under the green flowerpot';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const vaultAt = (home: string) => new Vault({ home, mode: 'file', keychain: null });
const holds = (dir: string, text: string): boolean => {
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, f);
    if (statSync(p).isFile() && readFileSync(p).includes(Buffer.from(text))) return true;
  }
  return false;
};
const contents = async (home: string) => {
  const c = open(home);
  try {
    const vault = c.vault.status();
    return { memories: c.memory.list().map((m) => m.content), problems: c.log.problems({ open: true }).map((p) => p.message), vault, secrets: vault.ok ? c.vault.list() : null };
  } finally {
    await c.close();
  }
};

test('a backup folder restores into a new home: the core starts on it, and a forget made since stays forgotten', async () => {
  const w = world('nova-restore-folder-');
  const c = open(w.home);
  let backup: string;
  try {
    c.memory.remember({ kind: 'fact', content: KEEP, recorded_by: 'person' });
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    c.vault.put('connector/a/TOKEN', 'dummy-a');
    c.vault.put('connector/b/TOKEN', 'dummy-b');
    c.resilience.setSettings({ target: w.target });
    backup = c.resilience.nightly.run().path!;
    // Forgotten while the backup drive was unplugged: the backup still holds it, and the forget is owed.
    renameSync(w.target, `${w.target}-away`);
    c.memory.forget(m.id);
    // A secret deleted after the backup (F-014): it must not come back.
    c.vault.delete('connector/a/TOKEN');
  } finally {
    await c.close();
  }
  renameSync(`${w.target}-away`, w.target);
  assert.ok(holds(backup, SECRET), 'the backup still holds what was forgotten');

  const into = join(w.dir, 'restored');
  const r = restoreFromBackup({ from: backup, into, keepFrom: w.home, migrations: loadMigrations(), vaultAt });
  assert.equal(r.source, 'folder');
  assert.equal(r.home, into);
  assert.equal(r.kept?.forgotten.memories, 1, JSON.stringify(r.kept));
  assert.equal(holds(into, SECRET), false, 'the forget made since is applied to the restored home');
  assert.ok(r.said.some((s) => /taken out again/.test(s)), r.said.join('\n'));
  assert.ok(r.said.some((s) => s.includes(w.target)), 'it says where backups go now');
  assert.equal(readdirSync(w.dir).some((n) => n.includes('.restoring-')), false, 'no staging left behind');

  const after = await contents(into);
  assert.deepEqual(after.memories, [KEEP]);
  // The vault is the kept home's as it is now: the deleted secret stays deleted, the other is there.
  assert.equal(r.vault, 'now');
  assert.equal(after.secrets?.includes('connector/a/TOKEN'), false);
  assert.ok(after.secrets?.includes('connector/b/TOKEN'));
});

test('an encrypted copy opens with its recovery key alone, on a machine without the old home or its vault', async () => {
  const w = world('nova-restore-enc-');
  const c = open(w.home);
  let copy: string;
  let key: string;
  try {
    c.memory.remember({ kind: 'fact', content: KEEP, recorded_by: 'person' });
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    c.vault.put('connector/home-assistant/HA_TOKEN', 'dummy-token-value');
    c.resilience.setSettings({ target: w.target });
    key = (c.resilience.setSettings({ encrypted_target: w.second }) as { recovery_key: string }).recovery_key;
    copy = c.resilience.nightly.run().encrypted_path!;
    c.memory.forget(m.id);
  } finally {
    await c.close();
  }
  // The computer is lost: its home (and the vault's key with it) is gone.
  rmSync(w.home, { recursive: true, force: true });

  const into = join(w.dir, 'new-machine', 'home');
  assert.throws(() => restoreFromBackup({ from: copy, into, migrations: loadMigrations(), vaultAt }), /recovery key/);
  assert.throws(() => restoreFromBackup({ from: copy, into, recoveryKey: '0'.repeat(64), migrations: loadMigrations(), vaultAt }), /doesn’t open/);
  assert.equal(existsSync(into), false, 'a refused restore leaves nothing');

  const r = restoreFromBackup({ from: copy, into, recoveryKey: key, migrations: loadMigrations(), vaultAt });
  assert.equal(r.source, 'encrypted');
  assert.equal(r.vault, 'set-aside');
  assert.equal(holds(into, SECRET), false, 'forgotten before the restore, forgotten after');
  assert.ok(readdirSync(join(into, 'vault')).some((n) => n.startsWith('secrets.json.unopenable-')), 'the old vault file is kept aside');

  const after = await contents(into);
  assert.deepEqual(after.memories, [KEEP]);
  assert.equal(after.vault.ok, true);
  assert.equal(after.secrets?.includes('connector/home-assistant/HA_TOKEN'), false, 'the saved secret is not back');
  assert.ok(after.secrets?.includes('nova/backup-key'), 'the recovery key goes on making the encrypted copies');
  assert.ok(after.problems.some((p) => /sign in to each connector/.test(p)), after.problems.join('\n'));

  // The restored Nova's encrypted copies still open with the recovery key the person holds.
  const again = open(into);
  try {
    const run = again.resilience.nightly.run();
    const m = openEncrypted(run.encrypted_path!, key, join(w.dir, 'opened'));
    assert.equal(m.id, run.id);
  } finally {
    await again.close();
  }
});

test('the backup’s own record of a forget is applied again, and a home is never written over', async () => {
  const w = world('nova-restore-own-');
  const c = open(w.home);
  let backup: string;
  try {
    c.memory.remember({ kind: 'fact', content: KEEP, recorded_by: 'person' });
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    // A forget recorded but not finished when the backup was taken.
    c.db.run(`INSERT INTO memory_event (at, kind, memory_id, by) VALUES (?, 'forgotten', ?, 'person')`, new Date().toISOString(), m.id);
    c.resilience.setSettings({ target: w.target });
    backup = c.resilience.nightly.run().path!;
  } finally {
    await c.close();
  }
  const taken = join(w.dir, 'taken');
  mkdirSync(taken);
  writeFileSync(join(taken, 'note.txt'), 'mine');
  assert.throws(() => restoreFromBackup({ from: backup, into: taken, migrations: loadMigrations(), vaultAt }), /isn’t empty/);
  assert.equal(readFileSync(join(taken, 'note.txt'), 'utf8'), 'mine');

  // A damaged backup is refused whole.
  const damaged = join(w.dir, 'damaged');
  mkdirSync(damaged);
  for (const f of readdirSync(backup, { recursive: true }) as string[]) {
    const p = join(backup, f);
    if (statSync(p).isDirectory()) mkdirSync(join(damaged, f), { recursive: true });
    else writeFileSync(join(damaged, f), readFileSync(p));
  }
  writeFileSync(join(damaged, 'nova.db'), Buffer.concat([readFileSync(join(damaged, 'nova.db')), Buffer.from('x')]));
  assert.throws(() => restoreFromBackup({ from: damaged, into: join(w.dir, 'from-damaged'), migrations: loadMigrations(), vaultAt }), /damaged/);
  assert.equal(existsSync(join(w.dir, 'from-damaged')), false);

  const into = join(w.dir, 'restored');
  const r = restoreFromBackup({ from: backup, into, migrations: loadMigrations(), vaultAt });
  assert.equal(r.forgotten.memories, 1);
  assert.equal(holds(into, SECRET), false);
  assert.deepEqual((await contents(into)).memories, [KEEP]);
});

test('the command restores a backup folder and an encrypted copy, with the key on standard input', async () => {
  const w = world('nova-restore-cmd-');
  const c = open(w.home);
  let backup: string;
  let copy: string;
  let key: string;
  try {
    c.memory.remember({ kind: 'fact', content: KEEP, recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target });
    key = (c.resilience.setSettings({ encrypted_target: w.second }) as { recovery_key: string }).recovery_key;
    const run = c.resilience.nightly.run();
    backup = run.path!;
    copy = run.encrypted_path!;
  } finally {
    await c.close();
  }
  const env = { ...process.env, NOVA_VAULT_KEY: 'file', NOVA_HOME: join(w.dir, 'unused') };
  const cmd = (args: string[], input = '') => spawnSync(process.execPath, [join(ROOT, 'scripts', 'restore-backup.js'), ...args], { cwd: ROOT, env, input, encoding: 'utf8', timeout: 60_000 });

  const a = cmd([backup, join(w.dir, 'a')]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Restored nova-backup-000001/);
  assert.match(a.stdout, /NOVA_HOME=.*npm start/);

  const none = cmd([copy, join(w.dir, 'b')]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /recovery key/);
  const b = cmd([copy, join(w.dir, 'b')], `${key}\n`);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /Sign in to each connector/);
  assert.equal(b.stdout.includes(key), false, 'the key is never printed');

  for (const home of [join(w.dir, 'a'), join(w.dir, 'b')]) assert.deepEqual((await contents(home)).memories, [KEEP]);
});
