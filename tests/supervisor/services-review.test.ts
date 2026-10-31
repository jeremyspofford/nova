// The supervisor driver against the review of PR #247 (M10e): one test per finding, each named by
// it. The stand-in service (scripts/stand-ins/fake-service.js) has a flag for each misbehaviour; every
// test checks what the stable port really answers, and ends every process it made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { ServerProcess } from '../../src/supervisor/server.ts';
import { platformKey, type ServiceDefinition } from '../../src/core/index.ts';
import { alive, call, freePort, sha256, standIn, whoami, STAND_IN } from '../support/services.ts';
import { until, sleep } from './support.ts';
import { SERVICE_TIMINGS, deploy, supervised } from './services-support.ts';

const statusOf = (s: Supervisor, service = 'stand-in') => s.manager.status().find((x) => x.service === service)!;
const versionOf = (s: Supervisor, version: string, service = 'stand-in') => statusOf(s, service).versions.find((v) => v.version === version)!;
const promote = (s: Supervisor, v: string, service = 'stand-in') => s.manager.promote(service, v, `${service}@${v}`);
async function live(s: Supervisor, def: ServiceDefinition) {
  const d = await deploy(s, def);
  assert.equal(d.ok, true, d.said);
  const p = await promote(s, def.version, def.service);
  assert.equal(p.ok, true, p.said);
}

// ---- B1: the command runs the pinned program and nothing else ------------------------------------------

test('B1: the driver itself refuses a command that doesn’t start its pinned program, and never runs it', async () => {
  const h = await supervised('nova-rev-b1-');
  const { s } = h;
  const marker = join(h.dir, 'ran');
  try {
    const decoy = join(h.dir, 'decoy.txt');
    writeFileSync(decoy, 'just text\n');
    const port = await freePort();
    const base = (version: string, command: string[]): ServiceDefinition => ({ ...standIn({ version, port }), artifact: { program: { [platformKey()]: { url: pathToFileURL(decoy).href, sha256: sha256(decoy), command } } } });
    const commands = [
      ['../../../../../../../../../../usr/bin/env', 'node', STAND_IN],
      ['node', '--input-type=module', '-e', `import('node:fs').then((f) => f.writeFileSync(${JSON.stringify(marker)}, 'ran'))`],
      ['sh', '-c', `echo ran > ${marker}`],
      ['/usr/bin/env', 'node', STAND_IN],
    ];
    for (const [i, command] of commands.entries()) {
      // Handed straight to the driver, past the manager's validator.
      const r = await s.services.apply(base(`1.0.${i}`, command));
      assert.equal(r.ok, false, JSON.stringify(command));
      assert.match(r.said, /A program starts as itself|no interpreter option or inline code/);
    }
    await sleep(300);
    assert.throws(() => readFileSync(marker), 'nothing ran');
    assert.deepEqual(s.services.pids(), []);
  } finally {
    await h.stop();
  }
});

test('B1: a program changed or replaced by a link in its slot is never started again', async () => {
  const h = await supervised('nova-rev-b1-slot-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    const exe = join(h.dir, 'sup', 'services', 'stand-in', 'versions', '1.0.0', 'bin', 'fake-service.js');
    // Something swaps the installed program for a link to another file (one that would run fine).
    rmSync(exe);
    symlinkSync(STAND_IN, exe);
    const pid = (await whoami(port))!.pid;
    process.kill(pid, 'SIGKILL');
    await until(() => !!statusOf(s).held, 'held, not restarted');
    assert.match(statusOf(s).held!.reason, /isn’t a regular file any more\. It wasn’t started/);
    assert.equal(await whoami(port), null);
    // Its bytes changed instead: refused the same way, by the pinned SHA-256.
    rmSync(exe);
    writeFileSync(exe, readFileSync(STAND_IN, 'utf8').replace('sick = false', 'sick = false;'));
    const r = await s.manager.recover('stand-in');
    assert.equal(r.ok, false);
    assert.match(r.said, /SHA-256 is .*not the pinned .*: it was changed\. It wasn’t started/);
  } finally {
    await h.stop();
  }
});

// ---- B2: a failed switch tells the truth, and the live version keeps its stable port ----------------------

