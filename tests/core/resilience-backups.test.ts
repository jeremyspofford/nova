// Nightly backups (M7b): what goes in and what never does, retention by sequence (a clock that
// jumped can't pick the wrong ones), the encrypted copy (AES-256-GCM, key in the vault), forgetting
// carried into both, and a missing folder refused, never created. The restore drill is in
// resilience-drill.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open, world } from './resilience-support.ts';

const SECRET = 'The spare key is under the third flowerpot';
const has = (path: string, text: string) => readFileSync(path).includes(Buffer.from(text));

const files = (dir: string, rel = ''): string[] => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, join(rel, e.name)) : [join(rel, e.name)]));

test('a backup holds a consistent snapshot and the home’s files, with hashes; never the vault key or the private keys', async () => {
  const w = world();
  const c = open(w.home);
  try {
    c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    c.vault.put('provider/API_KEY', 'sk-placeholder-0123456789');
    mkdirSync(join(w.home, 'notes'), { recursive: true });
    writeFileSync(join(w.home, 'notes', 'garden.md'), 'Water the tomatoes.\n');
    mkdirSync(join(w.home, 'logs'), { recursive: true });
    assert.ok(existsSync(join(w.home, 'vault', 'key')), 'the vault key is a file in this home');
    assert.ok(existsSync(join(w.home, 'mesh', 'identity.json')), 'and this node has private keys');

    assert.throws(() => c.resilience.setSettings({ target: join(w.dir, 'not-there') }), /isn’t a folder/);
    assert.throws(() => c.resilience.setSettings({ target: join(w.home, 'workspace') }), /inside Nova’s home/);
    c.resilience.setSettings({ target: w.target });
    // Setting a folder starts the schedules, visibly.
    const rules = c.triggers.listRules().map((r) => r.name);
    assert.ok(rules.includes('Nightly backup') && rules.includes('Weekly restore drill'), `rules: ${rules}`);

    const r = c.resilience.nightly.run();
    assert.equal(r.ok, true);
    assert.match(r.id, /^nova-backup-000001$/);
    const got = files(join(r.path!, 'files'));
    assert.ok(got.includes(join('notes', 'garden.md')));
    assert.ok(got.includes(join('vault', 'secrets.json')), 'the vault’s file goes in, encrypted');
    assert.ok(!got.includes(join('vault', 'key')), 'never its key');
    assert.ok(!got.includes(join('mesh', 'identity.json')), 'never this node’s private keys');
    assert.ok(!got.some((f) => f.startsWith('logs') || f.startsWith('nova.db')), 'no logs, and the database only as its snapshot');
    const m = JSON.parse(readFileSync(join(r.path!, 'manifest.json'), 'utf8'));
    assert.equal(m.files.length, got.length);
    assert.ok(m.excluded.some((x: string) => x.startsWith('vault/key')));
    assert.ok(m.migrations.length >= 11 && m.schema_version === m.migrations.at(-1).version);
    const snap = new DatabaseSync(join(r.path!, 'nova.db'), { readOnly: true });
    assert.equal((snap.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }).n, 1);
    assert.equal((snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    snap.close();

    // As a ledger task: done only once Nova read the backup back itself.
    const t = c.resilience.request('backup');
    await c.ledger.idle();
    const done = c.ledger.get(t.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.match(done.verification!.checks[0]!.why, /read nova-backup-000002 back itself/);
  } finally {
    await c.close();
  }
});

test('retention keeps the newest by sequence, even when the clock went back; old ones go only after a new one is complete', async () => {
  const w = world();
  let at = Date.parse('2026-10-30T03:30:00Z');
  const c = open(w.home, { now: () => new Date(at) });
  try {
    c.resilience.setSettings({ target: w.target, keep: 2 });
    for (let i = 0; i < 3; i++) { c.resilience.nightly.run(); at += 86_400_000; }
    at -= 10 * 86_400_000; // the clock jumps back ten days
    c.resilience.nightly.run();
    const kept = readdirSync(w.target).sort();
    assert.deepEqual(kept, ['nova-backup-000003', 'nova-backup-000004'], 'the newest two by sequence, not by date');
  } finally {
    await c.close();
  }
});

test('the encrypted copy: unreadable without the vault key, restored whole, refused when changed', async () => {
  const w = world();
  const c = open(w.home);
  try {
    c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    assert.throws(() => c.resilience.setSettings({ target: w.target, encrypted_target: w.target }), /second folder/);
    c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
    const r = c.resilience.nightly.run();
    assert.ok(r.encrypted_path && existsSync(r.encrypted_path));
    assert.ok(has(join(r.path!, 'nova.db'), SECRET), 'the plain backup holds it');
    assert.equal(has(r.encrypted_path, SECRET), false, 'the encrypted copy doesn’t show it');
    assert.ok(c.vault.list().includes('nova/backup-key'), 'its key lives in the vault');

    const out = join(w.dir, 'opened');
    const m = c.resilience.nightly.decrypt(r.encrypted_path, out);
    assert.equal(m.id, r.id);
    assert.deepEqual(readFileSync(join(out, 'nova.db')), readFileSync(join(r.path!, 'nova.db')));

    // One byte changed anywhere: the whole copy is refused, and nothing is unpacked.
    const bytes = readFileSync(r.encrypted_path);
    bytes[bytes.length - 40]! ^= 1;
    const bad = join(w.dir, 'bad.nbk');
    writeFileSync(bad, bytes);
    assert.throws(() => c.resilience.nightly.decrypt(bad, join(w.dir, 'opened-bad')), /changed or damaged/);
    assert.equal(existsSync(join(w.dir, 'opened-bad', 'nova.db')), false);
  } finally {
    await c.close();
  }
});

test('forgetting holds in the nightly backups and the encrypted copies: the database and the files are cleaned', async () => {
  const w = world();
  const c = open(w.home);
  try {
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    const kept = c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    mkdirSync(join(w.home, 'memory'), { recursive: true });
    writeFileSync(join(w.home, 'memory', '2026-10-30.md'), `- ${SECRET}\n- Bins go out on the first weekday.\n`);
    c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
    const r = c.resilience.nightly.run();
    assert.ok(has(join(r.path!, 'files', 'memory', '2026-10-30.md'), SECRET));

    c.memory.forget(m.id);
    assert.equal(has(join(r.path!, 'nova.db'), SECRET), false, 'gone from the snapshot, freed pages included');
    const note = readFileSync(join(r.path!, 'files', 'memory', '2026-10-30.md'), 'utf8');
    assert.equal(note.includes(SECRET), false, 'gone from the day note in the backup');
    assert.ok(note.includes('Bins go out'), 'the rest of the note stays');
    const man = JSON.parse(readFileSync(join(r.path!, 'manifest.json'), 'utf8'));
    assert.equal(man.cleaned.length, 1, 'the manifest says it was cleaned');
    const opened = join(w.dir, 'opened');
    c.resilience.nightly.decrypt(r.encrypted_path!, opened);
    assert.equal(has(join(opened, 'nova.db'), SECRET), false, 'gone from the encrypted copy too');
    assert.equal(readFileSync(join(opened, 'files', 'memory', '2026-10-30.md'), 'utf8').includes(SECRET), false);
    const db = new DatabaseSync(join(opened, 'nova.db'), { readOnly: true });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory WHERE id = ?').get(kept.id) as { n: number }).n, 1);
    db.close();
    assert.equal(c.log.problems().length, 0);
  } finally {
    await c.close();
  }
});

test('a backup folder that isn’t there is refused, never created; the task fails into its playbook, which retries once it is back', async () => {
  const w = world();
  const c = open(w.home);
  try {
    c.resilience.setSettings({ target: w.target });
    rmSync(w.target, { recursive: true });
    const t = c.resilience.request('backup');
    await c.ledger.idle();
    assert.equal(c.ledger.get(t.id).state, 'failed');
    assert.equal(existsSync(w.target), false, 'Nova did not create the folder');
    const p = c.resilience.playbooks.list().find((x) => x.task_id === t.id);
    assert.ok(p, 'a problem for the failed backup');
    assert.equal(p.playbook?.id, 'backup-target-missing');
    assert.match(p.message, /isn’t there/);
    assert.ok(p.playbook!.steps.length >= 2);
    assert.equal(c.health().checks.backups.ok, false);

    // Its repair: once the folder is back, the backup is made and the problem closes.
    mkdirSync(w.target);
    const r = await c.resilience.playbooks.attempt(p.id, 'person');
    assert.equal(r.ok, true, r.said);
    assert.equal(c.log.problems({ open: true }).some((x) => x.id === p.id), false);
    assert.equal(readdirSync(w.target).filter((f) => f.startsWith('nova-backup-')).length, 1);
  } finally {
    await c.close();
  }
});
