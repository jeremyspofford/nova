// Before Nova restarts in place (a restore, a factory reset), nothing it started may live on into
// the restarted home: every running ledger task is stopped, and every process Nova started (a
// provider's command in its own process group, a sandbox, a browser) is ended, within a bound.
// Otherwise a detached command keeps writing into the restored workspace (M7 amendment review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runLines } from '../../src/core/providers/cli.ts';
import type { LanedWorker } from '../../src/core/index.ts';
import { open, world } from './resilience-support.ts';
import { ensureMark } from '../../src/core/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A worker whose command, in a process group of its own, writes into the workspace a second later.
// `listens`: whether it hands its command the task's signal (a well-behaved provider) or not.
function writer(id: string, file: string, listens: boolean): LanedWorker {
  return {
    id, name: id, about: 'Writes a file later.', egress: 'none', evidence: ['confirmation'], lane: () => ({ key: id, max: 1 }),
    run: async (brief: { task_id: string }, signal: AbortSignal) => {
      await runLines({ argv: ['/bin/sh', '-c', `sleep 1; echo late > '${file}'`], cwd: '/', onLine: () => {}, ...(listens ? { signal } : {}) });
      return { envelope: '1', task_id: brief.task_id, status: 'done', summary: 'Wrote it.', evidence: [], artifacts: [], blockers: [], follow_up_suggestions: [], usage: { duration_ms: 0 } };
    },
  } as unknown as LanedWorker;
}

test('stopping Nova’s work before a restart: running tasks stop, and no process it started outlives it', { timeout: 30_000 }, async () => {
  const w = world('nova-stopwork-');
  ensureMark(w.home);
  mkdirSync(join(w.home, 'workspace'), { recursive: true });
  const polite = join(w.home, 'workspace', 'polite.txt');
  const deaf = join(w.home, 'workspace', 'deaf.txt');
  const c = open(w.home, { workers: [writer('example-polite', polite, true), writer('example-deaf', deaf, false)] });
  try {
    c.start();
    const task = (owner: string) => c.ledger.create({ title: `Write with ${owner}`, owner, goal: 'A file.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation', note: 'n/a' }], approval_tier: 0 });
    const a = task('example-polite');
    const b = task('example-deaf');
    void c.ledger.pump();
    for (let i = 0; i < 100 && [a, b].some((t) => c.ledger.get(t.id).state !== 'active'); i++) await sleep(20);
    assert.deepEqual([a, b].map((t) => c.ledger.get(t.id).state), ['active', 'active']);

    const started = Date.now();
    await c.stopWork(3000);
    assert.ok(Date.now() - started < 4000, 'within its bound');
    await sleep(1500);
    assert.equal(existsSync(polite), false, 'the task’s command was stopped with it');
    assert.equal(existsSync(deaf), false, 'even a command that ignores the task’s signal is ended');
    // Left as they were, for the next start to pick up again: not failed.
    for (const t of [a, b]) assert.notEqual(c.ledger.get(t.id).state, 'failed');
  } finally {
    await c.close();
  }
});
