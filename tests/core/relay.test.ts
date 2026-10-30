// Nova's relay provider (M8 plan §2): a coding agent whose work is done by Relay's workers in git
// worktrees, over Relay's HTTP contract v1. Tested against the stand-in (scripts/stand-ins/
// fake-relay.js). Settings (loopback only), health in plain words, where the data goes as Relay
// reports it (and local-only refused unless Relay says local, again when the task starts), a run
// end to end with Nova's own checks deciding, a lying and a mismatched run, deletions, Relay's own
// failure, cancel, and a busy Relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { requestId } from '../../src/core/providers/relay.ts';
import { startFakeRelay } from '../../scripts/stand-ins/fake-relay.js';
import { BROKEN_SUM, FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const homes = new WeakMap<Core, string>();
function boot(privacy = 'cloud-allowed') {
  const home = mkdtempSync(join(tmpdir(), 'nova-relay-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true });
  homes.set(core, home);
  core.profile.set('privacy', 'default', privacy, 'settings');
  writeCalc(core.workspace.root);
  return core;
}

async function settle(core: Core, id: string, done = (s: string) => ['done', 'failed', 'cancelled', 'waiting'].includes(s)) {
  for (let i = 0; i < 600; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (done(t.state)) return t;
    await sleep(20);
  }
  return core.ledger.get(id);
}

// Settles, OK'ing the test run whenever Nova asks to run what Relay's worker wrote.
async function settleOK(core: Core, id: string) {
  let t = await settle(core, id);
  while (t.state === 'waiting' && core.providers.testAsk(id)) {
    core.providers.approveTest(id);
    t = await settle(core, id);
  }
  return t;
}

async function relayOn(core: Core, url: string, more: Record<string, unknown> = {}) {
  core.providers.configure('relay', { base_url: url, profile: 'Builder', poll_ms: 20, busy_retry_s: 1, ...more });
  core.providers.enable('relay', { approved: true });
  return core.providers.check('relay');
}

const sum = (core: Core) => readFileSync(join(core.workspace.root, 'calc', 'sum.mjs'), 'utf8');
const posts = (relay: { requests: { method: string; path: string; body: unknown; headers: Record<string, unknown> }[] }, path: string) => relay.requests.filter((r) => r.method === 'POST' && r.path === path);

test('requestId: a UUID from the idempotency key and the attempt, the same every time', () => {
  const a = requestId('key-1', 1);
  assert.match(a, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(requestId('key-1', 1), a, 'a retry of the same attempt never starts a second run');
  assert.notEqual(requestId('key-1', 2), a);
  assert.notEqual(requestId('key-2', 1), a);
});

test('settings: Relay is reached on this computer only, and it has no secrets', async () => {
  const core = boot();
  try {
    for (const bad of ['https://127.0.0.1:8766', 'http://relay.example.invalid:8766', 'http://192.168.1.20:8766', 'http://127.0.0.1:8766/api', 'not a url']) {
      assert.throws(() => core.providers.configure('relay', { base_url: bad }), (e: { details?: string[] }) => /on this computer \(loopback\)/.test((e.details ?? []).join(' ')), bad);
    }
    core.providers.configure('relay', { base_url: 'http://localhost:8766/' });
    const v = core.providers.view('relay');
    assert.equal(v.class, 'coding-agent');
    assert.equal(v.transport, 'http');
    assert.deepEqual(v.fields.map((f) => f.key), ['base_url', 'profile']);
    assert.ok(v.fields.every((f) => f.kind !== 'secret'));
  } finally {
    await core.close();
  }
});

test('health in plain words: not running, a different contract, no worker engine, ready', async () => {
  const core = boot();
  const relay = await startFakeRelay();
  try {
    const dead = await startFakeRelay();
    const deadUrl = dead.url;
    await dead.close();
    let v = await relayOn(core, deadUrl);
    assert.equal(v.health.state, 'unreachable');
    assert.match(v.health.words, new RegExp(`Relay isn’t running at ${deadUrl.replace('http://', '')}`));

    relay.set({ api: 2 });
    v = await (core.providers.configure('relay', { base_url: relay.url }, { confirm: true }), core.providers.check('relay'));
    assert.match(v.health.words, /speaks a different contract than Nova \(v1\)/);
    relay.set({ api: 1, workers: false });
    v = await core.providers.check('relay');
    assert.match(v.health.words, /Relay has no worker engine/);
    relay.set({ workers: true });
    v = await core.providers.check('relay');
    assert.equal(v.health.state, 'ready', v.health.words);
  } finally {
    await relay.close();
    await core.close();
  }
});

test('where the data goes is what Relay reports, and local-only is refused unless Relay says local', async () => {
  const core = boot('local-only');
  const relay = await startFakeRelay({ workerEgress: 'remote:anthropic' });
  try {
    let v = await relayOn(core, relay.url);
    assert.equal(v.health.state, 'ready', 'Relay itself is on this computer, so Nova checks it even under local-only');
    assert.equal(v.egress.coarse, 'remote');
    assert.equal(v.egress.receipt, 'remote:anthropic');
    assert.match(v.egress.words, /Relay.*Anthropic/);
    assert.throws(() => core.ledger.create({ ...calcTask('relay', { privacy_mode: 'local-only' }), origin: { kind: 'user' } } as never), /sends data off your devices, and this task is local-only/);

    relay.set({ workerEgress: 'local' });
    v = await core.providers.check('relay');
    assert.equal(v.egress.coarse, 'local');
    assert.equal(v.egress.receipt, 'local');

    // Checked again when the task starts: Relay switched to a remote engine after the last check.
    // The brief never reaches a worker.
    relay.set({ workerEgress: 'remote:anthropic' });
    const t = core.ledger.create({ ...calcTask('relay', { privacy_mode: 'local-only' }), origin: { kind: 'user' } } as never);
    const settled = await settle(core, t.id);
    assert.equal(settled.state, 'waiting');
    assert.match(String(settled.reason), /off your devices.*local-only/);
    assert.equal(posts(relay, '/api/workers').length, 0, 'nothing was started in Relay');
    assert.equal(posts(relay, '/api/tasks').length, 0);
  } finally {
    await relay.close();
    await core.close();
  }
});

test('a run: Relay’s worker fixes it in a worktree, Nova copies it in, runs the test itself, and records the run', async () => {
  const core = boot();
  const relay = await startFakeRelay({ lagMs: 40 });
  try {
    await relayOn(core, relay.url);
    const t = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    const done = await settleOK(core, t.id);
    assert.equal(done.state, 'done', String(done.reason));
    assert.deepEqual(done.verification!.checks.map((c) => c.requirement.kind).sort(), ['file_diff', 'test_result']);
    assert.equal(sum(core), FIXED_SUM, 'copied into the workspace after verification');

    // What Nova sent: the header on every change, a project folder in Nova's own state (never a .git
    // in the task's folder), check none (Nova runs the test), and a requestId from the brief.
    const mutations = (relay.requests as { method: string; headers: Record<string, unknown> }[]).filter((r) => r.method === 'POST' || r.method === 'PATCH');
    assert.ok(mutations.every((r) => r.headers['x-relay-client'] === 'relay-local'));
    assert.ok((relay.requests as { headers: Record<string, unknown> }[]).every((r) => r.headers.host === `127.0.0.1:${relay.port}` && !r.headers.origin));
    const project = posts(relay, '/api/projects')[0]!.body as { directory: string };
    assert.ok(project.directory.startsWith(join(homes.get(core)!, 'workers', 'providers', 'tasks', t.id)), project.directory);
    assert.ok(!existsSync(join(core.workspace.root, 'tasks', t.id, '.git')));
    const start = posts(relay, '/api/workers')[0]!.body as Record<string, unknown>;
    assert.equal(start.check, 'none');
    assert.equal(start.allowTests, false);
    assert.equal(start.requestId, requestId(t.brief.idempotency_key, 1));
    assert.match(String((posts(relay, '/api/tasks')[0]!.body as { outcome: string }).outcome), /Make the failing test in calc\/ pass/);

    // The Relay run, recorded as an artifact: its id, branch, worktree and base, and Relay's diff.
    const run = [...relay.runs.values()][0]!;
    const art = done.report!.artifacts.find((a) => a.kind === 'relay-run') as Record<string, unknown> | undefined;
    assert.ok(art, JSON.stringify(done.report!.artifacts));
    assert.equal(art.ref, run.id);
    assert.equal(art.branch, `relay/${run.id}`);
    assert.equal(art.worktree, run.worktree.directory);
    assert.equal(art.baseCommit, run.baseCommit);
    assert.match(String(art.diff), /a \+ b/);

    // The receipt says where Relay said the brief went.
    assert.deepEqual(core.receipts.list({ task_id: t.id }).map((r) => [r.provider, r.egress]), [['relay', 'local']]);
  } finally {
    await relay.close();
    await core.close();
  }
});

test('a lying run fails with the verifier’s reason, and nothing is copied back', async () => {
  const core = boot();
  const relay = await startFakeRelay({ mode: 'lying' });
  try {
    await relayOn(core, relay.url);
    const t = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    const end = await settleOK(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(String(end.reason), /evidence didn.t hold up/i);
    assert.equal(sum(core), BROKEN_SUM);
    // Each attempt is a run of its own, with its own requestId.
    const ids = posts(relay, '/api/workers').map((r) => (r.body as { requestId: string }).requestId);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await relay.close();
    await core.close();
  }
});

test('Relay’s file list must match its worktree: a mismatch fails with that reason, and nothing is copied', async () => {
  const core = boot();
  const relay = await startFakeRelay({ mode: 'mismatched' });
  try {
    await relayOn(core, relay.url);
    const t = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    const end = await settleOK(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(String(end.reason), /calc\/notes\.md/);
    assert.match(String(end.reason), /Relay/);
    assert.equal(sum(core), BROKEN_SUM);
    assert.ok(!existsSync(join(core.workspace.root, 'calc', 'notes.md')));
  } finally {
    await relay.close();
    await core.close();
  }
});

test('deletions come back too', async () => {
  const core = boot();
  writeFileSync(join(core.workspace.root, 'calc', 'old.mjs'), 'export const old = 1;\n');
  const relay = await startFakeRelay({ mode: 'script', script: { writes: [{ path: 'calc/sum.mjs', content: FIXED_SUM }, { path: 'calc/old.mjs', content: null }], summary: 'Fixed sum, removed old.' } });
  try {
    await relayOn(core, relay.url);
    const t = core.ledger.create({ ...calcTask('relay', { inputs: { test_command: 'node --test calc/sum.test.mjs', editable: ['calc/sum.mjs', 'calc/old.mjs'] } }), origin: { kind: 'user' } } as never);
    const done = await settleOK(core, t.id);
    assert.equal(done.state, 'done', String(done.reason));
    assert.equal(sum(core), FIXED_SUM);
    assert.ok(!existsSync(join(core.workspace.root, 'calc', 'old.mjs')), 'the deletion was copied back');
  } finally {
    await relay.close();
    await core.close();
  }
});

test('Relay’s own failure ends the task failed with Relay’s reason', async () => {
  const core = boot();
  const relay = await startFakeRelay({ mode: 'failing' });
  try {
    await relayOn(core, relay.url);
    const t = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    const end = await settle(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(String(end.reason), /its engine reported an error/);
    assert.equal(sum(core), BROKEN_SUM);
  } finally {
    await relay.close();
    await core.close();
  }
});

test('an unknown profile is said plainly; without one, the first profile that can run workers', async () => {
  const core = boot();
  const relay = await startFakeRelay();
  try {
    await relayOn(core, relay.url, { profile: 'Nobody' });
    const t = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    const end = await settle(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(String(end.reason), /no profile called “Nobody”/);

    core.providers.configure('relay', { profile: '' });
    writeCalc(core.workspace.root);
    const t2 = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    assert.equal((await settleOK(core, t2.id)).state, 'done');
    const builder = relay.profiles.find((p: { name: string }) => p.name === 'Builder');
    assert.equal((posts(relay, '/api/workers').at(-1)!.body as { profileId: string }).profileId, builder.id);
  } finally {
    await relay.close();
    await core.close();
  }
});

test('cancelling the task cancels the run in Relay', async () => {
  const core = boot();
  const relay = await startFakeRelay({ slowMs: 5000 });
  try {
    await relayOn(core, relay.url);
    const t = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    for (let i = 0; i < 200 && ![...relay.runs.values()].some((r) => r.status === 'running'); i++) await sleep(20);
    core.ledger.cancel(t.id);
    for (let i = 0; i < 100 && !relay.cancels.length; i++) await sleep(20);
    assert.equal(relay.cancels.length, 1, 'the cancel reached Relay');
    assert.equal(relay.cancels[0], [...relay.runs.values()][0]!.id);
    assert.equal(core.ledger.get(t.id).state, 'cancelled');
    assert.equal(sum(core), BROKEN_SUM);
  } finally {
    await relay.close();
    await core.close();
  }
});

test('a busy Relay: the task waits with the reason, then runs by itself once Relay is free', async () => {
  const core = boot();
  const relay = await startFakeRelay({ busy: 2 });
  try {
    await relayOn(core, relay.url);
    const t = core.ledger.create({ ...calcTask('relay'), origin: { kind: 'user' } } as never);
    const waiting = await settle(core, t.id);
    assert.equal(waiting.state, 'waiting');
    assert.match(String(waiting.reason), /Relay is busy with another run/);
    // Nobody retries it: Nova tries Relay again by itself.
    await settle(core, t.id, (s) => s !== 'waiting' || !/busy/.test(String(core.ledger.get(t.id).reason)));
    const end = await settleOK(core, t.id);
    assert.equal(end.state, 'done', String(end.reason));
    assert.equal(posts(relay, '/api/workers').length, 3, 'two busy answers, then the run');
    assert.equal(relay.runs.size, 1);
    assert.equal(sum(core), FIXED_SUM);
  } finally {
    await relay.close();
    await core.close();
  }
});