test('B2: a one-writer version that fails to start: the old one is running again and answers on its stable port', async () => {
  const h = await supervised('nova-rev-b2a-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port, alongside: 'copy' }));
    // Fine on a copy of its state at deploy; refuses the real one at the switch.
    await deploy(s, standIn({ version: '2.0.0', port, alongside: 'copy', flags: ['--refuse-real-state'] }));
    const r = await promote(s, '2.0.0');
    assert.equal(r.ok, false);
    assert.match(r.said, /2\.0\.0 didn’t start: .*refusing the real state.* 1\.0\.0 is running again and answers on its stable port\./s);
    assert.equal((await whoami(port))!.version, '1.0.0', 'the stable port answers');
    assert.equal(statusOf(s).live, '1.0.0');
    assert.equal(statusOf(s).held, null);
  } finally {
    await h.stop();
  }
});

test('B2: when the old version doesn’t start again either, the service is held, a problem says so, and nothing is claimed', async () => {
  const h = await supervised('nova-rev-b2b-');
  const { s } = h;
  try {
    const port = await freePort();
    // 1.0.0 starts once on its real state; a second start there fails (a stale lock).
    await live(s, standIn({ version: '1.0.0', port, alongside: 'copy', flags: ['--start-once'] }));
    await deploy(s, standIn({ version: '2.0.0', port, alongside: 'copy', flags: ['--refuse-real-state'] }));
    const r = await promote(s, '2.0.0');
    assert.equal(r.ok, false);
    assert.match(r.said, /1\.0\.0 didn’t start again either \(.*stale lock.*\), so nothing serves stand-in: it is held\./s);
    assert.doesNotMatch(r.said, /is running again/);
    assert.ok(statusOf(s).held, 'held');
    assert.equal(await whoami(port), null, 'and indeed nothing answers');
    await until(async () => (await h.told()).some((p) => p.playbook === 'service-held'), 'the held problem');
  } finally {
    await h.stop();
  }
});

test('B2: a version that moves its stable port and fails at the switch leaves the old port answering, and the new one closed', async () => {
  const h = await supervised('nova-rev-b2c-');
  const { s } = h;
  try {
    const p1 = await freePort();
    const p2 = await freePort();
    await live(s, standIn({ version: '1.0.0', port: p1 }));
    await deploy(s, standIn({ version: '2.0.0', port: p2, alongside: 'shadow', flags: ['--refuse-real-state'] }));
    const r = await promote(s, '2.0.0');
    assert.equal(r.ok, false);
    assert.equal((await whoami(p1))!.version, '1.0.0', 'the old stable port answers');
    assert.equal(await whoami(p2), null, 'the new one isn’t left open');
    assert.deepEqual(statusOf(s).stable, { api: p1 });
  } finally {
    await h.stop();
  }
});

test('B2: a version that moves its stable port and fails its canary while the old one still runs: the old port answers throughout', async () => {
  const h = await supervised('nova-rev-b2c2-', { timings: { canaryMs: 3000 } });
  const { s } = h;
  try {
    const p1 = await freePort();
    const p2 = await freePort();
    await live(s, standIn({ version: '1.0.0', port: p1 }));
    const pid = (await whoami(p1))!.pid;
    await deploy(s, standIn({ version: '2.0.0', port: p2, flags: ['--healthy-for-ms', '1500'] }));
    // During the switch, the old port is never closed: it answers the old version all along.
    let dropped = 0;
    let probing = true;
    const probe = (async () => { while (probing) { if ((await whoami(p1))?.version !== '1.0.0') dropped++; await sleep(100); } })();
    const r = await promote(s, '2.0.0');
    probing = false;
    await probe;
    assert.equal(r.ok, false);
    assert.match(r.said, /1\.0\.0 kept running and answers on its stable port/);
    assert.equal((await whoami(p1))!.pid, pid, 'the same process');
    assert.equal(await whoami(p2), null);
    assert.equal(dropped, 0, 'not one request on the old port went unanswered during the failed switch');
  } finally {
    await h.stop();
  }
});

