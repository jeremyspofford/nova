// The supervisor driver (M10e gate, docs/plans/M10e.md): a second, plain-program service (the
// stand-in, scripts/stand-ins/fake-service.js) is deployed alongside, promoted, soaked and rolled
// back, by the console's own rules; and the console runs from its definition. Each test's
// supervisor, homes and ports are its own; every process it started is checked gone at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { consoleDefinition, type ServiceDefinition } from '../../src/core/index.ts';
import { alive, call, freePort, standIn, standInFile, whoami } from '../support/services.ts';
import { git } from './fake.ts';
import { until } from './support.ts';
import { SERVICE_TIMINGS, supervised } from './services-support.ts';

const statusOf = (s: Supervisor, service = 'stand-in') => s.manager.status().find((x) => x.service === service)!;
const versionOf = (s: Supervisor, version: string, service = 'stand-in') => statusOf(s, service).versions.find((v) => v.version === version)!;
const promote = (s: Supervisor, v: string, service = 'stand-in') => s.manager.promote(service, v, `${service}@${v}`);

test('deployed alongside with no traffic, promoted on the typed word, soaked, and the old slot removed after the soak', async () => {
  const h = await supervised('nova-svc-life-');
  const { s } = h;
  try {
    const port = await freePort();
    const r1 = await s.manager.deploy(standIn({ version: '1.0.0', port, soak_s: 2, flags: ['--child'] }));
    assert.equal(r1.ok, true, r1.said);
    assert.equal(versionOf(s, '1.0.0').status, 'ready');
    assert.equal(await whoami(port), null, 'deploying gave it no traffic: nothing answers on the stable port');
    assert.equal((await promote(s, '1.0.0')).ok, true);
    const one = (await whoami(port))!;
    assert.equal(one.version, '1.0.0');
    assert.ok(one.home.startsWith(join(h.dir, 'sup', 'services', 'stand-in')), 'a HOME of its own, never the person’s');

    const r2 = await s.manager.deploy(standIn({ version: '2.0.0', port, soak_s: 2 }));
    assert.equal(r2.ok, true, r2.said);
    const preview = versionOf(s, '2.0.0').ports!.api!;
    assert.notEqual(preview, port);
    assert.equal((await whoami(preview))!.version, '2.0.0', 'it runs alongside on a port of its own');
    assert.equal((await whoami(port))!.version, '1.0.0', 'while the stable port still serves the live version');

    // A client that keeps its connection open (fetch does) is on 1.0.0 now...
    const kept = async () => (await (await fetch(`http://127.0.0.1:${port}/whoami`)).json() as { version: string }).version;
    assert.equal(await kept(), '1.0.0');
    const p2 = await promote(s, '2.0.0');
    assert.equal(p2.ok, true, p2.said);
    assert.equal((await whoami(port))!.version, '2.0.0');
    // ...and once 1.0.0 has stopped, its next request reaches 2.0.0, not a closed connection.
    await until(() => !alive(one.pid), 'the old version to stop');
    assert.equal(await kept(), '2.0.0');
    const st = statusOf(s);
    assert.deepEqual([st.live, st.previous], ['2.0.0', '1.0.0']);
    assert.equal(versionOf(s, '1.0.0').status, 'kept');
    assert.equal(versionOf(s, '1.0.0').pid, null, 'the kept version is stopped');
    await until(() => !alive(one.pid), 'the old version to stop');
    // Its whole process group went with it: the child it started too.
    const child = Number(readFileSync(join(h.dir, 'sup', 'services', 'stand-in', 'state', 'default', 'child-1.0.0.pid'), 'utf8'));
    await until(() => !alive(child), 'the old version’s child process to stop');
    assert.ok(existsSync(join(h.dir, 'sup', 'services', 'stand-in', 'state', 'default', 'child-1.0.0.sigterm')), 'the group was asked to stop (SIGTERM) before it was made to');
    assert.ok(s.services.slots('stand-in').includes('1.0.0'), 'its slot is kept for the soak');

    // After the soak, the old slot goes, and the record says so.
    await until(() => statusOf(s).previous === null, 'the soak to end', 10_000);
    assert.equal(versionOf(s, '1.0.0').status, 'removed');
    assert.match(versionOf(s, '1.0.0').said!, /soak ended/);
    assert.ok(!s.services.slots('stand-in').includes('1.0.0'));
    assert.ok(statusOf(s).history.some((x) => x.outcome === 'soaked'));
    assert.equal((await whoami(port))!.version, '2.0.0');
    // The state file says what runs, for the console and `services`.
    assert.equal(JSON.parse(readFileSync(join(h.dir, 'sup', 'state.json'), 'utf8')).services[0].live, '2.0.0');
  } finally {
    await h.stop();
  }
});

