// Security regressions reproduced with signed synthetic programs in temporary local homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceKeys, sha256Hex } from '../../src/core/index.ts';
import { Workloads } from '../../src/device/workloads.ts';
import { Rollout, type Assignment } from '../../src/device/rollout.ts';
import { freePort, manifest, sign } from '../support/workloads.ts';
import { until } from './device-support.ts';

async function rig(source: string) {
  const home = mkdtempSync(join(tmpdir(), 'nova-workload-review-'));
  const hub = generateDeviceKeys();
  const port = await freePort();
  const bytes = Buffer.from(source);
  let roles = ['general-server'];
  const w = new Workloads({
    home, platform: `${process.platform}-${process.arch}`, deviceId: () => 'test-device',
    pinned: () => [hub.ed25519.publicKey], purposes: () => roles, captureOn: () => false,
    uid: () => 1000, backoffMs: 30,
    fetchManifest: async (_s, version) => sign(manifest({ device_id: 'test-device', port, version, files: { 'fixture.js': sha256Hex(bytes) }, command: ['node', 'fixture.js'] }), hub),
    fetchFile: async () => bytes,
  });
  const verb = (verb: string, version = '1') => w.perform({ verb, service: 'stand-in', version });
  return { home, port, w, verb, roles: (next: string[]) => { roles = next; } };
}

for (const action of ['stop', 'recheck', 'close'] as const) {
  test(`leader exit ends its owned descendants before watchdog restart and ${action}`, { skip: process.platform !== 'linux' }, async () => {
    const k = await rig(`
      const fs = require('node:fs');
      const file = process.env.NOVA_SERVICE_STATE + '/pids';
      if (process.argv[2] === 'child') {
        process.on('SIGTERM', () => {});
        fs.appendFileSync(file, 'child ' + process.pid + '\\n');
        setInterval(() => {}, 1000);
      } else {
        fs.appendFileSync(file, 'leader ' + process.pid + '\\n');
        require('node:child_process').spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore' });
        setTimeout(() => process.exit(1), 150);
      }
    `);
    const file = join(k.home, 'workloads/stand-in/data/pids');
    const pids = () => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => { const [role, pid] = line.split(' '); return { role, pid: Number(pid) }; }) : [];
    const alive = (pid: number) => {
      try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
    };
    try {
      assert.equal((await k.verb('install')).ok, true);
      assert.equal((await k.verb('switch')).ok, true);
      assert.match(await until(() => k.w.state()[0]?.running[0]?.failed, Boolean, 5000) ?? '', /three times/, 'watchdog holds after three crashes');
      assert.equal(pids().filter((p) => p.role === 'leader').length, 3, 'normal watchdog crash limit still applies');
      const descendants = pids().filter((p) => p.role === 'child');
      assert.equal(descendants.length, 3);
      assert.equal(await until(() => descendants.some((p) => alive(p.pid)), (v) => !v, 1500), false, 'leader exit must end descendants even before a stop');
      if (action === 'stop') await k.verb('stop');
      if (action === 'recheck') { k.roles([]); await k.w.recheck(); }
      if (action === 'close') await k.w.close();
      assert.equal(descendants.some((p) => alive(p.pid)), false);
    } finally {
      await k.w.close();
      // RED runs also clean up only the process groups recorded by this test's fixture.
      for (const p of pids().filter((p) => p.role === 'leader')) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
    }
  });
}

test('health redirects cannot reach another loopback listener', async () => {
  let hits = 0;
  const other = createServer((_q, r) => { hits++; r.end('healthy'); });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as { port: number }).port;
  const k = await rig(`require('node:http').createServer((_q, r) => { r.writeHead(302, { location: 'http://127.0.0.1:${otherPort}/health' }); r.end(); }).listen(Number(process.env.PORT), '127.0.0.1');`);
  try {
    await k.verb('install'); await k.verb('switch');
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${k.port}/health`, { redirect: 'manual' })).status; } catch { return 0; } }, (s) => s === 302, 5000);
    const p = await k.verb('probe');
    assert.equal(p.ok, false, 'a 302 is not this workload passing health');
    assert.equal(hits, 0, 'the redirect target must never receive a health request');
  } finally { await k.w.close(); await new Promise<void>((resolve) => other.close(() => resolve())); }
});

test('install staging preserves a live version whose name ends with .next', async () => {
  const k = await rig(`require('node:http').createServer((_q, r) => r.end('healthy')).listen(Number(process.env.PORT), '127.0.0.1');`);
  try {
    assert.equal((await k.verb('install', '1.next')).ok, true);
    assert.equal((await k.verb('switch', '1.next')).ok, true);
    const slot = join(k.home, 'workloads/stand-in/v/1.next');
    const before = readFileSync(join(slot, 'manifest.json'));
    assert.equal((await k.verb('install', '1')).ok, true);
    assert.ok(existsSync(join(slot, 'manifest.json')), 'installing 1 must not delete live 1.next');
    assert.deepEqual(readFileSync(join(slot, 'manifest.json')), before);
    assert.deepEqual(k.w.state()[0]?.installed, ['1', '1.next']);
  } finally { await k.w.close(); }
});

test('unchanged live assignments keep watchdog safe mode held and report failed health', async () => {
  const k = await rig(`require('node:fs').appendFileSync(process.env.NOVA_SERVICE_STATE + '/starts', 'start\\n'); process.exit(1);`);
  const file = join(k.home, 'workloads/stand-in/data/starts');
  const starts = () => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0;
  const a: Assignment = { service: 'stand-in', version: '1', want: 'live', previous: null, alongside: 'none', capture: false, assigned_at: '2026-11-01T10:00:00Z' };
  const r = new Rollout({ verb: (verb, _s, version) => k.verb(verb, version), gapMs: 10 });
  try {
    await k.verb('install'); await k.verb('switch');
    assert.equal(await until(starts, (n) => n === 3, 5000), 3);
    await until(() => k.w.state()[0]?.running[0]?.failed, Boolean, 5000);
    await r.step([a], k.w.state());
    await r.step([a], k.w.state());
    assert.equal(await until(starts, (n) => n > 3, 400), 3, 'heartbeats must not reset the crash budget');
    assert.equal(r.reports()[0]?.health, false, 'held is failed health');
    assert.match(r.reports()[0]?.said ?? '', /three times/);
    assert.equal((await k.verb('start')).ok, false, 'a repeated start also preserves the held watchdog');
    assert.equal((await k.verb('switch')).ok, false, 'an unchanged switch cannot reset the crash budget');
    assert.equal(starts(), 3);
    // Recovery is explicit: stopping the held instance before starting creates a new watchdog.
    await k.verb('stop');
    assert.equal((await k.verb('start')).ok, true);
    assert.equal(await until(starts, (n) => n === 6, 5000), 6);
  } finally { await k.w.close(); }
});
