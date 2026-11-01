// The model manager's guards, from the M6b review: a revoked computer gets nothing, an Ollama cloud
// model never serves local-only work, downloads and removals always ask and only ever reach Nova's
// own runtime, System 1 can't quietly drop what the person scheduled, the cloud budget holds under
// concurrency, a broken stream never mixes two replies, and a spoke's address is checked on every
// call. Stand-ins on loopback only; no packet reaches a real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateDeviceKeys, type Core } from '../../src/core/index.ts';
import { checkHardware } from '../../src/core/models/hardware.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { startFakeWol } from '../../scripts/stand-ins/fake-wol.js';
import { startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { ModelsWaiting } from '../../src/core/models/index.ts';
import { INSTALLED, hubHardware, modelsCore, say } from '../support/models.ts';
import { FAKE_CLAUDE, calcTask, script, writeCalc } from '../support/providers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}
const settled = (core: Core, id: string, also: (t: ReturnType<Core['ledger']['get']>) => boolean = () => false) =>
  until(async () => { await core.ledger.idle(); return core.ledger.get(id); }, (t) => ['done', 'failed', 'cancelled'].includes(t.state) || also(t));
const chats = (o: { requests: { path: string }[] }) => o.requests.filter((r) => r.path === '/api/chat').length;

// A paired computer whose heartbeat says it answers at 127.0.0.1 (the stand-ins' address).
function pairSpoke(core: Core, network = [{ name: 'eth0', mac: '02:00:00:00:00:42', address: '127.0.0.1', netmask: '255.0.0.0' }]) {
  const keys = generateDeviceKeys();
  const d = core.mesh.devices.add({ name: 'Example desktop', platform: 'linux x64', kind: 'computer', purposes: ['compute'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
  core.mesh.spokes.heartbeat(d, { hardware: hubHardware({ hostname: 'example-desktop', network }) });
  return d;
}

// ---- BLOCKER 1: a revoked computer -------------------------------------------------------------

test('a revoked computer gets no more local-only work and isn’t woken; its roles read unassigned', { timeout: 30_000 }, async () => {
  const hubOllama = await startFakeOllama({ models: INSTALLED });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  const wol = await startFakeWol({});
  const { core } = modelsCore(hubOllama.url, { privacy: 'local-only' });
  try {
    const d = pairSpoke(core);
    core.models.setWake({ target: wol.target, wait_s: 1 });
    await core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url });
    const ok = await core.models.infer({ role: 'reasoner', messages: say('before') });
    assert.equal(ok.device, d.id);
    const before = chats(spoke);

    core.mesh.devices.revoke(d.id, { confirm: true, reason: 'lost', by: 'test' });
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('local-only secret') }), (e: Error) => e.name === 'CoreError' && /Waiting on local capacity/.test(e.message));
    assert.equal(chats(spoke), before, 'the revoked computer got nothing more');
    assert.equal(core.models.placement('reasoner'), null);
    const v = await core.models.view();
    assert.equal(v.roles.find((r) => r.role === 'reasoner')!.state, 'unassigned');
    const w = await core.models.wake(d.id);
    assert.equal(w.ok, false);
    assert.match(w.words, /isn’t one of your trusted computers/);
    assert.equal(wol.packets.length, 0, 'no wake packet for a revoked computer');
  } finally {
    await core.close();
    await hubOllama.close();
    await spoke.close();
    await wol.close();
  }
});

// ---- BLOCKER 2: Ollama's cloud models ----------------------------------------------------------