test('B2: a version that can’t run twice fails its checks at the switch: the old one answers again', async () => {
  const h = await supervised('nova-rev-b2d-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port, alongside: 'none' }));
    await deploy(s, standIn({ version: '2.0.0', port, alongside: 'none', flags: ['--no-contract'] }));
    const r = await promote(s, '2.0.0');
    assert.equal(r.ok, false);
    assert.match(r.said, /didn’t pass its checks at the switch.*1\.0\.0 is running again and answers on its stable port/s);
    assert.equal((await whoami(port))!.version, '1.0.0');
  } finally {
    await h.stop();
  }
});

test('B2: a one-writer version that fails its canary: the old one is started again from its slot and answers', async () => {
  const h = await supervised('nova-rev-b2e-', { timings: { canaryMs: 3000 } });
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port, alongside: 'copy' }));
    await deploy(s, standIn({ version: '2.0.0', port, alongside: 'copy', flags: ['--healthy-for-ms', '1200'] }));
    const r = await promote(s, '2.0.0');
    assert.equal(r.ok, false);
    assert.match(r.said, /Rolled back: .*1\.0\.0 is running again and answers on its stable port\./s);
    assert.equal((await whoami(port))!.version, '1.0.0');
  } finally {
    await h.stop();
  }
});

test('B2 (minor): a version that renames its port, same number, can be promoted', async () => {
  const h = await supervised('nova-rev-rename-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    const renamed = standIn({ version: '1.1.0', port, extra: { ports: [{ name: 'web', port }] } });
    await live(s, renamed);
    assert.equal((await whoami(port))!.version, '1.1.0');
    assert.deepEqual(statusOf(s).stable, { web: port });
  } finally {
    await h.stop();
  }
});

test('minor: shadow is one writer at the switch: the old version stops before the new one runs on the real state', async () => {
  const h = await supervised('nova-rev-shadow-');
  const { s } = h;
  try {
    const port = await freePort();
    // Each refuses to start on its real state while another copy runs there.
    await live(s, standIn({ version: '1.0.0', port, flags: ['--exclusive-state'] }));
    await deploy(s, standIn({ version: '2.0.0', port, alongside: 'shadow', flags: ['--exclusive-state'] }));
    const r = await promote(s, '2.0.0');
    assert.equal(r.ok, true, r.said);
    assert.equal((await whoami(port))!.version, '2.0.0');
  } finally {
    await h.stop();
  }
});

// ---- S1: the soak's end can't race a rollback ----------------------------------------------------------------

test('S1: a soak that ends while a rollback is stopping a slow version doesn’t take the kept slot from under it', async () => {
  const h = await supervised('nova-rev-s1-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    // 2.0.0 ignores SIGTERM: stopping it takes the whole grace period (5 s), past its 2 s soak.
    await live(s, standIn({ version: '2.0.0', port, soak_s: 2, flags: ['--slow-stop'] }));
    const r = await s.manager.rollback('stand-in', 'rollback');
    assert.equal(r.ok, true, r.said);
    assert.equal((await whoami(port))!.version, '1.0.0');
    assert.equal(statusOf(s).held, null);
    await sleep(500);
    assert.equal(versionOf(s, '1.0.0').status, 'live', 'its slot wasn’t removed by the soak');
    assert.ok(s.services.slots('stand-in').includes('1.0.0'));
  } finally {
    await h.stop();
  }
});

// ---- S2: a crash and a deploy don't collide ------------------------------------------------------------------

test('S2: a crash, then a deploy during the restart wait: the restart waits its turn, and the service isn’t held', async () => {
  // Checks a second apart: the deploy takes longer than the restart wait, so the two meet.
  const h = await supervised('nova-rev-s2a-', { timings: { backoffMs: 1000, maxBackoffMs: 4000, probeEveryMs: 1000 } });
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    const pid = (await whoami(port))!.pid;
    process.kill(pid, 'SIGKILL');
    await sleep(150);
    assert.equal((await deploy(s, standIn({ version: '1.1.0', port }))).ok, true);
    await until(async () => { const w = await whoami(port); return w?.version === '1.0.0' && w.pid !== pid; }, '1.0.0 to run again');
    assert.equal(statusOf(s).held, null);
  } finally {
    await h.stop();
  }
});

