// The relay provider, after the M8b review: what the review found, each made a test.
// 1. Privacy is judged on Relay's fresh answer, right before a worker starts, against the Relay the
//    brief goes to; the receipt says what that answer was.
// 2. Nova never runs git in a worktree Relay names, and takes a worktree only where Relay keeps them.
// 3. A retry after a busy answer starts from the task's files as they are now.
// 4. A busy Relay costs one Relay task, no receipts, and Nova stops asking after a while.
// 5. Cancelling while the start is on its way cancels the run it started.
// 6. The requestId belongs to the task, not only to its idempotency key.
// 7. Copy-back checks everything before it writes anything.
// 8. Relay's answers are read up to a limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { requestId } from '../../src/core/providers/relay.ts';
import { startFakeRelay } from '../../scripts/stand-ins/fake-relay.js';
import { BROKEN_SUM, FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const homes = new WeakMap<Core, string>();

function boot(privacy = 'cloud-allowed') {
  const home = mkdtempSync(join(tmpdir(), 'nova-relay-review-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true });
  homes.set(core, home);
  core.profile.set('privacy', 'default', privacy, 'settings');
  writeCalc(core.workspace.root);
  return core;
}

async function relayOn(core: Core, url: string, more: Record<string, unknown> = {}) {
  core.providers.configure('relay', { base_url: url, profile: 'Builder', poll_ms: 20, busy_retry_s: 1, ...more }, { confirm: true });
  if (!core.providers.view('relay').enabled) core.providers.enable('relay', { approved: true });
  return core.providers.check('relay');
}

// Until the task ends, OK'ing the test run whenever Nova asks; `until` stops earlier.
async function finish(core: Core, id: string, until: (t: ReturnType<Core['ledger']['get']>) => boolean = () => false, ms = 20_000) {
  const end = Date.now() + ms;
  let t = core.ledger.get(id);
  while (Date.now() < end) {
    await core.ledger.idle();
    t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled'].includes(t.state) || until(t)) return t;
    if (t.state === 'waiting' && core.providers.testAsk(id)) core.providers.approveTest(id);
    await sleep(15);
  }
  return t;
}

const posts = (relay: { requests: { method: string; path: string; body: unknown }[] }, path: string) => relay.requests.filter((r) => r.method === 'POST' && r.path === path);
const brief = (core: Core, over: Record<string, unknown> = {}) => core.ledger.create({ ...calcTask('relay', over), origin: { kind: 'user' } } as never);
const sum = (core: Core) => readFileSync(join(core.workspace.root, 'calc', 'sum.mjs'), 'utf8');

// ---- 1. privacy on the fresh answer ---------------------------------------------------------------

test('1. Relay switches to a remote engine after Nova’s check: a local-only task never reaches a worker', async () => {
  const core = boot('local-only');
  const relay = await startFakeRelay({ workerEgress: 'local' });
  try {
    const v = await relayOn(core, relay.url);
    assert.equal(v.egress.receipt, 'local');
    // Relay changes its engine while Nova is setting up the run (after it read the profiles).
    relay.set({ hooks: { request: (r: { path: string }, o: { workerEgress: string }) => { if (r.path === '/api/state') o.workerEgress = 'remote:anthropic'; } } });
    const t = brief(core, { privacy_mode: 'local-only' });
    const end = await finish(core, t.id, (x) => x.state === 'waiting');
    assert.equal(posts(relay, '/api/workers').length, 0, 'no worker was started');
    assert.equal(end.state, 'waiting');
    assert.match(String(end.reason), /local-only/);
    assert.deepEqual(core.receipts.list({ task_id: t.id }), [], 'no receipt: nothing went to a worker');
  } finally {
    await relay.close();
    await core.close();
  }
});

test('1. the receipt says where Relay said the brief went when the worker started', async () => {
  const core = boot('cloud-allowed');
  const relay = await startFakeRelay({ workerEgress: 'local' });
  try {
    await relayOn(core, relay.url);
    relay.set({ hooks: { request: (r: { path: string }, o: { workerEgress: string }) => { if (r.path === '/api/state') o.workerEgress = 'remote:anthropic'; } } });
    const t = brief(core);
    const end = await finish(core, t.id);
    assert.equal(end.state, 'done', String(end.reason));
    assert.deepEqual(core.receipts.list({ task_id: t.id }).map((r) => r.egress), ['remote:anthropic']);
  } finally {
    await relay.close();
    await core.close();
  }
});

// A proxy in front of a Relay that holds a status answer while `hold` is set, and says when it has one.
async function holdingProxy(target: string) {
  let hold = false;
  let held: () => void = () => {};
  const arrived = new Promise<void>((r) => { held = r; });
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (hold && req.method === 'GET' && req.url === '/api/status') { held(); await sleep(400); }
    const r = await fetch(target + req.url, { method: req.method, headers: { ...(req.headers as Record<string, string>), host: new URL(target).host }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(await r.text());
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, arm: () => { hold = true; }, arrived, close: () => srv.close() };
}

test('1. Relay’s address changed while Nova checked it: the brief goes only where the check was made', async () => {
  const core = boot('local-only');
  const near = await startFakeRelay({ workerEgress: 'local' });
  const far = await startFakeRelay({ workerEgress: 'local' });
  const p = await holdingProxy(far.url);
  try {
    await relayOn(core, near.url);
    await relayOn(core, p.url);
    await sleep(100);
    // The Relay behind the proxy now sends to Anthropic; Nova's last word on it is still "local".
    far.set({ workerEgress: 'remote:anthropic' });
    p.arm();
    const t = brief(core, { privacy_mode: 'local-only' });
    await p.arrived;
    // While Nova is asking it, the address is changed back to the local Relay.
    core.providers.configure('relay', { base_url: near.url }, { confirm: true });
    await finish(core, t.id, (x) => x.state === 'waiting');
    assert.equal(posts(far, '/api/workers').length, 0, 'the Relay that sends to Anthropic never started a worker');
  } finally {
    p.close();
    await near.close();
    await far.close();
    await core.close();
  }
});

test('1. the words for a local Relay say what "local" can’t tell', async () => {
  const core = boot();
  const relay = await startFakeRelay({ workerEgress: 'local' });
  try {
    const v = await relayOn(core, relay.url);
    assert.match(v.egress.words, /proxy/);
  } finally {
    await relay.close();
    await core.close();
  }
});

// ---- 2. the worktree -------------------------------------------------------------------------------

test('2. a worktree with a hostile .git: Nova runs nothing from it', async () => {
  const core = boot();
  const marker = join(mkdtempSync(join(tmpdir(), 'nova-marker-')), 'ran');
  const relay = await startFakeRelay({
    hooks: {
      beforeComplete: (run: { worktree: { directory: string } }) => {
        // The worktree's .git now points at a repository whose config runs a command (fsmonitor).
        const repo = (posts(relay, '/api/projects').at(-1)!.body as { directory: string }).directory;
        const evil = mkdtempSync(join(tmpdir(), 'nova-evil-'));
        cpSync(join(repo, '.git'), join(evil, '.git'), { recursive: true });
        execFileSync('git', ['config', '-f', join(evil, '.git', 'config'), 'core.fsmonitor', `touch ${marker}`]);
        writeFileSync(join(run.worktree.directory, '.git'), `gitdir: ${join(evil, '.git')}\n`);
        return null;
      },
    },
  });
  try {
    await relayOn(core, relay.url);
    const t = brief(core);
    await finish(core, t.id);
    assert.equal(existsSync(marker), false, 'no command from the worktree’s git config ran');
  } finally {
    await relay.close();
    await core.close();
  }
});

test('2. a worktree outside Relay’s own worktrees folder is refused, and so are bad paths in its list', async () => {
  for (const [label, patch] of [
    ['outside', (run: any) => {
      const other = mkdtempSync(join(tmpdir(), 'nova-elsewhere-'));
      cpSync(run.worktree.directory, other, { recursive: true });
      return { worktree: { ...run.worktree, directory: other } };
    }],
    ['absolute', (run: any) => ({ review: { ...run.review, files: ['/etc/hostname'], totalFiles: 1 } })],
    ['climbs', (run: any) => ({ review: { ...run.review, files: ['../calc/sum.mjs'], totalFiles: 1 } })],
    ['git', (run: any) => ({ review: { ...run.review, files: ['.git/config'], totalFiles: 1 } })],
    ['link', (run: any) => { symlinkSync('/etc/hostname', join(run.worktree.directory, 'calc', 'sum.mjs.link')); return { review: { ...run.review, files: ['calc/sum.mjs', 'calc/sum.mjs.link'], totalFiles: 2 } }; }],
  ] as const) {
    const core = boot();
    const relay = await startFakeRelay({ hooks: { beforeComplete: patch } });
    try {
      await relayOn(core, relay.url);
      const t = brief(core);
      const end = await finish(core, t.id);
      assert.equal(end.state, 'failed', `${label}: ${end.reason}`);
      assert.equal(sum(core), BROKEN_SUM, `${label}: nothing copied`);
      assert.ok(!existsSync(join(core.workspace.root, 'tasks', t.id, 'calc', 'sum.mjs.link')), `${label}: no link copied`);
    } finally {
      await relay.close();
      await core.close();
    }
  }
});

// ---- 3. a retry after busy starts from the files as they are ---------------------------------------

test('3. a file edited while Relay was busy is in what the retry hands Relay', async () => {
  const core = boot();
  const relay = await startFakeRelay({ busy: 1 });
  try {
    await relayOn(core, relay.url);
    const t = brief(core);
    await finish(core, t.id, (x) => x.state === 'waiting' && /busy/.test(String(x.reason)));
    const f = join(core.workspace.root, 'calc', 'sum.test.mjs');
    writeFileSync(f, `${readFileSync(f, 'utf8')}// edited while Relay was busy\n`);
    const end = await finish(core, t.id);
    assert.equal(end.state, 'done', String(end.reason));
    const run = [...relay.runs.values()].at(-1) as { worktree: { directory: string } };
    assert.match(readFileSync(join(run.worktree.directory, 'calc', 'sum.test.mjs'), 'utf8'), /edited while Relay was busy/);
  } finally {
    await relay.close();
    await core.close();
  }
});

// ---- 4. busy, again and again ----------------------------------------------------------------------

test('4. an always-busy Relay: one Relay task, no receipts, and Nova stops asking at its limit', async () => {
  const core = boot();
  const relay = await startFakeRelay({ busy: 100_000 });
  try {
    await relayOn(core, relay.url, { busy_limit: 3 });
    const t = brief(core);
    const end = await finish(core, t.id, (x) => /has been busy for/.test(String(x.reason)), 15_000);
    assert.match(String(end.reason), /Relay has been busy for 3 seconds/);
    assert.equal(end.state, 'waiting');
    assert.equal(end.attempts, 0);
    assert.equal(posts(relay, '/api/tasks').length, 1, 'one Relay task for the attempt');
    assert.deepEqual(core.receipts.list({ task_id: t.id }), [], 'no receipts: no worker got the brief');
    const asked = posts(relay, '/api/workers').length;
    await sleep(2500);
    assert.equal(posts(relay, '/api/workers').length, asked, 'Nova stopped asking');
  } finally {
    await relay.close();
    await core.close();
  }
});

// ---- 5. cancel while the start is on its way --------------------------------------------------------

test('5. cancelled while the start was on its way: the run it started is cancelled in Relay', async () => {
  const core = boot();
  const relay = await startFakeRelay({ slowMs: 20_000, startDelayMs: 1500 });
  try {
    await relayOn(core, relay.url);
    const t = brief(core);
    for (let i = 0; i < 300 && !relay.runs.size; i++) await sleep(10);
    assert.equal(relay.runs.size, 1, 'the run exists, its 202 not yet sent');
    core.ledger.cancel(t.id);
    for (let i = 0; i < 300 && !relay.cancels.length; i++) await sleep(10);
    assert.deepEqual(relay.cancels, [[...relay.runs.values()][0]!.id]);
  } finally {
    await relay.close();
    await core.close();
  }
});

// ---- 6. requestId ------------------------------------------------------------------------------------

test('6. the requestId belongs to the task: the same key on another task is another id', () => {
  const base = 'a'.repeat(40);
  const a = requestId('task-a', 'key', 1, base);
  assert.match(a, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(requestId('task-a', 'key', 1, base), a);
  assert.notEqual(requestId('task-b', 'key', 1, base), a);
  assert.notEqual(requestId('task-a', 'key', 2, base), a);
  assert.notEqual(requestId('task-a', 'key', 1, 'b'.repeat(40)), a);
});

// ---- 7. copy-back ------------------------------------------------------------------------------------

test('7. an oversized file is refused before anything is written', { timeout: 60_000 }, async () => {
  const core = boot();
  const relay = await startFakeRelay({ mode: 'script', script: { writes: [{ path: 'calc/sum.mjs', content: FIXED_SUM }, { path: 'calc/big.bin', content: 'x'.repeat(51 * 1024 * 1024) }], summary: 'Fixed it, and left a big file.' } });
  try {
    await relayOn(core, relay.url);
    const t = brief(core);
    const end = await finish(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(String(end.reason), /50 MB/);
    const folder = join(core.workspace.root, 'tasks', t.id);
    assert.ok(!existsSync(join(folder, 'calc', 'big.bin')), 'the big file was never written');
    assert.equal(readFileSync(join(folder, 'calc', 'sum.mjs'), 'utf8'), BROKEN_SUM, 'nor anything else');
  } finally {
    await relay.close();
    await core.close();
  }
});

test('7. a file that becomes a folder comes back as one', async () => {
  const core = boot();
  writeFileSync(join(core.workspace.root, 'calc', 'data'), 'one file\n');
  const relay = await startFakeRelay({ mode: 'script', script: { writes: [{ path: 'calc/sum.mjs', content: FIXED_SUM }, { path: 'calc/data', content: null }, { path: 'calc/data/part.txt', content: 'now a folder\n' }], summary: 'Fixed sum; data is a folder now.' } });
  try {
    await relayOn(core, relay.url);
    const t = brief(core, { inputs: { test_command: 'node --test calc/sum.test.mjs', editable: ['calc/sum.mjs', 'calc/data', 'calc/data/**'] } });
    const end = await finish(core, t.id);
    assert.equal(end.state, 'done', String(end.reason));
    assert.equal(readFileSync(join(core.workspace.root, 'calc', 'data', 'part.txt'), 'utf8'), 'now a folder\n');
  } finally {
    await relay.close();
    await core.close();
  }
});

// ---- 8. answer size ----------------------------------------------------------------------------------

test('8. an answer from Relay over the limit fails in plain words', async () => {
  const core = boot();
  // A run record is read up to 8 MB (a whole store, /api/state, up to 64 MB; the rest 1 MB).
  const relay = await startFakeRelay({ hooks: { beforeComplete: () => ({ text: 'x'.repeat(9 * 1024 * 1024) }) } });
  try {
    await relayOn(core, relay.url);
    const t = brief(core);
    const end = await finish(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(String(end.reason), /over 8 MB/);
    assert.equal(sum(core), BROKEN_SUM);
  } finally {
    await relay.close();
    await core.close();
  }
});

// ---- the re-review ---------------------------------------------------------------------------------

// Runs `fn` with HOME pointing at a folder whose .gitconfig is `config` (and any other files), as a
// person's own git settings would be, for Nova and the stand-in alike.
async function withGitHome(config: string, files: Record<string, string>, fn: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'nova-githome-'));
  writeFileSync(join(home, '.gitconfig'), config);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, name), text);
  const was = process.env.HOME;
  process.env.HOME = home;
  try { await fn(); } finally { process.env.HOME = was; }
}

async function calcRun(prep: (core: Core) => void = () => {}, opts: Parameters<typeof startFakeRelay>[0] = {}, more: Record<string, unknown> = {}) {
  const core = boot();
  prep(core);
  const relay = await startFakeRelay(opts);
  try {
    await relayOn(core, relay.url, more);
    const t = brief(core);
    return { end: await finish(core, t.id, () => false, 30_000), relay, core, t };
  } finally {
    await relay.close();
    await core.close();
  }
}

test('R1. a file the task’s own .gitignore ignores doesn’t fail the run', async () => {
  const { end } = await calcRun((core) => {
    writeFileSync(join(core.workspace.root, 'calc', '.gitignore'), '*.log\n');
    writeFileSync(join(core.workspace.root, 'calc', 'debug.log'), 'x\n');
  });
  assert.equal(end.state, 'done', String(end.reason));
});

test('R1. a person’s global excludes file doesn’t fail the run', async () => {
  await withGitHome('[core]\n\texcludesFile = ~/ignore-these\n', { 'ignore-these': '*.log\n' }, async () => {
    const { end } = await calcRun((core) => writeFileSync(join(core.workspace.root, 'calc', 'debug.log'), 'x\n'));
    assert.equal(end.state, 'done', String(end.reason));
  });
});

test('R1. line endings: core.autocrlf in the person’s git settings doesn’t fail the run', async () => {
  await withGitHome('[core]\n\tautocrlf = true\n', {}, async () => {
    const { end } = await calcRun();
    assert.equal(end.state, 'done', String(end.reason));
  });
});

test('R1. line endings: the task’s own .gitattributes doesn’t change what Relay is handed', async () => {
  const { end, relay } = await calcRun((core) => writeFileSync(join(core.workspace.root, 'calc', '.gitattributes'), '* text eol=crlf\n'));
  assert.equal(end.state, 'done', String(end.reason));
  const run = [...relay.runs.values()][0] as { worktree: { directory: string } };
  assert.ok(!readFileSync(join(run.worktree.directory, 'calc', 'sum.test.mjs'), 'utf8').includes('\r'), 'the bytes Relay got are the task’s bytes');
});

test('R2. Relay’s whole store over 1 MB (it grows with its history) doesn’t stop a run', async () => {
  const { end } = await calcRun(() => {}, { stateExtra: { runs: [{ review: { diff: 'x'.repeat(1_500_000) } }] } });
  assert.equal(end.state, 'done', String(end.reason));
});

test('R3. a start that outlasts Nova’s wait for an answer: the run it started is found and followed', { timeout: 60_000 }, async () => {
  const { end, relay } = await calcRun(() => {}, { startDelayMs: 1500 }, { request_timeout_s: 1 });
  assert.equal(end.state, 'done', String(end.reason));
  assert.equal(relay.runs.size, 1, 'one run, found again by its requestId');
});

test('R4. a hard link in the worktree is refused', async () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'nova-outside-')), 'secret.mjs');
  writeFileSync(outside, 'export const secret = 1;\n');
  const { end, core, t } = await calcRun(() => {}, {
    hooks: { beforeComplete: (run: any) => { linkSync(outside, join(run.worktree.directory, 'calc', 'linked.mjs')); return { review: { ...run.review, files: [...run.review.files, 'calc/linked.mjs'], totalFiles: run.review.totalFiles + 1 } }; } },
  });
  assert.equal(end.state, 'failed', String(end.reason));
  assert.ok(!existsSync(join(core.workspace.root, 'tasks', t.id, 'calc', 'linked.mjs')));
});

