// The restore drill (M7 gate item 6): the latest backup restored into a scratch home, its integrity,
// migration checksums, content hashes and forgotten items checked, and a real sandbox Nova started
// on it and asked the smoke probes. It passes on a good backup, and a corrupted backup is caught.
// Run alone for the gate: node --test tests/core/resilience-drill.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, world } from './resilience-support.ts';

test('the drill passes on a good backup, as a ledger task with its evidence, and from the encrypted copy', async () => {
  const w = world('nova-drill-');
  const c = open(w.home);
  try {
    c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    const gone = c.memory.remember({ kind: 'fact', content: 'Something to forget later', recorded_by: 'person' });
    c.memory.forget(gone.id);
    c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
    c.resilience.nightly.run();

    const t = c.resilience.request('drill');
    await c.ledger.idle();
    const done = c.ledger.get(t.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.match(done.verification!.checks[0]!.why, /all \d+ checks passed/);
    const d = c.resilience.drills(1)[0]!;
    assert.equal(d.ok, true);
    const names = d.checks.map((x) => x.name);
    for (const n of ['restore', 'content', 'integrity', 'migrations', 'forgotten', 'start', 'probe:health', 'probe:memory']) assert.ok(names.includes(n), `checks: ${names}`);
    assert.match(d.checks.find((x) => x.name === 'forgotten')!.said, /None of the 1 forgotten memory/);
    // The checks are evidence on the task, in its events.
    assert.ok(c.ledger.events(t.id).some((e) => e.kind === 'drill_checks'));

    const enc = await c.resilience.drill({ source: 'encrypted' });
    assert.equal(enc.ok, true, JSON.stringify(enc.checks));
    assert.match(enc.backup!, /\.nbk$/);
  } finally {
    await c.close();
  }
});

test('a corrupted backup is caught by the drill: a failed task, a problem with its playbook', async () => {
  const w = world('nova-drill-bad-');
  const c = open(w.home);
  try {
    c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target });
    const r = c.resilience.nightly.run();
    // Bit rot in the middle of the database file.
    const db = join(r.path!, 'nova.db');
    const bytes = readFileSync(db);
    for (let i = 4096; i < 4196; i++) bytes[i] = 0xff;
    writeFileSync(db, bytes);

    const t = c.resilience.request('drill');
    await c.ledger.idle();
    const failed = c.ledger.get(t.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.reason!, /The restore drill failed/);
    const d = c.resilience.drills(1)[0]!;
    assert.equal(d.ok, false);
    assert.equal(d.checks.find((x) => x.name === 'content')!.ok, false, 'the hash check catches it');
    const p = c.resilience.playbooks.list().find((x) => x.task_id === t.id);
    assert.equal(p?.playbook?.id, 'drill-failed');
    assert.equal(c.health().checks.backups.ok, false);

    // A new, good backup and a passing drill close it.
    c.resilience.nightly.run();
    const again = await c.resilience.drill();
    assert.equal(again.ok, true, JSON.stringify(again.checks));
    assert.equal(c.log.problems({ open: true }).some((x) => x.id === p!.id), false, 'a passing drill closes the problem');
  } finally {
    await c.close();
  }
});

test('a backup whose database passes its hash but fails SQLite’s own check is caught too', async () => {
  const w = world('nova-drill-int-');
  const c = open(w.home);
  try {
    for (let i = 0; i < 200; i++) c.memory.remember({ kind: 'fact', content: `Fact number ${i} about the garden and the shed.`, recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target });
    const r = c.resilience.nightly.run();
    // Damage written with its hash updated, so only the integrity check can see it.
    const db = join(r.path!, 'nova.db');
    const bytes = readFileSync(db);
    for (let i = 2 * 4096; i < 2 * 4096 + 8; i++) bytes[i] = 0xff; // a b-tree page's header
    writeFileSync(db, bytes);
    const m = JSON.parse(readFileSync(join(r.path!, 'manifest.json'), 'utf8'));
    const { sha256File } = await import('../../src/core/index.ts');
    const { writeManifest, SEAL_NAME } = await import('../../src/core/resilience/backup.ts');
    m.db.sha256 = sha256File(db);
    m.db.bytes = bytes.length;
    // Sealed again as Nova would, so the backup still counts as Nova's: only SQLite can tell.
    writeManifest(r.path!, m, Buffer.from(c.vault.get(SEAL_NAME)!, 'base64'));
    const d = await c.resilience.drill();
    assert.equal(d.ok, false);
    const bad = d.checks.filter((x) => !x.ok).map((x) => x.name);
    assert.ok(bad.some((n) => ['integrity', 'database', 'start', 'probe:memory'].includes(n)), `failed: ${bad}`);
  } finally {
    await c.close();
  }
});