test('a version that fails its contract tests is never offered: nothing moves, and the problem says so', async () => {
  const h = await supervised('nova-svc-contract-fail-');
  const { s } = h;
  try {
    const port = await freePort();
    await s.manager.deploy(standIn({ version: '1.0.0', port }));
    await promote(s, '1.0.0');
    const r = await s.manager.deploy(standIn({ version: '1.1.0', port, flags: ['--no-contract'] }));
    assert.equal(r.ok, false);
    assert.match(r.said, /Stopped at tests: http:\/contract: \/contract answered 404/);
    assert.equal(versionOf(s, '1.1.0').status, 'failed');
    assert.equal(versionOf(s, '1.1.0').pid, null, 'and it was stopped');
    const p = await promote(s, '1.1.0');
    assert.equal(p.ok, false);
    assert.match(p.said, /isn’t ready to promote/);
    assert.equal((await whoami(port))!.version, '1.0.0');
    await until(async () => (await h.told()).some((x) => x.playbook === 'service-stopped'), 'the problem');
    assert.match((await h.told()).find((x) => x.playbook === 'service-stopped')!.said, /never offered. 1.0.0 keeps running/);
  } finally {
    await h.stop();
  }
});

test('a version whose health fails in its canary is rolled back by itself, and the problem says so', async () => {
  const h = await supervised('nova-svc-canary-', { timings: { canaryMs: 3000 } });
  const { s } = h;
  try {
    const port = await freePort();
    await s.manager.deploy(standIn({ version: '1.0.0', port }));
    await promote(s, '1.0.0');
    const before = (await whoami(port))!.pid;
    // Healthy long enough to pass its checks alongside, then sick: in the canary window.
    assert.equal((await s.manager.deploy(standIn({ version: '2.0.0', port, flags: ['--healthy-for-ms', '1500'] }))).ok, true);
    const r = await promote(s, '2.0.0');
    assert.equal(r.ok, false);
    assert.match(r.said, /Rolled back: \/health answered 500/);
    assert.equal((await whoami(port))!.version, '1.0.0');
    assert.equal((await whoami(port))!.pid, before, 'the live version ran on throughout (full: both ran)');
    assert.equal(versionOf(s, '2.0.0').status, 'rolled_back');
    assert.deepEqual([statusOf(s).live, statusOf(s).previous], ['1.0.0', null]);
    await until(async () => (await h.told()).some((x) => x.playbook === 'service-rolled-back'), 'the problem');
  } finally {
    await h.stop();
  }
});

