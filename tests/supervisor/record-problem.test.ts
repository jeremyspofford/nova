// The supervisor writes a problem straight into the database when no server is there to take it
// (safe mode, stopped). The problem and its playbook are one write: a supervisor killed between
// the two would leave a problem no playbook knows, so the next one of its kind couldn't find it
// and would open a second. Here the kill lands exactly there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { recordProblem } from '../../src/supervisor/releases.ts';
import { open, world } from '../core/resilience-support.ts';

test('a supervisor killed while it records a problem leaves no problem without its playbook: the next of its kind finds the one open', async () => {
  const w = world('nova-sup-killed-mid-problem-');
  // A home with its database made, as a server leaves it.
  await open(w.home).close();
  const releases = join(import.meta.dirname, '..', '..', 'src', 'supervisor', 'releases.ts');
  const tell = { source: 'supervisor', said: 'Nova is held in safe mode: Nova stopped 3 times within 60 s.', playbook: 'safe-mode' };
  const script = `
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) { if (sql.includes('INTO problem_playbook')) process.kill(process.pid, 'SIGKILL'); return prepare.call(this, sql); };
    const { recordProblem } = await import(${JSON.stringify(releases)});
    recordProblem(${JSON.stringify(w.home)}, ${JSON.stringify(tell)});`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: w.dir } });
  assert.equal(killed.signal, 'SIGKILL', `the child died where the test kills it:\n${killed.stderr}`);

  recordProblem(w.home, tell);
  const c = open(w.home);
  try {
    const orphans = c.log.problems({ open: true }).filter((p) => !c.resilience.playbooks.view(p.id));
    assert.deepEqual(orphans.map((p) => p.message), [], 'no open problem is missing its playbook');
    assert.equal(c.log.problems({ open: true }).filter((p) => p.source === 'supervisor').length, 1, 'one open problem of its kind');
  } finally {
    await c.close();
  }
});
