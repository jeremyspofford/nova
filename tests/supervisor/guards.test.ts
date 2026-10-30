// The supervisor's own guards (M7 review), with a stand-in server so each runs in seconds:
// a repair's restart is limited and counts toward safe mode; "base" runs the commit pinned at
// start, never the checkout as edited since; its folder must be the person's alone; a tag named
// `current` or `base` is never a release; a switch that fails puts the running release back;
// going back with nowhere to go keeps safe mode; a refused rollback whose release won't start
// again is held, not left stopped; and the control socket wants what the person typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { FAST, control, fakeRelease, fakeRepo, get, git } from './fake.ts';
import { scratch, until } from './support.ts';

function make(dir: string, repo: string, timings: Partial<typeof FAST> = {}) {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return new Supervisor({ dir: join(dir, 'sup'), home, repo, base: repo, env: { PATH: process.env.PATH ?? '', NOVA_PORT: '0' }, tests: [process.execPath, '-e', ''], timings: { ...FAST, ...timings } });
}

const running = (s: Supervisor) => s.state.mode === 'running' && !!s.server?.port;
const base = (s: Supervisor) => `http://127.0.0.1:${s.server!.port}`;

test('a repair’s restart: at most once a minute, and it counts toward safe mode like a crash', async () => {
  const dir = scratch('nova-guard-restart-');
  const s = make(dir, fakeRepo(dir));
  try {
    await s.run();
    await until(() => running(s), 'the server');
    const first = s.server!.pid;
    const r1 = await get(base(s), '/ask/restart');
    assert.equal(r1.ok, true, r1.said);
    await until(() => running(s) && s.server!.pid !== first, 'the restart');
    const second = s.server!.pid;
    const r2 = await get(base(s), '/ask/restart');
    assert.equal(r2.ok, false, 'a second restart within the minute is refused');
    assert.match(r2.said, /at most once/);
    assert.equal(s.server!.pid, second, 'and nothing was restarted');
    // The asked-for restart counted: two crashes now make three within the minute.
    process.kill(second!, 'SIGKILL');
    await until(() => running(s) && s.server!.pid !== second, 'the restart after a crash');
    process.kill(s.server!.pid!, 'SIGKILL');
    await until(() => s.state.mode === 'safe_mode', 'safe mode');
    assert.match(s.state.safe_mode!.reason, /stopped or was restarted 3 times|stopped 3 times/);
  } finally {
    await s.close();
  }
});

test('“base” runs the commit pinned when the supervisor started, never the checkout as edited since', async () => {
  const dir = scratch('nova-guard-base-');
  const repo = fakeRepo(dir, 'one');
  const s = make(dir, repo);
  try {
    await s.run();
    await until(() => running(s), 'the server');
    assert.equal((await get(base(s), '/api/v1/health')).version, 'one');
    assert.equal(s.state.releases.base_commit, git(repo, 'rev-parse', 'HEAD'));
    // Someone (or something) edits the checkout while Nova runs; a restart runs what was pinned.
    writeFileSync(join(repo, 'marker.txt'), 'edited\n');
    const r = await s.restart('the test asked');
    assert.equal(r.ok, true, r.said);
    assert.equal((await get(base(s), '/api/v1/health')).version, 'one');
  } finally {
    await s.close();
  }
});

test('the supervisor’s folder must be the person’s alone', async () => {
  const dir = scratch('nova-guard-dir-');
  const s = make(dir, fakeRepo(dir));
  chmodSync(join(dir, 'sup'), 0o755);
  await assert.rejects(() => s.run(), /open to other users/);
  assert.equal(s.server, null, 'nothing was started');
  await s.close();
});

test('a tag named current or base is never a release, and a switch that fails puts the running release back', async () => {
  const dir = scratch('nova-guard-tags-');
  const repo = fakeRepo(dir, 'one');
  fakeRelease(repo, 'current', 'planted');
  fakeRelease(repo, 'v2', 'two');
  const s = make(dir, repo);
  try {
    await s.run();
    await until(() => running(s), 'the server');
    const d = await s.deploy('current');
    assert.equal(d.ok, false);
    assert.match(d.said, /isn’t a release’s tag/);
    await assert.rejects(() => s.slots.ensure('current'), /supervisor uses it itself/);
    assert.throws(() => s.slots.point('current'), /supervisor uses it itself/);
    assert.equal(existsSync(join(s.slots.dir, 'current')) && !lstatSync(join(s.slots.dir, 'current')).isSymbolicLink(), false, 'no folder where the link goes');

    // The switch throws after the running release was stopped: it is started again.
    s.slots.point = () => { throw new Error('the disk said no'); };
    const r = await s.deploy('v2');
    assert.equal(r.ok, false, r.said);
    assert.match(r.said, /switch/);
    await until(() => running(s), 'the release that ran, running again');
    assert.equal((await get(base(s), '/api/v1/health')).version, 'one');
    assert.equal(s.state.releases.current, 'base');
  } finally {
    await s.close();
  }
});

test('going back with nowhere to go keeps safe mode; the socket wants what the person typed', async () => {
  const dir = scratch('nova-guard-safe-');
  const s = make(dir, fakeRepo(dir), { crashes: 1 });
  try {
    await s.run();
    await until(() => running(s), 'the server');
    process.kill(s.server!.pid!, 'SIGKILL');
    await until(() => s.state.mode === 'safe_mode', 'safe mode');
    const sock = s.o.dir;
    assert.match((await control(sock, { cmd: 'rollback', confirm: true })).said, /type rollback/, 'a bare yes isn’t a confirmation');
    assert.match((await control(sock, { cmd: 'deploy', version: 'v2', confirm: true })).said, /type the version/);
    const r = await control(sock, { cmd: 'rollback', confirm: 'rollback' });
    assert.equal(r.ok, false);
    assert.match(r.said, /stays in safe mode/);
    assert.equal(s.state.mode, 'safe_mode');
    assert.ok(s.state.safe_mode, 'still held, with its reason');
  } finally {
    await s.close();
  }
});

test('a refused rollback whose release won’t start again is held in safe mode, not left stopped', async () => {
  const dir = scratch('nova-guard-refused-');
  const repo = fakeRepo(dir, 'one');
  fakeRelease(repo, 'v2', 'two');
  const s = make(dir, repo);
  try {
    await s.run();
    await until(() => running(s), 'the server');
    const d = await s.deploy('v2');
    assert.equal(d.ok, true, d.said);
    // As if v2 had upgraded the database and its backup were gone: going back is refused.
    const slot = s.state.releases.slots.find((x) => x.version === 'v2')!;
    slot.migration = { from: 1, to: 2, backup: null, mark: { seq: 0, problem: 0 } };
    // And v2 no longer starts.
    writeFileSync(join(s.slots.path('v2'), 'src', 'server.js'), 'process.exit(3);\n');
    const r = await s.rollback({ auto: false, reason: 'You asked to go back.', target: s.state.releases.previous });
    assert.equal(r.ok, false);
    assert.match(r.said, /safe mode/);
    assert.equal(s.state.mode, 'safe_mode');
  } finally {
    await s.close();
  }
});
