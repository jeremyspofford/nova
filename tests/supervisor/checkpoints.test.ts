// Checkpoints under the supervisor (M7 amendment §1), with real processes and real git tags: the
// supervisor takes an automatic checkpoint of the stopped home before it switches to a new release,
// and a restore asks the supervisor to restart Nova, so nobody restarts anything by hand; such a
// restart is neither a crash toward safe mode nor held to one a minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, cli, releaseRepo, scratch, supervise, until } from './support.ts';

test('before switching to a new release, the supervisor takes a checkpoint of the stopped home', async () => {
  const dir = scratch('nova-sup-cp-');
  const r = releaseRepo(dir);
  r.tag('v1.1.0', (root) => r.edit(root, 'package.json', '"version": "0.1.0"', '"version": "0.1.1"'));
  const s = await supervise({ dir, repo: r.repo });
  try {
    assert.equal((await api(s.base(), 'POST', '/api/v1/memory', { kind: 'fact', content: 'The shed key is on the blue hook.' })).status, 201);
    const d = await cli(s.dir, 'deploy', 'v1.1.0', '--confirm', 'v1.1.0');
    assert.equal(d.code, 0, d.out);
    const list = (await api(s.base(), 'GET', '/api/v1/resilience/checkpoints')).body.checkpoints as { kind: string; reason: string; nova_version: string }[];
    const cp = list.find((c) => c.reason === 'Before switching to release v1.1.0');
    assert.ok(cp, JSON.stringify(list));
    assert.equal(cp!.kind, 'auto');
    assert.equal(cp!.nova_version, '0.1.0', 'taken of the home as the release before it left it');
  } finally {
    await s.stop();
  }
});

test('a restore under the supervisor: it restarts Nova itself, twice in a row if asked, and that is no crash', async () => {
  const dir = scratch('nova-sup-restore-');
  const r = releaseRepo(dir);
  const s = await supervise({ dir, repo: r.repo });
  try {
    const memories = async () => { try { return ((await api(s.base(), 'GET', '/api/v1/memory')).body as { content: string }[]).map((m) => m.content).sort(); } catch { return null; } };
    assert.equal((await api(s.base(), 'POST', '/api/v1/memory', { kind: 'fact', content: 'Before both.' })).status, 201);
    const first = (await api(s.base(), 'POST', '/api/v1/resilience/checkpoints', { name: 'First' })).body;
    for (const round of [1, 2]) {
      assert.equal((await api(s.base(), 'POST', '/api/v1/memory', { kind: 'fact', content: `Undone, round ${round}.` })).status, 201);
      const pid = s.state().server.pid;
      const res = await api(s.base(), 'POST', `/api/v1/resilience/checkpoints/${first.id}/restore`, { confirm: true });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.restart.how, 'supervisor');
      await until(async () => s.state()?.server?.pid !== pid && s.state()?.mode === 'running' && JSON.stringify(await memories()) === JSON.stringify(['Before both.']), `round ${round}: Nova back with the checkpoint’s data:\n${s.out.join('')}`);
    }
    const st = s.state();
    assert.equal(st.mode, 'running');
    assert.equal(st.safe_mode, null);
    assert.equal(st.server.restarts, 0, 'a restart to finish a restore isn’t counted as a crash');
  } finally {
    await s.stop();
  }
});