test('a version that fails during its soak goes back in one step, with nothing installed or downloaded', async () => {
  const h = await supervised('nova-svc-soak-');
  const { s } = h;
  try {
    const port = await freePort();
    const v1file = standInFile(join(h.dir, 'artifacts', 'v1'));
    await s.manager.deploy(standIn({ version: '1.0.0', port, file: v1file, soak_s: 600 }));
    await promote(s, '1.0.0');
    assert.equal((await s.manager.deploy(standIn({ version: '2.0.0', port, soak_s: 600, flags: ['--healthy-for-ms', '3500'] }))).ok, true);
    assert.equal((await promote(s, '2.0.0')).ok, true, 'it passed its canary');
    assert.equal((await whoami(port))!.version, '2.0.0');
    // 1.0.0's program is gone from where it came from: going back can only use its kept slot.
    rmSync(v1file);
    const slotFile = join(h.dir, 'sup', 'services', 'stand-in', 'versions', '1.0.0', 'fake-service.js');
    const before = readFileSync(slotFile);
    await until(async () => (await whoami(port))?.version === '1.0.0', 'the soak’s rollback', 15_000);
    assert.deepEqual(readFileSync(slotFile), before, 'the kept slot ran as it was');
    const st = statusOf(s);
    assert.deepEqual([st.live, st.previous], ['1.0.0', null]);
    assert.equal(versionOf(s, '2.0.0').status, 'rolled_back');
    assert.match(versionOf(s, '2.0.0').said!, /failed 2 health checks in a row during its soak/);
    assert.equal(versionOf(s, '1.0.0').status, 'live');
    await until(async () => (await h.told()).some((x) => x.playbook === 'service-rolled-back' && /from the slot kept for it/.test(x.said)), 'the problem');
  } finally {
    await h.stop();
  }
});

test('a crash is restarted with a growing wait; three within the window and the service is held', async () => {
  const h = await supervised('nova-svc-crash-');
  const { s } = h;
  try {
    const port = await freePort();
    await s.manager.deploy(standIn({ version: '1.0.0', port }));
    await promote(s, '1.0.0');
    let pid = (await whoami(port))!.pid;
    process.kill(pid, 'SIGKILL');
    await until(async () => { const w = await whoami(port); return !!w && w.pid !== pid; }, 'the restart');
    await until(async () => (await h.told()).some((x) => x.playbook === 'service-crashed'), 'the crash problem');
    for (let i = 0; i < 2; i++) {
      await until(async () => !!(await whoami(port)), 'it to answer');
      pid = (await whoami(port))!.pid;
      process.kill(pid, 'SIGKILL');
      await until(() => !alive(pid), 'it to stop');
    }
    await until(() => !!statusOf(s).held, 'held');
    assert.match(statusOf(s).held!.reason, /stopped 3 times within 60 s/);
    assert.equal(await whoami(port), null, 'nothing answers while it is held');
    await until(async () => (await h.told()).some((x) => x.playbook === 'service-held'), 'the held problem');
    // The console is untouched by a service's crashes.
    assert.equal(s.state.mode, 'running');
  } finally {
    await h.stop();
  }
});

test('a rollback the person asks for wants the word, and goes back to the kept version', async () => {
  const h = await supervised('nova-svc-rollback-');
  const { s } = h;
  try {
    const port = await freePort();
    for (const v of ['1.0.0', '2.0.0']) { await s.manager.deploy(standIn({ version: v, port })); await promote(s, v); }
    assert.equal((await whoami(port))!.version, '2.0.0');
    assert.equal((await s.manager.rollback('stand-in', 'yes')).ok, false);
    assert.equal((await whoami(port))!.version, '2.0.0');
    const r = await s.manager.rollback('stand-in', 'rollback');
    assert.equal(r.ok, true, r.said);
    assert.equal((await whoami(port))!.version, '1.0.0');
    assert.equal(statusOf(s).history[0]!.outcome, 'went back');
  } finally {
    await h.stop();
  }
});

