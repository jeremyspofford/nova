// Going back across a database upgrade must not undo work the newer release already did (M7
// review): the release says where the data stood before it ran any work (recovery, the
// heartbeat), so a task it picked up on starting counts as written since, and going back is
// refused rather than restoring a database where that task is "running" again, to be run twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { api, cli, releaseRepo, scratch, supervise } from './support.ts';

test('work a new release did on starting counts: going back is refused rather than undo it', async () => {
  const dir = scratch('nova-rel-mark-');
  const r = releaseRepo(dir);
  r.tag('v1.3.0', (root) => {
    r.edit(root, 'package.json', '"version": "0.1.0"', '"version": "0.1.3"');
    writeFileSync(join(root, 'src', 'core', 'migrations', `${r.nextMigration(root)}_release_note.sql`), '-- A harmless new table, so this release upgrades the database.\nCREATE TABLE release_note (id INTEGER PRIMARY KEY, text TEXT NOT NULL);\n');
  });
  const s = await supervise({ dir, repo: r.repo });
  try {
    // A task that was running when Nova stopped for the switch: the new release recovers it as it
    // starts (a write to the Work Ledger, with whatever outside effect the task has).
    const t = await api(s.base(), 'POST', '/api/v1/tasks', { title: 'Order the parts', owner: 'resilience', goal: 'Order the parts once.', evidence_required: [{ kind: 'confirmation', note: 'the order number' }], approval_tier: 2, inputs: { action: 'drill' } });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const db = new DatabaseSync(join(s.home, 'nova.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(`UPDATE task SET state = 'active' WHERE id = ?`).run(t.body.id);
    db.close();

    const d = await cli(s.dir, 'deploy', 'v1.3.0', '--confirm', 'v1.3.0');
    assert.equal(d.code, 0, d.out);
    const mig = s.state().releases.slots.find((x: { version: string }) => x.version === 'v1.3.0').migration;
    assert.equal(mig.mark.by, 'release', 'the release said where the data stood before its work ran');

    const back = await cli(s.dir, 'rollback', '--confirm', 'rollback');
    assert.equal(back.code, 1, back.out);
    assert.match(back.out, /would lose \d+ changes? written since v1\.3\.0 upgraded the database \(.*task/);
    assert.equal(s.state().releases.current, 'v1.3.0');
  } finally {
    await s.stop();
  }
});