test('S2: a crash during a deploy is never dropped: it is dealt with as soon as the deploy is done', async () => {
  // Health checks every 30 s: only the crash path can bring it back within the test.
  const h = await supervised('nova-rev-s2b-', { timings: { healthEveryMs: 30_000 } });
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    const pid = (await whoami(port))!.pid;
    const applying = deploy(s, standIn({ version: '1.1.0', port }));
    await sleep(200);
    process.kill(pid, 'SIGKILL');
    assert.equal((await applying).ok, true);
    await until(async () => { const w = await whoami(port); return w?.version === '1.0.0' && w.pid !== pid; }, '1.0.0 to run again', 5000);
  } finally {
    await h.stop();
  }
});

// ---- S3: a held service has a way back -----------------------------------------------------------------------

test('S3: a held service with nothing kept is started again by recover, on the person’s word', async () => {
  const h = await supervised('nova-rev-s3-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    assert.match((await s.manager.recover('stand-in')).said, /is running/, 'nothing to recover while it runs');
    for (let i = 0; i < 3; i++) {
      await until(async () => !!(await whoami(port)), 'it to answer');
      const pid = (await whoami(port))!.pid;
      process.kill(pid, 'SIGKILL');
      await until(() => !alive(pid), 'it to stop');
    }
    await until(() => !!statusOf(s).held, 'held');
    assert.equal(statusOf(s).previous, null, 'nothing kept to roll back to');
    const r = await s.manager.recover('stand-in');
    assert.equal(r.ok, true, r.said);
    assert.equal((await whoami(port))!.version, '1.0.0');
    assert.equal(statusOf(s).held, null);
    assert.equal(statusOf(s).history[0]!.outcome, 'recovered');
  } finally {
    await h.stop();
  }
});

// ---- S4: a soak longer than one timer -----------------------------------------------------------------------------

test('S4: a soak longer than one timer holds keeps the old slot; a chained timer still ends it on time', async () => {
  const h = await supervised('nova-rev-s4-', { timings: { maxTimerMs: 400 } });
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    await live(s, standIn({ version: '2.0.0', port, soak_s: 2 }));
    const t0 = Date.now();
    await sleep(800);
    assert.equal(statusOf(s).previous, '1.0.0', 'still kept after two timers');
    await until(() => statusOf(s).previous === null, 'the soak to end', 5000);
    assert.ok(Date.now() - t0 >= 1000, 'not early');
    assert.equal(versionOf(s, '1.0.0').status, 'removed');
  } finally {
    await h.stop();
  }
  const h2 = await supervised('nova-rev-s4b-');
  try {
    const port = await freePort();
    await live(h2.s, standIn({ version: '1.0.0', port }));
    await live(h2.s, standIn({ version: '2.0.0', port, soak_s: 28 * 86_400 }));
    await sleep(300);
    assert.equal(statusOf(h2.s).previous, '1.0.0', 'a 28-day soak keeps its slot');
    assert.ok(h2.s.services.slots('stand-in').includes('1.0.0'));
  } finally {
    await h2.stop();
  }
});

// ---- S6: a dead instance is cleared, and its group number is never signalled ---------------------------------------

test('S6: a version that dies alongside is cleared and no longer offered, and its freed group number is never signalled', async () => {
  const h = await supervised('nova-rev-s6-');
  const { s } = h;
  const realKill = process.kill.bind(process);
  const late: string[] = [];
  let watch = 0;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    await deploy(s, standIn({ version: '2.0.0', port }));
    watch = versionOf(s, '2.0.0').pid!;
    (process as { kill: typeof process.kill }).kill = ((pid: number, sig?: string | number) => { if (pid === -watch) late.push(`kill(${pid}, ${sig})`); return realKill(pid, sig); }) as typeof process.kill;
    realKill(watch, 'SIGKILL');
    await until(() => versionOf(s, '2.0.0').status === 'failed', 'its status to say so');
    assert.match(versionOf(s, '2.0.0').said!, /stopped by itself while running alongside/);
    assert.equal(versionOf(s, '2.0.0').pid, null);
    assert.ok(!s.services.pids().includes(watch));
    assert.match((await promote(s, '2.0.0')).said, /isn’t registered|isn’t ready/);
    await deploy(s, standIn({ version: '3.0.0', port }));
    assert.deepEqual(late, [], 'no signal went to the dead group’s number');
  } finally {
    (process as { kill: typeof process.kill }).kill = realKill;
    await h.stop();
  }
});