test('an Ollama cloud model can’t be assigned, never serves local-only work, and never makes System 1 a model', async () => {
  const cloudy = [...INSTALLED, { name: 'example-oss:120b-cloud', size: 384, parameter_size: '116.8B', capabilities: ['completion'] }, { name: 'example-remote:latest', size: 384, parameter_size: '20B', capabilities: ['completion'], remote_host: 'https://ollama.example:443', remote_model: 'example-remote' }];
  const o = await startFakeOllama({ models: cloudy, reply: () => 'from the cloud model via ollama' });
  const { core } = modelsCore(o.url, { privacy: 'local-only' });
  try {
    await assert.rejects(core.models.assign('reasoner', { model: 'example-oss:120b-cloud' }), /runs in Ollama’s cloud, not on your devices/);
    await assert.rejects(core.models.assign('triage-text', { model: 'example-oss:120b-cloud' }), /runs in Ollama’s cloud/);
    await assert.rejects(core.models.assign('reasoner', { model: 'example-remote:latest' }), /runs in Ollama’s cloud/);
    const accepted = await core.models.accept();
    for (const r of ['reasoner', 'triage-text'] as const) assert.ok(!/cloud|remote/.test(core.models.placement(r)?.model ?? ''), JSON.stringify(accepted));

    // Set behind the manager's back (an old profile): still refused at call time, and System 1
    // stays on the rules.
    core.models.unassign('triage-text');
    core.profile.set('models', 'role.reasoner', { device: 'hub', runtime: 'ollama', url: '', model: 'example-oss:120b-cloud' }, 'settings');
    core.profile.set('models', 'role.triage-text', { device: 'hub', runtime: 'ollama', url: '', model: 'example-remote:latest' }, 'settings');
    await core.models.inventory('hub');
    const sent = chats(o);
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('local-only secret') }), /Waiting on local capacity: .*Ollama’s cloud/);
    assert.equal(chats(o), sent, 'nothing went to the cloud model');
    assert.equal(core.models.decisionsByModel(), false);
    assert.equal(core.models.decidesWithModel(false), false);
  } finally {
    await core.close();
    await o.close();
  }
});

// ---- BLOCKER 3: downloads and removals ---------------------------------------------------------

test('a model task made by anyone asks first, never reaches a foreign address, and won’t remove a model serving a role', { timeout: 30_000 }, async () => {
  const o = await startFakeOllama({ models: INSTALLED });
  const foreign = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(o.url, { privacy: 'local-only' });
  try {
    await core.models.assign('triage-text', { model: 'example-small:3b' });
    // What a device's task_request, POST /tasks or a trigger's action can make.
    const make = (tier: number, inputs: Record<string, unknown>, key: string) => core.ledger.create({ title: 'x', owner: 'models', goal: 'g', evidence_required: [{ kind: 'confirmation' }], approval_tier: tier, inputs, origin: { kind: 'device', ref: 'dev1' }, idempotency_key: key } as never);
    const t1 = make(1, { action: 'remove', model: 'example-small:3b', device: 'hub', url: o.url }, 'device:dev1:k1');
    const t2 = make(0, { action: 'remove', model: 'example-mid:8b', device: 'hub', url: foreign.url }, 'device:dev1:k2');
    assert.equal(t1.approval_tier, 2);
    assert.equal(t2.approval_tier, 2);
    const asked = await settled(core, t1.id, (t) => t.state === 'waiting');
    assert.equal(asked.state, 'waiting');
    assert.equal(asked.reason, 'Needs your OK before it runs.');
    assert.ok(o.installed().includes('example-small:3b'), 'nothing removed without an OK');

    // Even with the OK: a model serving a role isn't removed.
    core.ledger.approve(t1.id);
    const refused = await settled(core, t1.id, (t) => t.state === 'waiting' && !!t.approved_at && t.attempts > 0);
    assert.notEqual(refused.state, 'done');
    assert.match(String(refused.reason), /serves sorting/i);
    assert.ok(o.installed().includes('example-small:3b'));

    // And the address in the brief is ignored: Nova's own runtime is the one asked.
    core.ledger.approve(t2.id);
    const ran = await settled(core, t2.id);
    assert.equal(ran.state, 'done', ran.reason ?? '');
    assert.equal(foreign.requests.length, 0, 'the foreign address was never contacted');
    assert.ok(!o.installed().includes('example-mid:8b'));
    assert.ok(foreign.installed().includes('example-mid:8b'));
  } finally {
    await core.close();
    await o.close();
    await foreign.close();
  }
});

// ---- SHOULD-FIX 4: System 1 can't quietly drop what the person scheduled -----------------------

