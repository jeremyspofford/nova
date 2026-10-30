// Repairs that must not run away (M7 review): a crash the supervisor already handled closes once
// Nova is up again and is never "repaired" by restarting a healthy server; restarting Nova is the
// console's or an approver's to ask, never any paired phone's; choosing the backup folder and
// seeing the recovery key again are not a phone's either; and deleting scratch to free a full disk
// deletes only Nova's own leftovers, never a folder another process is using.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeScratch, dropScratch } from '../../src/core/resilience/scratch.ts';
import { open, world } from './resilience-support.ts';
import { call, enroll, hub } from './mesh-support.ts';

test('a crash the supervisor handled closes once Nova is up, and Nova never restarts a healthy server for it', async () => {
  const w = world('nova-sweep-');
  let t = Date.parse('2026-10-30T10:00:00Z');
  let told: ((p: unknown) => void) | null = null;
  const restarts: number[] = [];
  const link = {
    state: () => null,
    request: async (type: string) => { restarts.push(t); return { ok: true, said: `did ${type}` }; },
    onProblem: (fn: (p: unknown) => void) => { told = fn; },
  };
  const c = open(w.home, { supervisor: link as never, now: () => new Date(t) });
  try {
    told!({ source: 'supervisor', playbook: 'server-crashed', said: 'Nova stopped unexpectedly (it was stopped by SIGKILL) and the supervisor started it again.', repairs: [{ name: 'restart-server', ok: true, said: 'Started again after 1.0 s.' }] });
    await new Promise((r) => setImmediate(r));
    const p = c.log.problems({ open: true }).find((x) => x.source === 'supervisor');
    assert.ok(p, 'told as a problem');
    for (let i = 0; i < 5; i++) {
      t += 61_000;
      await c.resilience.sweep();
      await c.resilience.playbooks.sweep();
    }
    assert.equal(restarts.length, 0, `Nova asked the supervisor to restart a healthy server ${restarts.length} times`);
    assert.equal(c.log.problems({ open: true }).some((x) => x.id === p.id), false, 'closed: Nova is running again');
    const pb = c.resilience.playbooks.view(p.id)!;
    assert.ok(pb.repairs.some((r) => /running again/.test(r.said)), JSON.stringify(pb.repairs));

    // Even a problem of that kind that is still open is never restarted by Nova's own sweep.
    const again = c.resilience.playbooks.open('supervisor', 'Nova stopped answering its health checks.', 'server-unresponsive');
    await new Promise((r) => setImmediate(r));
    t += 61_000;
    await c.resilience.playbooks.sweep();
    assert.equal(restarts.length, 0);
    const own = await c.resilience.playbooks.attempt(again.id, 'nova');
    assert.equal(own.ok, false);
    assert.equal(restarts.length, 0);
  } finally {
    await c.close();
  }
});

test('restarting Nova, choosing the backup folder and seeing the recovery key again are not any paired phone’s', async () => {
  const h = await hub();
  const w = world('nova-access-');
  try {
    const p = h.core.resilience.playbooks.open('supervisor', 'Nova stopped answering its health checks.', 'server-unresponsive');
    const { dev, token } = await enroll(h, { kind: 'phone', name: 'Test phone' });
    const asPhone = (method: string, path: string, body?: unknown) => call(h.mesh, method, `/api/v1${path}`, body, { authorization: `Bearer ${token}` });
    const repair = await asPhone('POST', `/problems/${p.id}/repair`);
    assert.equal(repair.status, 403, JSON.stringify(repair.body));
    const settings = await asPhone('PUT', '/backups/settings', { target: w.target });
    assert.equal(settings.status, 403, JSON.stringify(settings.body));
    assert.equal(h.core.resilience.settings().target, null);
    assert.equal((await asPhone('POST', '/backups/recovery-key', { confirm: true })).status, 403);
    // Other repairs stay the person’s, from any of their devices.
    const other = h.core.resilience.playbooks.open('backups', 'A backup didn’t finish.', 'backup-failed');
    assert.notEqual((await asPhone('POST', `/problems/${other.id}/repair`)).status, 403);

    // An approver may restart Nova and choose the folder; the recovery key is the hub's screen's.
    assert.equal((await h.c('PATCH', `/mesh/devices/${dev.deviceId}`, { can_approve: true, confirm: true })).status, 200);
    assert.notEqual((await asPhone('POST', `/problems/${p.id}/repair`)).status, 403);
    assert.equal((await asPhone('PUT', '/backups/settings', { target: w.target })).status, 200);
    assert.equal((await asPhone('POST', '/backups/recovery-key', { confirm: true })).status, 403);

    // The console: shown again only with an explicit confirmation (tier 3).
    assert.equal((await h.c('PUT', '/backups/settings', { encrypted_target: w.second })).status, 200);
    assert.equal((await h.c('POST', '/backups/recovery-key', {})).status, 400);
    const shown = await h.c('POST', '/backups/recovery-key', { confirm: true });
    assert.equal(shown.status, 200);
    assert.match(shown.body.recovery_key, /^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/);
  } finally {
    await h.stop();
  }
});

test('freeing scratch deletes only Nova’s own leftovers, never a folder another process is using', async () => {
  const w = world('nova-free-');
  const c = open(w.home);
  const root = tmpdir();
  // Another process's work in progress: a test's home named like Nova's scratch, and a scratch
  // folder of a process that is still running (this test's parent).
  const theirs = mkdtempSync(join(root, 'nova-drill-'));
  const running = mkdtempSync(join(root, `nova-drill-p${process.ppid}-`));
  // A leftover of a process that has stopped, and a folder this process is using.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const gone = mkdtempSync(join(root, `nova-forget-p${dead}-`));
  const inUse = makeScratch('drill');
  try {
    const p = c.resilience.playbooks.open('backups', 'The disk the backup folder is on is full.', 'disk-full', { subject: 'backup' });
    const r = await c.resilience.playbooks.attempt(p.id, 'person');
    assert.equal(r.ok, true, r.said);
    assert.ok(existsSync(theirs), 'another process’s folder is untouched');
    assert.ok(existsSync(running), 'a running process’s scratch is untouched');
    assert.ok(existsSync(inUse), 'scratch this process is using is untouched');
    assert.equal(existsSync(gone), false, 'a stopped process’s leftover is deleted');
  } finally {
    for (const d of [theirs, running, gone]) rmSync(d, { recursive: true, force: true });
    dropScratch(inUse);
    await c.close();
  }
});
