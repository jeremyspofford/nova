// Owner ruling D5 (2026-11-10): a failed task, a scheduled one included, is amber "Needs you", not
// red. Tasks are not a downed system; red is only for Nova itself stopped. A failed task's problem
// is raised without `stops`, and the ones raised before (stops = 1) are amber after the upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Db, loadMigrations } from '../../src/core/db.ts';
import { open, world } from './resilience-support.ts';

test('a failed task opens an amber problem, not a stopping one (D5)', async () => {
  const w = world('nova-d5-');
  const c = open(w.home);
  try {
    c.resilience.setSettings({ target: w.target });
    rmSync(w.target, { recursive: true });
    const t = c.resilience.request('backup');
    await c.ledger.idle();
    assert.equal(c.ledger.get(t.id).state, 'failed');
    const p = c.log.problems({ open: true }).find((x) => x.task_id === t.id);
    assert.ok(p, 'the failure is a problem');
    assert.match(p.message, /^A task failed: Backup now\./);
    assert.equal(Number(p.stops), 0, 'amber: it needs you, it hasn’t stopped Nova');
  } finally {
    await c.close();
  }
});

test('failed-task problems raised before as stopping are amber after the upgrade; others keep theirs', () => {
  const all = loadMigrations();
  const db = new Db(':memory:');
  db.migrate({ migrations: all.filter((m) => m.version <= 27) });
  const add = (source: string, message: string) => db.run('INSERT INTO problem (at, source, message, stops) VALUES (?, ?, ?, 1)', '2026-11-09T00:00:00Z', source, message);
  add('ledger', 'A task failed: Nightly backup. The backup folder isn’t there.');
  add('resilience', 'Nova is held in safe mode.');
  db.migrate({ migrations: all });
  const rows = db.all<{ source: string; stops: number }>('SELECT source, stops FROM problem ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.source, r.stops]), [['ledger', 0], ['resilience', 1]]);
});
