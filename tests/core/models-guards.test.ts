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
import { INSTALLED, hubHardware, modelsCore, say } from '../support/models.ts';

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
  const d = core.mesh.devices.add({ name: 'Example desktop', platform: 'linux x64', kind: 'computer', public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
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