test('copy runs the new version on a copy of the state, then on the real one after the switch; none starts only at the switch', async () => {
  const h = await supervised('nova-svc-modes-');
  const { s } = h;
  try {
    const port = await freePort();
    const real = join(h.dir, 'sup', 'services', 'stand-in', 'state', 'data');
    await s.manager.deploy(standIn({ version: '1.0.0', port, alongside: 'copy', state: true }));
    await promote(s, '1.0.0');
    assert.equal((await call(port, '/state/note', { method: 'POST', body: 'written by 1.0.0' }))!.status, 200);
    // 2.0.0 writes a file as it starts: alongside, that lands in its copy, not in the real state.
    await s.manager.deploy(standIn({ version: '2.0.0', port, alongside: 'copy', state: true, flags: ['--child'] }));
    assert.equal(versionOf(s, '2.0.0').status, 'ready');
    assert.equal(versionOf(s, '2.0.0').pid, null, 'run on a copy, it stopped after its checks');
    assert.ok(!existsSync(join(real, 'child-2.0.0.pid')), 'what it wrote alongside stayed in its copy');
    assert.ok(existsSync(join(h.dir, 'sup', 'services', 'stand-in', 'scratch', '2.0.0', 'child-2.0.0.pid')));
    await promote(s, '2.0.0');
    assert.equal((await call(port, '/state/note'))!.body.value, 'written by 1.0.0', 'after the switch it runs on the real state');

    await s.manager.deploy(standIn({ version: '3.0.0', port, alongside: 'none', state: true }));
    assert.equal(versionOf(s, '3.0.0').status, 'ready');
    assert.equal(versionOf(s, '3.0.0').ports, null, 'it can’t run twice: not started yet');
    assert.equal((await whoami(port))!.version, '2.0.0');
    assert.equal((await promote(s, '3.0.0')).ok, true);
    assert.equal((await whoami(port))!.version, '3.0.0');
  } finally {
    await h.stop();
  }
});

test('the services run again after the supervisor restarts, on the same stable port', async () => {
  const h = await supervised('nova-svc-resume-');
  const port = await freePort();
  await h.s.manager.deploy(standIn({ version: '1.0.0', port }));
  await promote(h.s, '1.0.0');
  const first = (await whoami(port))!.pid;
  await h.stop();
  assert.equal(await whoami(port), null);
  const again = await supervised('', { dir: h.dir, repo: h.repo });
  try {
    await until(async () => (await whoami(port))?.version === '1.0.0', 'the service to run again');
    assert.notEqual((await whoami(port))!.pid, first);
  } finally {
    await again.stop();
  }
});

