// Checkpoints on a real server process (M7 amendment §1): take a named checkpoint, change things,
// restore it from the hub's own screen, and Nova comes back by itself, on the same addresses, with
// the data as it was, without anyone restarting anything. The egress tripwire stays empty.
// (The integrator's m7-checkpoints-reset.test.ts adds export and factory reset.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blank, sleep, stop, until } from './support.ts';

test('restore with no manual restart: the same process comes back on the same ports with the checkpoint’s data, and records the restore', { timeout: 90_000 }, async () => {
  const m = blank('nova-m7-cp-');
  const nova = await m.start({ NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network' });
  try {
    const memories = async () => ((await m.get('/api/v1/memory')) as { content: string }[]).map((x) => x.content).sort();
    assert.equal((await m.send('POST', '/api/v1/memory', { kind: 'fact', content: 'The plants get water on Sundays.' })).status, 201);
    const cp = await m.send('POST', '/api/v1/resilience/checkpoints', { name: 'Before the experiment' });
    assert.equal(cp.status, 201, JSON.stringify(cp.body));
    assert.equal((await m.send('POST', '/api/v1/memory', { kind: 'fact', content: 'Added during the experiment.' })).status, 201);
    assert.deepEqual(await memories(), ['Added during the experiment.', 'The plants get water on Sundays.']);
    const hello = await (await fetch(`${nova.mesh}/api/v1/mesh/hello`)).json() as { epoch: number };

    const r = await m.send('POST', `/api/v1/resilience/checkpoints/${cp.body.id}/restore`, { confirm: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.restart.how, 'in-place');

    // Nova restarts by itself: the same process, the same port, the data as it was.
    const ready = () => (nova.out.join('').match(/Nova is ready at/g) ?? []).length;
    await until(async () => ready(), (n) => n >= 2, 400);
    assert.equal(ready(), 2, `it said it was ready again:\n${nova.out.join('')}`);
    assert.equal(nova.proc.exitCode, null, 'the process the person started is still the one running');
    const back = await until(async () => { try { return await memories(); } catch { return null; } }, (x) => !!x && x.length === 1, 400);
    assert.deepEqual(back, ['The plants get water on Sundays.']);
    const after = await (await fetch(`${nova.mesh}/api/v1/mesh/hello`)).json() as { epoch: number };
    assert.equal(after.epoch, hello.epoch + 1, 'the device door is back on the same address, at a higher epoch');

    const tasks = await until(async () => (await m.get('/api/v1/tasks')) as { owner: string; state: string; title: string; verification: { ok: boolean } | null }[], (ts) => ts.some((t) => t.owner === 'checkpoints' && t.state === 'done'), 400);
    const task = tasks.find((t) => t.owner === 'checkpoints')!;
    assert.equal(task.title, 'Restore to “Before the experiment”');
    assert.equal(task.state, 'done');
    assert.equal(task.verification?.ok, true);
    const list = (await m.get('/api/v1/resilience/checkpoints')) as { checkpoints: { label: string }[] };
    assert.ok(list.checkpoints.some((c) => c.label === 'Before restoring to “Before the experiment”'), 'a checkpoint of how it was just before');
    await sleep(100);
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'nothing left this machine');
  } finally {
    await stop(nova);
  }
});
