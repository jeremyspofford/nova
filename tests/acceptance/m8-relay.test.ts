// M8 gate, the CI half (docs/plans/M8.md §3): a coding task briefed from Nova is executed by Relay's
// workers in worktrees and reported back with diff evidence. Relay here is the stand-in
// (scripts/stand-ins/fake-relay.js), which speaks Relay's contract v1 and makes real git worktrees;
// the real Relay is the opt-in m8-relay-real test.
//
// The real server as its own process with the egress tripwire. The M5 calc brief goes to the relay
// provider: Relay's worker fixes it in a worktree, Nova copies it into the task's folder, runs the
// test itself (after asking) and checks the diff, and only then copies it into the workspace. Also:
// a lying run fails with the verifier's reason and nothing is copied back; a local-only task is
// refused while Relay reports remote egress; cancel mid-run reaches Relay; runtime_busy waits and
// then completes; nothing tried to leave this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, sleep, stop, until } from './support.ts';
import { startFakeRelay } from '../../scripts/stand-ins/fake-relay.js';
import { BROKEN_SUM, FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';

test('M8 gate (CI): the calc brief, done by Relay’s worker in a worktree, verified by Nova; lying, local-only, cancel, busy', { timeout: 180_000 }, async () => {
  const m = blank('nova-m8-relay-');
  const relay = await startFakeRelay({ mode: 'honest', workerEgress: 'local', lagMs: 50 });
  const nova = await m.start();
  const api = (p: string) => `/api/v1${p}`;
  const task = (id: string) => m.get(api(`/tasks/${id}`));
  const sum = () => readFileSync(join(m.home, 'workspace', 'calc', 'sum.mjs'), 'utf8');
  // Submit the brief and wait for the end, giving the OK each time Nova asks to run the test on
  // what Relay's worker wrote.
  const run = async (over: Record<string, unknown> = {}, seen?: (t: any) => void) => {
    const created = await m.send('POST', api('/tasks'), calcTask('relay', over));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    for (;;) {
      const t = await until<any>(() => task(created.body.id), (x) => { seen?.(x); return ['done', 'failed', 'cancelled'].includes(x.state) || (x.state === 'waiting' && /OK/.test(x.reason ?? '')); }, 1200);
      if (t.state !== 'waiting') return t;
      const ask = await m.send('GET', api(`/providers/tasks/${created.body.id}/test-run`));
      assert.equal(ask.status, 200, `waiting, but not for the test run: ${t.reason}`);
      assert.equal(ask.body.command, 'node --test calc/sum.test.mjs');
      assert.equal((await m.send('POST', api(`/providers/tasks/${created.body.id}/test-run`), {})).status, 200);
      await until<any>(() => task(created.body.id), (x) => x.state !== 'waiting', 400);
    }
  };
  try {
    writeCalc(join(m.home, 'workspace'));
    await m.send('PUT', api('/profile/privacy/default'), { value: 'cloud-allowed' });

    // Relay, set up like any provider: its address on this computer and a profile, then on (tier 2).
    assert.equal((await m.send('PUT', api('/providers/relay/config'), { config: { base_url: relay.url, profile: 'Builder', poll_ms: 50, busy_retry_s: 1 } })).status, 200);
    assert.equal((await m.send('POST', api('/providers/relay/enable'), { approved: true })).body.enabled, true);
    const checked = await m.send('POST', api('/providers/relay/check'));
    assert.equal(checked.body.health.state, 'ready', checked.body.health.words);
    assert.equal(checked.body.egress.receipt, 'local');

    // 1. Done and verified: Relay's worker edits it in a worktree; Nova copies it back after its own checks.
    const done = await run();
    assert.equal(done.state, 'done', done.reason);
    assert.ok(done.verification.ok);
    assert.deepEqual(done.verification.checks.map((c: { requirement: { kind: string } }) => c.requirement.kind).sort(), ['file_diff', 'test_result']);
    assert.ok(done.verification.checks.every((c: { ok: boolean }) => c.ok));
    assert.match(done.verification.checks.find((c: any) => c.requirement.kind === 'test_result').why, /Nova ran/);
    assert.equal(sum(), FIXED_SUM, 'the fix was copied back after verification');
    const relayRun = [...relay.runs.values()][0]!;
    const art = done.report.artifacts.find((a: { kind: string }) => a.kind === 'relay-run');
    assert.ok(art, 'the relay-run artifact is recorded');
    assert.equal(art.ref, relayRun.id);
    assert.equal(art.branch, `relay/${relayRun.id}`);
    assert.equal(art.worktree, relayRun.worktree.directory);
    assert.match(art.diff, /a \+ b/);
    assert.deepEqual((await m.get(api(`/receipts?task_id=${done.id}`))).map((r: { provider: string; egress: string }) => [r.provider, r.egress]), [['relay', 'local']]);
    assert.ok(relay.requests.filter((r: { method: string }) => r.method !== 'GET').every((r: { headers: Record<string, string> }) => r.headers['x-relay-client'] === 'relay-local'));

    // 2. A lying run: Relay's worker says it fixed it and changed nothing. Failed with the verifier's
    // reason, and nothing is copied back.
    relay.set({ mode: 'lying' });
    writeCalc(join(m.home, 'workspace'));
    const lie = await run();
    assert.equal(lie.state, 'failed');
    assert.match(String(lie.reason), /evidence didn.t hold up/i);
    assert.match(String(lie.reason), /test|change|diff/i);
    assert.equal(sum(), BROKEN_SUM, 'nothing unverified was copied back');

    // 3. Local-only is refused while Relay reports that its workers send the brief to Anthropic.
    relay.set({ mode: 'honest', workerEgress: 'remote:anthropic' });
    const remote = await m.send('POST', api('/providers/relay/check'));
    assert.equal(remote.body.egress.receipt, 'remote:anthropic');
    const before = relay.requests.length;
    const refused = await m.send('POST', api('/tasks'), calcTask('relay', { privacy_mode: 'local-only' }));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /sends data off your devices, and this task is local-only/);
    assert.equal(relay.requests.length, before, 'Relay never heard of it');

    // 4. Cancel mid-run reaches Relay.
    relay.set({ workerEgress: 'local', slowMs: 30_000 });
    await m.send('POST', api('/providers/relay/check'));
    writeCalc(join(m.home, 'workspace'));
    const slow = await m.send('POST', api('/tasks'), calcTask('relay'));
    assert.equal(slow.status, 201);
    const running = () => [...relay.runs.values()].find((r: { status: string }) => r.status === 'running');
    for (let i = 0; i < 400 && !running(); i++) await sleep(25);
    const live = running();
    assert.ok(live, 'Relay started a worker');
    assert.equal((await m.send('POST', api(`/tasks/${slow.body.id}/cancel`), {})).status, 200);
    for (let i = 0; i < 200 && !relay.cancels.includes(live.id); i++) await sleep(25);
    assert.ok(relay.cancels.includes(live.id), 'the cancel reached Relay');
    assert.equal((await task(slow.body.id)).state, 'cancelled');
    for (let i = 0; i < 200 && live.status !== 'cancelled'; i++) await sleep(25);
    assert.equal(live.status, 'cancelled');
    assert.equal(sum(), BROKEN_SUM);

    // 5. runtime_busy: the task waits with the reason, then Nova asks again and it completes.
    relay.set({ slowMs: 0, busy: 2 });
    writeCalc(join(m.home, 'workspace'));
    let busy = '';
    const after = await run({}, (t) => { if (/Relay is busy with another run/.test(t.reason ?? '')) busy = t.reason; });
    assert.match(busy, /Relay is busy with another run/, 'the task waited, saying why');
    assert.equal(after.state, 'done', after.reason);
    assert.equal(sum(), FIXED_SUM);

    // 6. The egress tripwire: nothing tried to leave this machine.
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'nothing tried to leave this machine');
  } finally {
    await stop(nova);
    await relay.close();
  }
});
