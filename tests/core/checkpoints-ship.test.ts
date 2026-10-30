// An automatic checkpoint before a change goes live (M7 amendment §1): the change pipeline takes
// one at ship, before the canary applies anything; when none can be taken (a full disk), the change
// waits with the reason in plain words and is never shipped without one. Real sandbox processes,
// as in changes.test.ts. Neutral placeholders; throwaway homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCore } from '../../src/core/index.ts';
import { windDown } from '../support/changes.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

function open(free: { v: number | null }) {
  const home = mkdtempSync(join(tmpdir(), 'nova-cp-ship-'));
  execFileSync('git', ['-C', home, 'init', '-q']);
  const clock = { now: new Date('2030-01-15T08:00:00.000Z') };
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => clock.now, checkpoints: { free: () => free.v } });
  core.profile.set('user', 'timezone', 'UTC', 'settings');
  core.start();
  return { home, core };
}

test('a change takes a checkpoint at ship, before the canary applies it', { timeout: 120_000 }, async () => {
  const { home, core } = open({ v: null });
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() });
    const live = await until(() => core.changes.get(c.id), (x) => x.state !== 'checking' && (x.state !== 'canary' || x.canary?.applied === true));
    assert.equal(live.state, 'canary', live.reason ?? '');
    const cps = core.checkpoints.list();
    assert.equal(cps.length, 1, JSON.stringify(cps));
    assert.equal(cps[0]!.kind, 'auto');
    assert.equal(cps[0]!.reason, 'Before shipping “Daily wind-down” v1.0.0');
    // Taken before anything of it went live: the rule isn't in the checkpoint's database.
    const d = new DatabaseSync(join(home, 'checkpoints', cps[0]!.id, 'nova.db'), { readOnly: true });
    try { assert.equal((d.prepare(`SELECT COUNT(*) AS n FROM trigger_rule WHERE name = 'Wind down'`).get() as { n: number }).n, 0); } finally { d.close(); }
    assert.ok(core.triggers.listRules().some((r) => r.name === 'Wind down'), 'and now it is live');
  } finally {
    await core.close();
  }
});

test('no checkpoint, no ship: on a full disk the change waits with the reason, and ships once one can be taken', { timeout: 120_000 }, async () => {
  const free = { v: 10 as number | null };
  const { core } = open(free);
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() });
    const waiting = await until(() => core.changes.get(c.id), (x) => x.state !== 'checking' && x.state !== 'canary');
    assert.equal(waiting.state, 'waiting', waiting.reason ?? '');
    assert.match(waiting.reason ?? '', /Not shipped: Nova couldn’t take a checkpoint first/);
    assert.match(waiting.reason ?? '', /isn’t enough free space/);
    assert.equal(core.triggers.listRules().some((r) => r.name === 'Wind down'), false, 'nothing of it went live');
    assert.deepEqual(core.checkpoints.list(), []);
    // The Ship task waits for the person too, blocked, with the same reason.
    const task = await until(() => core.ledger.get(waiting.ship_task_id!), (t) => /^Blocked:/.test(t.reason ?? ''));
    assert.equal(task.state, 'waiting');
    assert.match(task.reason ?? '', /^Blocked: Not shipped: Nova couldn’t take a checkpoint first/);

    // Room again: the person says Ship it again, and it ships, with its checkpoint.
    free.v = null;
    core.changes.ship(c.id);
    const shipped = await until(() => core.changes.get(c.id), (x) => x.state === 'canary' && x.canary?.applied === true);
    assert.equal(shipped.state, 'canary', shipped.reason ?? '');
    assert.equal(core.checkpoints.list()[0]?.reason, 'Before shipping “Daily wind-down” v1.0.0');
  } finally {
    await core.close();
  }
});
