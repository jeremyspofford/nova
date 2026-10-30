// Chaos pass, the hub (M7 plan §3), with real processes under the supervisor: a crash is restarted
// after a wait that doubles, a server that stops answering is restarted, and a crash loop goes to
// safe mode: held, the reason written (state, database, a page at Nova's address) and offered a
// way on. A hub that is dead for good (no supervisor can bring it back) is M4's failover: the
// standby takes over, and says so with its playbook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { freePort } from '../acceptance/m4c-support.ts';
import { api, cli, releaseRepo, scratch, sleep, supervise, until } from '../supervisor/support.ts';
import { pair } from './mesh.ts';
import { problemWith, until as waitFor } from './support.ts';

test('a dead hub: the standby takes over (failover turned on), and the problem says what happened, with its playbook', async () => {
  const p = await pair({ failoverAfterS: 1 });
  try {
    p.core.start();
    p.h.core.memory.remember({ kind: 'fact', content: 'The meter is read on the 5th.', recorded_by: 'person' });
    await waitFor(() => p.core.mesh.sync.cursor(), (c) => c >= p.h.core.mesh.sync.head(), 15_000, 'the standby to catch up');
    await p.h.stop();
    p.link.cut();
    await waitFor(() => p.core.mesh.role.role(), (r) => r === 'hub', 20_000, 'the standby to take over');
    const prob = await problemWith(p.core, 'hub-failover');
    assert.match(prob.message, /making itself the hub/);
    assert.ok(p.core.memory.list().some((m) => m.content === 'The meter is read on the 5th.'), 'what it had copied is here');
  } finally {
    await p.stop();
  }
});

test('a crash is restarted with a growing wait, and told as a problem with what the supervisor did', async () => {
  const dir = scratch('nova-sup-crash-');
  const r = releaseRepo(dir);
  const s = await supervise({ dir, repo: r.repo, timings: { backoffMs: 300 } });
  try {
    const first = s.state().server.pid;
    process.kill(first, 'SIGKILL');
    await until(() => s.state()?.mode === 'running' && s.state().server.pid && s.state().server.pid !== first, 'the first restart');
    const a = s.state();
    assert.equal(a.server.restarts, 1);
    const wait1 = Date.parse(a.server.started_at) - Date.parse(a.server.last_exit.at);
    assert.ok(wait1 >= 250, `waited ${wait1} ms`);
    assert.equal(a.server.last_exit.signal, 'SIGKILL');

    const second = a.server.pid;
    process.kill(second, 'SIGKILL');
    await until(() => s.state()?.mode === 'running' && s.state().server.pid && s.state().server.pid !== second, 'the second restart');
    const b = s.state();
    const wait2 = Date.parse(b.server.started_at) - Date.parse(b.server.last_exit.at);
    assert.ok(wait2 >= 550, `the wait doubled: ${wait1} → ${wait2} ms`);

    // Told once (one open problem per kind), with the supervisor's repair recorded on it.
    await until(async () => (await api(s.base(), 'GET', '/api/v1/problems?open=1')).body?.some((p: { source: string }) => p.source === 'supervisor'), 'the crash problem');
    const p = (await api(s.base(), 'GET', '/api/v1/problems?open=1')).body.filter((x: { source: string }) => x.source === 'supervisor');
    assert.equal(p.length, 1, JSON.stringify(p));
    assert.match(p[0].message, /stopped unexpectedly .* started it again/);
    const pb = (await api(s.base(), 'GET', `/api/v1/problems/${p[0].id}/playbook`)).body;
    assert.equal(pb.id, 'server-crashed');
    assert.equal(pb.repairs[0].name, 'restart-server');
    assert.equal(pb.repairs[0].ok, true);
  } finally {
    await s.stop();
  }
});

test('a server that stops answering is restarted', async () => {
  const dir = scratch('nova-sup-hang-');
  const r = releaseRepo(dir);
  const s = await supervise({ dir, repo: r.repo });
  try {
    const pid = s.state().server.pid;
    // Frozen: alive, but answering nothing.
    process.kill(pid, 'SIGSTOP');
    await until(() => s.state()?.mode === 'running' && s.state().server.pid && s.state().server.pid !== pid, 'a restart of the frozen server', 30_000);
    await until(async () => (await api(s.base(), 'GET', '/api/v1/problems?open=1')).body?.some((p: { message: string }) => /stopped answering its health checks/.test(p.message)), 'the problem');
    assert.equal((await api(s.base(), 'GET', '/api/v1/health')).status, 200);
  } finally {
    try { process.kill(s.state()?.server?.pid ?? 0, 'SIGCONT'); } catch { /* gone */ }
    await s.stop();
  }
});

test('a crash loop goes to safe mode: held, the reason written down, the page says what to run; recover tries again', async () => {
  const dir = scratch('nova-sup-loop-');
  const r = releaseRepo(dir);
  // A first, good run makes the home and its database.
  const first = await supervise({ dir, repo: r.repo });
  await first.stop();
  // Then a setting Nova refuses to start with: every start ends at once.
  const port = await freePort();
  const s = await supervise({ dir, repo: r.repo, wait: false, env: { NOVA_PORT: String(port), NOVA_MESH_URL: 'http://127.0.0.1:1' } });
  try {
    await until(() => s.state()?.mode === 'safe_mode', 'safe mode', 30_000);
    const st = s.state();
    assert.match(st.safe_mode.reason, /stopped 3 times within \d+ s/);
    assert.match(st.safe_mode.output, /serve other devices over plain HTTP/);
    assert.equal(st.server.pid, null, 'the server is held, not running');
    await sleep(1000);
    assert.equal(s.state().mode, 'safe_mode', 'and it stays held');

    // Nova's address answers with the reason.
    const h = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(h.status, 503);
    assert.match((await h.json()).safe_mode.reason, /stopped 3 times/);
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /Nova is in safe mode/);
    assert.match(page, /node src\/supervisor\/main\.ts recover/);

    // The problem is in the database, with its playbook, for when Nova runs again.
    const db = new DatabaseSync(join(s.home, 'nova.db'), { readOnly: true });
    const row = db.prepare(`SELECT p.message, pp.playbook FROM problem p JOIN problem_playbook pp ON pp.problem_id = p.id WHERE pp.playbook = 'safe-mode'`).get() as { message: string; playbook: string } | undefined;
    db.close();
    assert.ok(row, 'a safe-mode problem is recorded');
    assert.match(row.message, /held in safe mode/);

    const status = await cli(s.dir, 'status');
    assert.match(status.out, /safe mode/);
    // Recover tries again; the cause is still there, so it comes back to safe mode.
    const rec = await cli(s.dir, 'recover');
    assert.equal(rec.code, 1);
    await until(() => s.state()?.mode === 'safe_mode', 'safe mode again', 30_000);
  } finally {
    await s.stop();
  }
});