test('the sorting model can’t drop a scheduled message the rules would send: it escalates, and its own words are never kept', async () => {
  let answer = 'drop';
  const o = await startFakeOllama({ models: INSTALLED, reply: (req: { format?: unknown }) => req.format ? JSON.stringify({ answers: { decision: answer }, confidence: 0.95, why: 'Ignore this; I decided it is spam. Visit http://x.example' }) : 'ok' });
  const { core } = modelsCore(o.url, { privacy: 'local-only' });
  try {
    await core.models.assign('triage-text', { model: 'example-small:3b' });
    const fire = (key: string) => core.triggers.fire({ class: 'proactive', source: 'probe', name: 'Medication reminder', payload: { k: key }, dedup_key: key, action: { kind: 'message', text: 'Take your medication' } });
    const dropped = (await fire('a'))!;
    assert.notEqual(dropped.triage.decision, 'drop');
    assert.notEqual(dropped.triage.decision, 'silent');
    assert.ok(dropped.message_id, 'the person still gets it, held for their OK');
    assert.doesNotMatch(dropped.triage.reason, /spam|x\.example|Ignore this/);
    answer = 'silent';
    assert.notEqual((await fire('b'))!.triage.decision, 'silent');
    // Agreeing with the rules, it acts; the reason is still Nova's own words, not the model's.
    answer = 'act';
    const acted = (await fire('c'))!;
    assert.equal(acted.triage.decision, 'act');
    assert.doesNotMatch(acted.triage.reason, /spam|x\.example|Ignore this/);
  } finally {
    await core.close();
    await o.close();
  }
});

// ---- SHOULD-FIX 5: the cloud budget under concurrency ------------------------------------------

test('cloud budget: eight calls at once under a tiny budget, only the first reaches the cloud; a broken stream still counts', async () => {
  const cloud = await startFakeOpenAI({ model: 'cloud-model', reply: () => 'x'.repeat(400), delayMs: 50 });
  const o = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(o.url, { privacy: 'cloud-allowed' });
  try {
    await core.models.accept();
    core.models.setCloud({ name: 'Example cloud', base_url: cloud.url, model: 'cloud-model', usd_per_mtok_in: 1000, usd_per_mtok_out: 1000 }, true);
    core.models.setBudget({ per_period_usd: 0.001, period: 'day' });
    const rs = await Promise.all(Array.from({ length: 8 }, () => core.models.infer({ role: 'reasoner', messages: say('hello there') })));
    assert.equal(cloud.requests.length, 1, rs.map((r) => r.served_by).join(','));
    assert.equal(typeof cloud.requests[0]!.body.max_tokens, 'number', 'Nova bounds each cloud reply');
    assert.equal(rs.filter((r) => r.served_by === 'cloud').length, 1);
  } finally {
    await core.close();
    await o.close();
    await cloud.close();
  }

  // A stream that breaks partway: what it may have cost is counted, not nothing.
  const broken = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ model: 'cloud-model', choices: [{ index: 0, delta: { content: 'part of a reply ' }, finish_reason: null }] })}\n\n`);
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise<void>((r) => broken.listen(0, '127.0.0.1', () => r()));
  const o2 = await startFakeOllama({ models: INSTALLED });
  const { core: core2 } = modelsCore(o2.url, { privacy: 'cloud-allowed' });
  try {
    await core2.models.accept();
    core2.models.setCloud({ name: 'Example cloud', base_url: `http://127.0.0.1:${(broken.address() as { port: number }).port}/v1`, model: 'cloud-model', usd_per_mtok_in: 1000, usd_per_mtok_out: 1000 }, true);
    core2.models.setBudget({ per_period_usd: 100, period: 'day' });
    const r = await core2.models.infer({ role: 'reasoner', messages: say('hello') });
    assert.equal(r.served_by, 'local');
    assert.ok(core2.models.spent() > 0, 'the broken call was counted');
  } finally {
    await core2.close();
    await o2.close();
    broken.close();
  }
});

// ---- SHOULD-FIX 6: a broken stream never mixes two replies -------------------------------------

