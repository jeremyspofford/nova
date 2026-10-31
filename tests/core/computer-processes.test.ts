// Nova Computer hardening (the PR #236 review, items 3 and 11): no process outlives its task, the
// egress tunnel lives only as long as one command, the proxy asks again on every new connection
// whether the task may still reach outside, and the relay owns its port before any command runs.
// Throwaway folders under the test's temp dir; canaries stand in for what must not change; the
// containers carry the test's label and are removed at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUser } from '../../src/core/computer/policy.ts';
import { TEST_LABELS, docker, dockerSkip, processes, removeTestContainers, settled, tlsStandIn } from './computer-support.ts';
import { open } from './resilience-support.ts';
import type { Core } from '../../src/core/index.ts';

const skip = await dockerSkip();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const containerOf = (core: Core, ws: string) => `nova-computer-${(core.computer.computer as unknown as { tag: string }).tag}-${ws}`;

async function destroyAll(core: Core, ids: string[]) {
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  for (const id of ids) {
    try { const d = core.computer.request('destroy', {}, id); core.ledger.approve(d.id, { confirm: true }); await settled(core, d.id); } catch { /* best effort */ }
  }
}

test('no process outlives its task: a read that leaves a delayed write behind changes nothing', { skip: skip ?? false, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-outlive-'));
  const core = open(join(root, 'home'), { computer: { userHome: join(root, 'user'), labels: TEST_LABELS } });
  const ids: string[] = [];
  try {
    core.start();
    const made = await settled(core, core.computer.request('create', { name: 'Scratch' }).id);
    assert.equal(made.state, 'done', made.reason ?? '');
    const ws = String(made.brief.inputs!.workspace);
    ids.push(ws);
    const folder = core.computer.view(ws).folder;
    const w = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'echo original > canary.txt'] }, ws).id);
    assert.equal(w.state, 'done', w.reason ?? '');

    // A read (tier 0, automatic) whose command starts a detached process that writes later.
    const read = core.computer.request('exec', { argv: ['sh', '-c', 'setsid sh -c "sleep 3; echo changed > /workspace/canary.txt; echo late > /tmp/late" >/dev/null 2>&1 </dev/null & echo started'], access: 'read' }, ws);
    assert.equal(read.approval_tier, 0);
    const r = await settled(core, read.id);
    // It ran as a read and changed nothing while it ran, so it is done, and says what it left behind.
    assert.equal(r.state, 'done', r.reason ?? '');
    assert.match(r.report!.summary, /It left 2 processes running; Nova stopped them when it ended/);
    await sleep(5000);
    assert.equal(readFileSync(join(folder, 'canary.txt'), 'utf8'), 'original\n', 'the delayed write never happened');
    const procs = await processes(containerOf(core, ws));
    assert.equal(procs.length, 2, `only the machine’s own two processes run: ${procs.join(' | ')}`);
    assert.doesNotMatch((await docker(['diff', containerOf(core, ws)])).out, /\/tmp\/late/);
  } finally {
    await destroyAll(core, ids);
    await core.close();
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('egress lives only as long as its command, and every new connection is asked about again', { skip: skip ?? false, timeout: 300_000 }, async (t) => {
  const host = await tlsStandIn('hello from the declared host\n');
  if (!host) { t.skip('openssl isn’t here to make the stand-in host’s certificate'); return; }
  const root = mkdtempSync(join(tmpdir(), 'nova-tunnel-life-'));
  const home = join(root, 'home');
  // The stand-in is on loopback, which the real rule never reaches; for this test only, it counts.
  const core = open(home, { computer: { userHome: join(root, 'user'), labels: TEST_LABELS, egressAllow: (a) => a === '127.0.0.1' } });
  const ids: string[] = [];
  const url = `https://127.0.0.1:${host.port}/`;
  const run = async (argv: string[], access: 'read' | 'write' = 'read') => {
    const x = core.computer.request('exec', { argv, access }, ws);
    assert.equal(x.approval_tier, 3);
    core.ledger.approve(x.id, { confirm: true });
    return x;
  };
  let ws = '';
  try {
    core.start();
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    const c = core.computer.request('create', { name: 'Out', egress: { mode: 'hosts', hosts: [`127.0.0.1:${host.port}`] } });
    core.ledger.approve(c.id, { confirm: true });
    const made = await settled(core, c.id);
    assert.equal(made.state, 'done', made.reason ?? '');
    ws = String(made.brief.inputs!.workspace);
    ids.push(ws);
    const container = containerOf(core, ws);

    await t.test('a process already holding the relay’s port is cleared before the relay starts; the command never talks to it', async () => {
      // A leftover from before (as if Nova had stopped mid-command): a fake proxy on the relay's port.
      const fake = `require('net').createServer((s) => s.end('HTTP/1.1 200 Connection Established\\r\\n\\r\\nFAKE PROXY')).listen(3128, '127.0.0.1')`;
      assert.equal((await docker(['exec', '-d', '--user', runUser(), container, 'node', '-e', fake])).code, 0);
      for (let i = 0; i < 100 && (await processes(container)).length < 3; i++) await sleep(50);
      assert.equal((await processes(container)).length, 3, 'the fake proxy runs');
      const x = await settled(core, (await run(['curl', '-sSk', url])).id);
      assert.equal(x.state, 'done', x.reason ?? '');
      const rec = JSON.parse(readFileSync(join(home, 'workers', 'computer', 'runs', `${x.id}.json`), 'utf8'));
      assert.equal(rec.stdout, 'hello from the declared host\n');
      assert.equal(host.seen(), 1);
    });

    await t.test('a detached process trying egress after its task ended, even after a switch to local-only, is refused', async () => {
      const x = await settled(core, (await run(['sh', '-c', `setsid sh -c "sleep 3; curl -sSk ${url} > /tmp/late.txt 2>&1; curl -sSk ${url} >> /tmp/late.txt 2>&1" >/dev/null 2>&1 </dev/null & curl -sSk ${url}`])).id);
      assert.equal(x.state, 'done', x.reason ?? '');
      assert.equal(host.seen(), 2, 'the command itself reached the declared host');
      core.profile.set('privacy', 'default', 'local-only', 'settings');
      await sleep(6000);
      assert.equal(host.seen(), 2, 'nothing reached it after the task ended');
      core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    });

    await t.test('a switch to local-only while a command runs refuses its next connection', async () => {
      const x = await run(['sh', '-c', `curl -sSk ${url}; while [ ! -e /workspace/go ]; do sleep 0.1; done; curl -sSk ${url}; echo "second: $?"`]);
      for (let i = 0; i < 400 && host.seen() < 3; i++) await sleep(50);
      assert.equal(host.seen(), 3, 'the first connection got through');
      core.profile.set('privacy', 'default', 'local-only', 'settings');
      writeFileSync(join(core.computer.view(ws).folder, 'go'), '');
      const done = await settled(core, x.id);
      assert.equal(host.seen(), 3, 'the second never reached the host');
      const rec = JSON.parse(readFileSync(join(home, 'workers', 'computer', 'runs', `${done.id}.json`), 'utf8'));
      assert.match(rec.stdout, /second: [1-9]/);
      assert.deepEqual(rec.egress.map((a: { allowed: boolean; code: string }) => [a.allowed, a.code]), [[true, 'allowed'], [false, 'local-only']]);
      core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    });
  } finally {
    await destroyAll(core, ids);
    await core.close();
    host.close();
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});