test('R4. a worktree deeper than Nova walks is refused plainly', async () => {
  const deep = `calc/${'d/'.repeat(70)}x.txt`;
  const { end } = await calcRun(() => {}, {
    hooks: { beforeComplete: (run: any) => { mkdirSync(join(run.worktree.directory, ...deep.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(run.worktree.directory, deep), 'x'); return { review: { ...run.review, files: [...run.review.files, deep], totalFiles: run.review.totalFiles + 1 } }; } },
  });
  assert.equal(end.state, 'failed');
  assert.match(String(end.reason), /deeper than|64 folders/);
});

test('R4. a run id that isn’t a UUID is refused', { timeout: 90_000 }, async () => {
  const core = boot();
  const relay = await startFakeRelay();
  // A proxy that says the run is called something else.
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await fetch(relay.url + req.url, { method: req.method, headers: { ...(req.headers as Record<string, string>), host: new URL(relay.url).host }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    let body = await r.text();
    if (req.method === 'POST' && req.url === '/api/workers' && r.status === 202) body = JSON.stringify({ ...JSON.parse(body), id: '../../etc' });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    await relayOn(core, `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    const t = brief(core);
    const end = await finish(core, t.id, () => false, 80_000);
    assert.equal(end.state, 'failed');
    assert.match(String(end.reason), /run id/);
  } finally {
    srv.close();
    await relay.close();
    await core.close();
  }
});