// ---- S7: the program is read without holding up the supervisor --------------------------------------------------------

test('S7: a program that is a pipe, or too big, is refused at once, and the supervisor never stops ticking', { timeout: 30_000 }, async () => {
  const h = await supervised('nova-rev-s7-');
  const { s } = h;
  try {
    const fifo = join(h.dir, 'prog.fifo');
    execFileSync('mkfifo', [fifo]);
    const port = await freePort();
    const def = standIn({ version: '1.0.0', port });
    const asFile = (file: string, version: string): ServiceDefinition => ({ ...def, version, artifact: { program: { [platformKey()]: { url: pathToFileURL(file).href, sha256: 'a'.repeat(64), command: ['node', file.split('/').pop()!] } } } });
    // Read as a file, a pipe with no writer would block the supervisor's one thread for good (this
    // test would never end); refused by what it is, it answers at once.
    const t0 = Date.now();
    const r = await deploy(s, asFile(fifo, '1.0.0'));
    assert.equal(r.ok, false);
    assert.match(r.said, /isn’t a regular file \(a link, a pipe or a device is never installed\)/);
    assert.ok(Date.now() - t0 < 2000, 'at once');
    // The supervisor goes on: the console still answers its health checks.
    const checked = s.state.health.last_check_at;
    await until(() => s.state.health.last_check_at !== checked, 'another health check');
    const big = join(h.dir, 'big.js');
    writeFileSync(big, '');
    truncateSync(big, 300 * 1024 * 1024);
    const b = await deploy(s, asFile(big, '1.0.1'));
    assert.match(b.said, /is 300 MB, more than the 256 MB Nova installs/);
  } finally {
    await h.stop();
  }
});

// ---- S8: Nova's own ports ------------------------------------------------------------------------------------------------

test('S8: no service may take Nova’s own ports, even while the console is restarting', async () => {
  const consolePort = await freePort();
  const meshPort = await freePort();
  const h = await supervised('nova-rev-s8-', {
    make: (dir, repo) => new Supervisor({
      dir: join(dir, 'sup'), home: join(dir, 'home'), repo, base: repo, tests: [process.execPath, '-e', ''],
      env: { PATH: process.env.PATH ?? '', NOVA_PORT: String(consolePort), NOVA_MESH_URL: `http://127.0.0.1:${meshPort}` },
      timings: { ...SERVICE_TIMINGS, backoffMs: 2000, maxBackoffMs: 4000 },
    }),
  });
  const { s } = h;
  try {
    assert.equal(s.server!.port, consolePort);
    const plan = (port: number) => s.manager.plan(standIn({ version: '1.0.0', port }));
    const onConsole = plan(consolePort);
    assert.ok(onConsole.ok && !onConsole.plan.ok);
    assert.match(onConsole.plan.refused.join(' '), new RegExp(`Its port ${consolePort} \\(api\\) is Nova’s own console port`));
    const onMesh = plan(meshPort);
    assert.ok(onMesh.ok && !onMesh.plan.ok);
    assert.match(onMesh.plan.refused.join(' '), /is Nova’s device door/);
    // The console crashes: during its restart wait its port is free, and still refused.
    process.kill(s.server!.pid!, 'SIGKILL');
    await until(() => s.state.mode === 'restarting', 'the restart wait');
    const during = await deploy(s, standIn({ version: '1.0.0', port: consolePort }));
    assert.equal(during.ok, false);
    assert.match(during.said, /is Nova’s own console port/);
    await until(() => s.state.mode === 'running' && s.server?.port === consolePort, 'the console back on its own port');
  } finally {
    await h.stop();
  }
});