test('a local stream that breaks after text reached the person ends honestly, without a second reply from the cloud', async () => {
  const srv = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/version') return json({ version: '0.0.1' });
    if (req.url === '/api/tags') return json({ models: [{ name: 'example-mid:8b', size: 5e9, digest: 'a'.repeat(64), details: { parameter_size: '8B' }, capabilities: ['completion'] }] });
    if (req.url === '/api/chat') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write(`${JSON.stringify({ message: { content: 'LOCAL-PARTIAL ' }, done: false })}\n`); setTimeout(() => res.destroy(), 50); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const cloud = await startFakeOpenAI({ model: 'cloud-model', reply: () => 'CLOUD-FULL' });
  const { core } = modelsCore(`http://127.0.0.1:${(srv.address() as { port: number }).port}`, { privacy: 'local-preferred' });
  try {
    await core.models.assign('reasoner', { model: 'example-mid:8b' });
    core.models.setCloud({ name: 'Example cloud', base_url: cloud.url, model: 'cloud-model' }, true);
    let streamed = '';
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('hi'), onText: (t) => { streamed += t; } }), /broke off partway/);
    assert.equal(streamed, 'LOCAL-PARTIAL ');
    assert.equal(cloud.requests.length, 0, 'no second reply after the first had started');
    // Nothing reached the person yet: the cloud may still answer in its place.
    const r = await core.models.infer({ role: 'reasoner', messages: say('hi') });
    assert.equal(r.served_by, 'cloud');
  } finally {
    await core.close();
    srv.close();
    await cloud.close();
  }
});

// ---- SHOULD-FIX 7: a spoke's address, on every call --------------------------------------------

test('a spoke whose heartbeat moved to another address gets nothing at the old one; reported addresses must be private', { timeout: 30_000 }, async () => {
  const hubOllama = await startFakeOllama({ models: INSTALLED });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  const { core } = modelsCore(hubOllama.url, { privacy: 'local-only' });
  try {
    const d = pairSpoke(core);
    await core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url });
    assert.equal((await core.models.infer({ role: 'reasoner', messages: say('before') })).device, d.id);
    const before = chats(spoke);
    core.mesh.spokes.heartbeat(d, { hardware: hubHardware({ hostname: 'example-desktop', network: [{ name: 'eth0', mac: '02:00:00:00:00:42', address: '10.9.9.9', netmask: '255.0.0.0' }] }) });
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('local-only secret') }), /Waiting on local capacity: .*127\.0\.0\.1 isn’t one of Example desktop’s addresses now/);
    assert.equal(chats(spoke), before, 'nothing went to the old address');
  } finally {
    await core.close();
    await hubOllama.close();
    await spoke.close();
  }

  // What a heartbeat may claim: private addresses and a plain host name only.
  const hw = checkHardware(hubHardware({ hostname: 'api.example.com', network: [{ name: 'eth0', mac: '02:00:00:00:00:43', address: '8.8.8.8', netmask: '255.255.255.0' }, { name: 'eth1', mac: '02:00:00:00:00:44', address: '192.168.1.20', netmask: '255.255.255.0' }] }));
  assert.equal(hw.hostname, '');
  assert.deepEqual(hw.network.map((n) => n.address), ['192.168.1.20']);
  assert.equal(checkHardware(hubHardware({ hostname: 'Example-Mac.local' })).hostname, 'example-mac');
  // Wake packets go only to a private or broadcast address.
  const { core: c2 } = modelsCore('http://127.0.0.1:9');
  try {
    assert.throws(() => c2.models.setWake({ target: '8.8.8.8:9' }), /private/);
    assert.throws(() => c2.models.setWake({ target: 'wake.example.com:9' }), /private/);
    assert.deepEqual(c2.models.setWake({ target: '192.168.1.255:9' }), { target: '192.168.1.255:9' });
  } finally {
    await c2.close();
  }
});

// ---- the review's minor findings -----------------------------------------------------------------

