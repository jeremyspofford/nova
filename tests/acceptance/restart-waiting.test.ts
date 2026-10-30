// A scheduled run that is waiting for the person's OK when Nova dies must not stay "waiting"
// forever and block its schedule (M2 review finding). Real process, killed hard, started again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, blank, sleep, stop, until } from './support.ts';
import { ensureMark } from '../../src/core/index.ts';

test('after a hard restart, a run that waited for an OK ends with a reason, and its schedule can run again', async () => {
  const m = blank('nova-restart-');
  ensureMark(m.home);
  mkdirSync(join(m.home, 'schedules'), { recursive: true });
  writeFileSync(join(m.home, 'schedules', 'status-check.md'), '---\nname: Status check\ncron: 0 9 * * *\ndeliver: main\n---\n\nRun git status.\n');
  const env = { NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' };

  let nova = await m.start(env);
  type Task = any;
  let waiting: Task;
  try {
    assert.ok([200, 202].includes((await m.send('POST', '/api/schedules/status-check/run', {})).status));
    const tasks = await until<Task[]>(() => m.get('/api/v1/tasks'), (ts) => ts.some((t: Task) => t.owner === 'chat-run' && t.state === 'waiting'));
    waiting = tasks.find((t: Task) => t.owner === 'chat-run' && t.state === 'waiting');
    assert.ok(waiting, 'the run stepped aside to wait for an OK');
    assert.match(waiting.reason, /OK on a step/);
  } finally {
    nova.proc.kill('SIGKILL'); // a crash, not a clean stop
    for (let i = 0; i < 200 && nova.proc.exitCode === null && nova.proc.signalCode === null; i++) await sleep(25);
  }

  nova = await m.start(env);
  try {
    const after = await until<Task>(() => m.get(`/api/v1/tasks/${waiting.id}`), (t) => t.state !== 'waiting' && t.state !== 'queued' && t.state !== 'active');
    assert.notEqual(after.state, 'waiting', 'not stuck');
    assert.ok(['failed', 'done', 'cancelled'].includes(after.state), `ended with a reason: ${after.state} — ${after.reason}`);
    const events = await m.get(`/api/v1/tasks/${waiting.id}/events`);
    assert.ok(events.some((e: Task) => /restarted while this waited for your OK/.test(e.detail?.reason ?? '')));
    const again = await m.send('POST', '/api/schedules/status-check/run', {});
    assert.ok([200, 202].includes(again.status), `the schedule is free to run again (got ${again.status}: ${JSON.stringify(again.body)})`);
  } finally {
    await stop(nova);
  }
});
