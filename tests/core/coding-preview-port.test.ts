// The coding preview's port (#516). Nova used to find a free port, close it, and give it to the
// preview as PORT; between the close and the preview's own bind, another program could take it.
// Then the preview failed to start, or Nova's readiness check and link reached the other program.
// Now, where Nova reads the kernel's socket tables (Linux), the preview gets PORT=0, binds a port the
// kernel picks for it, and Nova takes as its address only a loopback socket its own process group
// holds, before and after it answers. These tests reproduce the race on purpose: every loopback port
// this process frees is taken by another server before the code that freed it goes on, and a server
// outside the preview's process group answers on a port of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { Server, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { groupListeners, startPreview, stopPreview } from '../../src/core/coding/preview.ts';
import { FAKE_CLAUDE, makeRepos, type Repos } from '../support/coding.ts';

const LINUX = process.platform === 'linux';
const skip = LINUX ? false : 'reads /proc';
const FIX = { edit: { path: 'app.mjs', old: '`Hi ${name}`', new: '`Hello, ${name}!`' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const core = createCore({ home: mkdtempSync(join(tmpdir(), 'nova-preview-port-home-')), version: '0.1.0', trustedOrigin: () => true, coding: { testTimeoutS: 60, previewTimeoutS: 20 } });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  return core;
}
const script = (repos: Repos, steps: unknown[]) => {
  mkdirSync(join(repos.dir, 'scripts'), { recursive: true });
  const f = join(repos.dir, 'scripts', `s-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ steps, result: 'Done.' }));
  return f;
};
async function settle(core: Core, id: string) {
  for (let i = 0; i < 1200; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await sleep(25);
  }
  return core.ledger.get(id);
}
const taskOf = (core: Core, run: string, step: string) => {
  const ref = core.coding.view(run).tasks.filter((x) => x.step === step).at(-1);
  return ref ? core.ledger.get(ref.id) : null;
};

// Every loopback listener this process closes is taken at once by another server ("someone else")
// on the same port, before whoever closed it hears that it closed: the race of #516 with no timing
// in it. In this process only, so tests running beside it are not touched. Under a full suite,
// another test's server can take the port in the instant between the close and this server's
// listen (#509, the same race); the port is taken either way, and counted.
async function occupyFreed(): Promise<{ taken: number[]; restore: () => Promise<void> }> {
  const close = Server.prototype.close;
  const taken: number[] = [];
  const others: HttpServer[] = [];
  Server.prototype.close = function (this: Server, cb?: (err?: Error) => void) {
    const a = this.address();
    if (!a || typeof a !== 'object' || a.address !== '127.0.0.1' || others.includes(this as HttpServer)) return close.call(this, cb);
    return close.call(this, (err?: Error) => {
      const other = createHttpServer((q, r) => r.end('someone else'));
      others.push(other);
      other.once('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EADDRINUSE') taken.push(a.port); cb?.(err); });
      other.listen(a.port, '127.0.0.1', () => { taken.push(a.port); cb?.(err); });
    });
  } as typeof close;
  const restore = async () => {
    Server.prototype.close = close;
    await Promise.all(others.map((o) => new Promise((r) => { o.closeAllConnections(); o.close(r); })));
  };
  // Shown to work: a port this test listens on and closes is taken before the close returns.
  const port = await new Promise<number>((resolve) => { const t = createNetServer(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as { port: number }).port; t.close(() => resolve(p)); }); });
  assert.deepEqual(taken, [port], 'a freed port is taken at once');
  taken.length = 0;
  return { taken, restore };
}

test('probe (#516): with every loopback port Nova frees taken at once by another server, the check’s preview comes up, and its link reaches the preview Nova started', { timeout: 120_000, skip }, async () => {
  const occupied = await occupyFreed();
  const core = boot();
  const repos = makeRepos();
  core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${script(repos, [FIX])}` }, { confirm: true });
  core.providers.enable('claude-code', { approved: true });
  try {
    const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'node --test', preview_command: 'node server.mjs' });
    assert.equal((await settle(core, task.id)).state, 'done');
    const check = await settle(core, taskOf(core, run, 'check')!.id);
    core.ledger.approve(check.id);
    const c = await settle(core, check.id);
    assert.equal(c.state, 'done', `${c.reason} (ports taken by someone else: ${occupied.taken.join(', ') || 'none'})`);
    const p = core.coding.view(run).preview!;
    assert.ok(p.running, 'the preview is running');
    assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const records = join(core.coding.dir, 'records', 'previews');
    const rec = JSON.parse(readFileSync(join(records, readdirSync(records).find((f) => f.startsWith(run))!), 'utf8')) as { pid: number; port: number };
    assert.equal(rec.port, p.port);
    assert.ok((groupListeners(rec.pid) ?? []).some((l) => l.port === p.port), 'the port in the link is held by the preview’s own process group');
    assert.equal(await (await fetch(p.url)).text(), 'Hello, preview!', 'and the link answers with the preview, not someone else');
  } finally {
    await core.close();
    await occupied.restore();
  }
});

test('the preview is given PORT=0 and binds a port the kernel picks; the link is the loopback port its process group holds', { timeout: 30_000, skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-preview-port-'));
  const server = "require('node:fs').writeFileSync('given', String(process.env.PORT)); require('node:http').createServer((q, r) => r.end('mine')).listen(Number(process.env.PORT), process.env.HOST)";
  writeFileSync(join(dir, 'server.cjs'), server);
  const started = await startPreview({ command: 'node server.cjs', cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 10_000 });
  try {
    assert.equal(readFileSync(join(dir, 'given'), 'utf8'), '0');
    assert.notEqual(started.port, 0);
    assert.equal(started.url, `http://127.0.0.1:${started.port}/`);
    assert.equal(started.loopback, 'yes');
    assert.ok((groupListeners(started.child.pid!) ?? []).some((l) => l.port === started.port && l.address === '127.0.0.1'));
    assert.equal(await (await fetch(started.url)).text(), 'mine');
  } finally {
    stopPreview(started.child);
  }
});

test('an answer from a server outside the preview’s process group is never taken for the preview, whatever it says', { timeout: 30_000, skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-preview-port-'));
  // The command starts a server in a process group of its own (detached), on a port the kernel
  // picks, writes that port down, and then waits without listening on anything itself.
  const outside = "const c = require('node:child_process').spawn(process.execPath, ['-e', \"const s = require('node:http').createServer((q, r) => r.end('Hello, preview!')).listen(0, '127.0.0.1', () => require('node:fs').writeFileSync('outside', s.address().port + ' ' + process.pid))\"], { detached: true, stdio: 'ignore' }); c.unref(); setInterval(() => {}, 1000)";
  writeFileSync(join(dir, 'start.cjs'), outside);
  let seen: string | null = null;
  try {
    await assert.rejects(startPreview({ command: 'node start.cjs', cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 3000 }), /didn’t answer on a loopback port of its own within 3 s/);
    seen = readFileSync(join(dir, 'outside'), 'utf8');
    const [port] = seen.split(' ');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'Hello, preview!', 'the outside server did answer, with the page the preview would have served');
  } finally {
    if (seen) try { process.kill(Number(seen.split(' ')[1]), 'SIGKILL'); } catch { /* gone */ }
  }
});