test('S8: the console’s configured port is refused even when the console answers elsewhere', async () => {
  const configured = await freePort();
  const h = await supervised('nova-rev-s8b-', {
    make: (dir, repo) => new Supervisor({
      dir: join(dir, 'sup'), home: join(dir, 'home'), repo, base: repo, tests: [process.execPath, '-e', ''],
      env: { PATH: process.env.PATH ?? '', NOVA_PORT: '0' }, timings: SERVICE_TIMINGS, ports: { console: configured, mesh: null },
    }),
  });
  try {
    assert.notEqual(h.s.server!.port, configured);
    const p = h.s.manager.plan(standIn({ version: '1.0.0', port: configured }));
    assert.ok(p.ok && !p.plan.ok);
    assert.match(p.plan.refused.join(' '), /is Nova’s own console port/);
    const running = h.s.manager.plan(standIn({ version: '1.0.0', port: h.s.server!.port! }));
    assert.ok(running.ok && !running.plan.ok);
    assert.match(running.plan.refused.join(' '), /is the port Nova’s console answers on/);
  } finally {
    await h.stop();
  }
});

// ---- S9: restarts for failed health count toward holding ----------------------------------------------------------------

test('S9: a service restarted again and again for failed health is held, as a crash loop is', async () => {
  const h = await supervised('nova-rev-s9-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    for (let i = 0; i < 3; i++) {
      await until(async () => !!(await whoami(port)) || !!statusOf(s).held, 'it to answer');
      if (statusOf(s).held) break;
      await call(port, '/sicken', { method: 'POST' });
      const pid = (await whoami(port))?.pid;
      await until(async () => !!statusOf(s).held || (await whoami(port))?.pid !== pid, 'a restart, or held');
    }
    await until(() => !!statusOf(s).held, 'held');
    assert.match(statusOf(s).held!.reason, /restarted or stopped 3 times within 60 s .*failed health checks/);
  } finally {
    await h.stop();
  }
});

test('S6: a stopped program’s group number is never signalled once no member of the group is left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-rev-s6b-'));
  const realKill = process.kill.bind(process);
  const sent: string[] = [];
  const p = new ServerProcess({ root: dir, env: { PATH: process.env.PATH ?? '' }, argv: [process.execPath, '-e', 'setTimeout(() => {}, 100)'], group: true });
  const pid = p.pid!;
  try {
    await p.exited();
    await until(() => !existsSync(`/proc/${pid}`), 'the leader to be gone');
    (process as { kill: typeof process.kill }).kill = ((x: number, sig?: string | number) => { if (x === -pid) sent.push(`kill(${x}, ${sig})`); return realKill(x, sig); }) as typeof process.kill;
    await p.stop();
    assert.deepEqual(sent, [], 'nothing was sent to a number that may belong to someone else by now');
  } finally {
    (process as { kill: typeof process.kill }).kill = realKill;
  }
});

// ---- the forwarder ---------------------------------------------------------------------------------------------------------

function halfClose(port: number): Promise<string> {
  return new Promise((resolve) => {
    const c = connect(port, '127.0.0.1');
    let got = '';
    c.on('data', (b) => { got += b; });
    c.on('close', () => resolve(got.split('\r\n')[0] || '(nothing)'));
    c.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code}`));
    c.write('GET /whoami HTTP/1.0\r\nHost: x\r\n\r\n');
    c.end();
  });
}

test('the stable port answers a client that half-closes, and passes a reset on at once', async () => {
  const h = await supervised('nova-rev-fwd-');
  const { s } = h;
  try {
    const port = await freePort();
    await live(s, standIn({ version: '1.0.0', port }));
    for (let i = 0; i < 3; i++) assert.equal(await halfClose(port), 'HTTP/1.1 200 OK');
    const t0 = Date.now();
    const reset = await call(port, '/reset');
    assert.equal(reset, null, 'the client sees the connection end, not an answer');
    assert.ok(Date.now() - t0 < 2000, 'at once, not after a timeout');
    assert.equal((await whoami(port))!.version, '1.0.0', 'and the next request is served');
  } finally {
    await h.stop();
  }
});

// ---- the tripwire's limit, checked where it can be -----------------------------------------------------------------------

test('no code in Nova or its scripts names a Kubernetes tool to run (the tripwire sees PATH lookups only)', () => {
  const root = join(import.meta.dirname, '..', '..');
  const r = spawnSync('git', ['-C', root, 'grep', '-nE', `['"\`](kubectl|helm|flux|k3s)['"\` ]`, '--', 'src', 'scripts', ':!scripts/tripwire.sh'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  // git grep: 1 when nothing matches, 0 when something does.
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
});