test('budgets: a coding agent’s wait is the budget’s alone; the cloud model’s price isn’t its problem; tokens without a cost are priced or said', { timeout: 30_000 }, async () => {
  const o = await startFakeOllama({ models: INSTALLED });
  const cloud = await startFakeOpenAI({ model: 'cloud-model' });
  const { core } = modelsCore(o.url, { privacy: 'cloud-allowed' });
  try {
    await core.models.accept();
    writeCalc(core.workspace.root);
    core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${script('honest')}` });
    core.providers.enable('claude-code', { approved: true });
    // An unpriced cloud model with a budget: that stops the cloud model, not a coding agent.
    core.models.setCloud({ name: 'Example cloud', base_url: cloud.url, model: 'cloud-model' }, true);
    core.models.setBudget({ per_period_usd: 5, period: 'month' });
    assert.equal(core.models.budgetBlock(null), null);
    assert.match(String(core.models.budgetBlock(null, undefined, { cloud: true })), /can’t tell what Example cloud costs/);

    // Over budget: the agent's task waits, and the local reasoner being up doesn't release it.
    core.models.setBudget({ per_period_usd: 0, period: 'month' });
    const task = core.ledger.create({ ...calcTask('claude-code'), origin: { kind: 'user' } } as never);
    const waiting = await settled(core, task.id, (t) => t.state === 'waiting');
    assert.match(String(waiting.reason), /Waiting on the cloud budget/);
    const attempts = waiting.attempts;
    assert.deepEqual(await core.models.check(), []);
    await sleep(300);
    assert.equal(core.ledger.get(task.id).attempts, attempts, 'not run again while the budget is still used');

    // Usage that came back as tokens and no cost: with a budget, Nova says it can't count it, and
    // counts it once it has a price.
    core.models.setBudget({ per_period_usd: 1, period: 'month' });
    core.db.run('INSERT INTO cloud_usage (at, task_id, session_id, provider, model, tokens_in, tokens_out, cost_usd, ref) VALUES (?, NULL, NULL, ?, ?, ?, ?, NULL, ?)', new Date().toISOString(), 'remote:example-agent', 'example-agent-model', 100_000, 50_000, 'test:unpriced');
    assert.match(String(core.models.budgetBlock(null)), /can’t tell what example-agent-model cost/);
    core.models.setPrices({ 'example-agent-model': { usd_per_mtok_in: 2, usd_per_mtok_out: 10 } });
    assert.ok(Math.abs(core.models.spent() - 0.7) < 1e-9, String(core.models.spent()));
    assert.equal(core.models.budgetBlock(null), null);
  } finally {
    await core.close();
    await o.close();
    await cloud.close();
  }
});

test('a computer’s answers have receipts that name it; a role on a sleeping computer that won’t wake says it waits for that computer', { timeout: 30_000 }, async () => {
  const hubOllama = await startFakeOllama({ models: INSTALLED });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  const wol = await startFakeWol({});
  const { core } = modelsCore(hubOllama.url, { privacy: 'local-only' });
  try {
    const d = pairSpoke(core);
    core.models.setWake({ target: wol.target, wait_s: 1 });
    await core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url });
    const r = await core.models.infer({ role: 'reasoner', messages: say('hello') });
    assert.equal(core.receipts.list().find((x) => x.id === r.receipt_id)!.provider, 'ollama@example-desktop');
    spoke.setAsleep(true);
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('x'.repeat(3000)) }), /runs when Example desktop is on again/);
    assert.equal(wol.packets.length, 1);
  } finally {
    await core.close();
    await hubOllama.close();
    await spoke.close();
    await wol.close();
  }
});

test('Ollama failing on its side (out of memory) makes local-only work wait on local capacity, not fail', async () => {
  const srv = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const json = (status: number, o: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/version') return json(200, { version: '0.0.1' });
    if (req.url === '/api/tags') return json(200, { models: [{ name: 'example-mid:8b', size: 5e9, digest: 'a'.repeat(64), details: { parameter_size: '8B' }, capabilities: ['completion'] }] });
    if (req.url === '/api/chat') return json(500, { error: 'model requires more system memory (12 GiB) than is available (4 GiB)' });
    json(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const { core } = modelsCore(`http://127.0.0.1:${(srv.address() as { port: number }).port}`, { privacy: 'local-only' });
  try {
    await core.models.assign('reasoner', { model: 'example-mid:8b' });
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('hi') }), (e: Error) => e instanceof ModelsWaiting && /Waiting on local capacity: .*more system memory/.test(e.message));
  } finally {
    await core.close();
    srv.close();
  }
});

test('a provider set to a role says honestly, per privacy mode, where its calls may go', async () => {
  const o = await startFakeOllama({ models: INSTALLED });
  const cloud = await startFakeOpenAI({ model: 'cloud-model' });
  const { core } = modelsCore(o.url, { privacy: 'local-preferred' });
  try {
    core.providers.configure('openai-compatible', { role: 'reasoner' });
    core.models.setCloud({ name: 'Example cloud', base_url: cloud.url, model: 'cloud-model' }, true);
    assert.match(core.providers.view('openai-compatible').egress.words, /when it can’t answer, Example cloud may, off your devices/);
    core.profile.set('privacy', 'default', 'local-only', 'settings');
    assert.match(core.providers.view('openai-compatible').egress.words, /^Runs on your own devices/);
  } finally {
    await core.close();
    await o.close();
    await cloud.close();
  }
});