test('the supervisor driver’s plan, as a snapshot, and what it refuses in plain words', async () => {
  const h = await supervised('nova-svc-plan-');
  const { s } = h;
  try {
    const def: ServiceDefinition = { ...standIn({ version: '1.4.2', port: 18_090, soak_s: 86_400 }) };
    def.artifact = { program: { [Object.keys(def.artifact.program!)[0]!]: { url: 'file:///opt/stand-in/fake-service.js', sha256: 'ab'.repeat(32), command: ['node', 'fake-service.js'] } } };
    const p = s.manager.plan(def);
    assert.ok(p.ok);
    assert.deepEqual(p.plan, {
      driver: 'supervisor', service: 'stand-in', version: '1.4.2', tier: 2, where: 'this hub', ok: true, refused: [],
      steps: [
        { step: 'install', said: 'Copy fake-service.js from its file: address into a slot of its own for 1.4.2, checking its SHA-256 (abababababab…). Nothing is downloaded.' },
        { step: 'alongside', said: 'Start it next to the live version, on loopback ports of its own, with no traffic (full).' },
        { step: 'tests', said: 'Contract tests on its own port: GET /contract, each answering 2xx.' },
        { step: 'health', said: 'GET /health answers 2xx 3 times in a row.' },
        { step: 'approval', said: 'Promotion asks first (tier 2).' },
        { step: 'canary', said: 'Point the stable port (api 127.0.0.1:18090) at it, then watch its health. A failure points it back by itself.' },
        { step: 'promote', said: 'Stop the old version and keep its slot for 86400 s. A failure in that time goes back in one step, with nothing installed.' },
      ],
    });
    const console = s.manager.plan(consoleDefinition({ version: 'v2.0.0', port: 4317 }));
    assert.ok(console.ok);
    assert.deepEqual(console.plan.steps.map((x) => x.step), ['prepare', 'tests', 'sandbox', 'smoke', 'approval', 'switch', 'canary', 'promote']);
    assert.equal(console.plan.tier, 3);

    const refusals: [Partial<ServiceDefinition>, RegExp][] = [
      [{ artifact: { image: `registry.example/x@sha256:${'c'.repeat(64)}` } }, /only as a container image/],
      [{ secrets: ['secret://stand-in/token'] }, /needs secrets/],
      [{ placement: { mode: 'pinned', device: 'a-laptop' } }, /pinned to a-laptop/],
      [{ placement: { mode: 'floating', replicas: 3 } }, /3 replicas/],
      [{ resources: { memory_mb: 1_000_000 } }, /more than this computer has/],
      [{ artifact: { program: { [Object.keys(def.artifact.program!)[0]!]: { url: 'https://example.invalid/x.js', sha256: 'ab'.repeat(32), command: ['node', 'x.js'] } } } }, /at a web address/],
    ];
    for (const [extra, want] of refusals) {
      const r = s.manager.plan({ ...def, ...extra });
      assert.ok(r.ok && !r.plan.ok, String(want));
      assert.match(r.plan.refused.join(' '), want);
      const d = await s.manager.deploy({ ...def, ...extra, version: `9.${refusals.findIndex((x) => x[1] === want)}.0` });
      assert.equal(d.ok, false);
    }
    // A program whose bytes aren't the ones pinned is never installed.
    const bad = standIn({ version: '5.0.0', port: await freePort() });
    const prog = Object.values(bad.artifact.program!)[0]!;
    prog.sha256 = '0'.repeat(64);
    const r = await s.manager.deploy(bad);
    assert.match(r.said, /SHA-256 is .* not the 000000000000… its definition pins. Nothing was installed/);
    assert.ok(!s.services.slots('stand-in').includes('5.0.0'));
  } finally {
    await h.stop();
  }
});

test('the console runs from its definition: its command and its health check are the definition’s', async () => {
  // The definition names another script and another health path; the stand-in console answers
  // health only there. Were either taken from anywhere else, Nova wouldn't start, or would be
  // restarted for failing its health.
  const dir = (await import('./support.ts')).scratch('nova-svc-console-');
  const { fakeRepo } = await import('./fake.ts');
  const repo = fakeRepo(dir);
  const server = readFileSync(join(repo, 'src', 'server.js'), 'utf8');
  writeFileSync(join(repo, 'src', 'console.js'), server.replace("if (u === '/api/v1/health')", "if (u === '/console-health')").replace("console.log('Nova is ready", "console.log('alt console; Nova is ready"));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'another console script');
  const h = await supervised('', {
    dir, repo,
    make: (d, rp) => new Supervisor({
      dir: join(d, 'sup'), home: join(d, 'home'), repo: rp, base: rp, env: { PATH: process.env.PATH ?? '', NOVA_PORT: '0' }, tests: [process.execPath, '-e', ''], timings: SERVICE_TIMINGS,
      consoleDefinition: (o) => { const c = consoleDefinition(o); c.artifact.release!.command = ['node', 'src/console.js']; c.health.http = '/console-health'; return c; },
    }),
  });
  try {
    const pid = h.s.server!.pid;
    await until(() => !!h.s.state.health.last_ok_at, 'a healthy answer');
    const checks = h.s.state.health.last_check_at;
    await until(() => h.s.state.health.last_check_at !== checks, 'another check');
    assert.equal(h.s.state.health.failing, 0);
    assert.equal(h.s.server!.pid, pid, 'never restarted');
    assert.equal(h.s.state.server.restarts, 0);
    const c = h.s.manager.status().find((x) => x.service === 'nova-console')!;
    assert.equal(c.live, 'base');
    assert.equal(c.health.ok, true);
  } finally {
    await h.stop();
  }
});
