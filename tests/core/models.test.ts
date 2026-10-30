// The local model manager (M6 plan §2) against the stand-in Ollama, a stand-in "cloud"
// (OpenAI-compatible) and a Wake-on-LAN listener on loopback: hardware and recommendation, role
// assignment, each fallback chain from LOCAL-MODELS' worked examples (local-only never reaches
// the cloud stand-in: it gets zero requests), wake latency said honestly, downloads with progress,
// digest checks, the disk budget and removal, the local decision provider, and budgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, generateDeviceKeys, type Core } from '../../src/core/index.ts';
import { checkHardware, detectHardware, broadcastOf, modelMemory } from '../../src/core/models/hardware.ts';
import { recommend, type DeviceModels } from '../../src/core/models/recommend.ts';
import { magicPacket, parseTarget } from '../../src/core/models/wake.ts';
import { answerSchema, checkAnswer } from '../../src/core/models/decide.ts';
import { toInstalled } from '../../src/core/models/ollama.ts';
import { ModelsWaiting } from '../../src/core/models/index.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { magicMac, startFakeWol } from '../../scripts/stand-ins/fake-wol.js';
import { filesReply, startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { INSTALLED, LIBRARY, hubHardware, modelsCore, say } from '../support/models.ts';
import { FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GiB = 1024 ** 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}
const settled = (core: Core, id: string, also: (t: ReturnType<Core['ledger']['get']>) => boolean = () => false) =>
  until(async () => { await core.ledger.idle(); return core.ledger.get(id); }, (t) => ['done', 'failed', 'cancelled'].includes(t.state) || also(t));

const cloudStandIn = () => startFakeOpenAI({ model: 'cloud-model', reply: () => 'Answer from the cloud stand-in.' });
const setCloud = (core: Core, url: string, price = true) => core.models.setCloud({ name: 'Example cloud', base_url: url, model: 'cloud-model', ...(price ? { usd_per_mtok_in: 1000, usd_per_mtok_out: 1000 } : {}) }, true);

// ---- the pieces --------------------------------------------------------------------------------

test('hardware: nvidia-smi is read, missing tools are skipped, and a heartbeat’s hardware is checked', async () => {
  const run = async (program: string) => (program === 'nvidia-smi' ? 'Example GPU 24GB, 24576, 22000\n' : null);
  const hw = await detectHardware({ run });
  if (process.platform !== 'darwin') {
    assert.equal(hw.gpus.length, 1);
    assert.equal(hw.gpus[0]!.vram_bytes, 24576 * 1024 * 1024);
    assert.ok(hw.sources.includes('nvidia-smi'));
  }
  assert.ok(hw.ram_bytes > 0 && hw.cpu.threads > 0);
  const none = await detectHardware({ run: async () => null });
  assert.equal(none.gpus.length, 0, 'no GPU tool: no GPU, not an error');
  assert.equal(modelMemory({ ...none, ram_bytes: 16 * GiB }).on, 'cpu');

  assert.throws(() => checkHardware('lots'), /must be an object/);
  const c = checkHardware({ ...hubHardware(), network: [{ mac: 'not-a-mac', address: '192.0.2.4' }, { mac: '02:00:00:00:00:09', address: '192.0.2.9', netmask: '255.255.255.0' }], cpu: { model: 'x'.repeat(500), threads: 8 } });
  assert.deepEqual(c.network.map((n) => n.mac), ['02:00:00:00:00:09'], 'only a real MAC and address are kept');
  assert.equal(c.network[0]!.broadcast, '192.0.2.255');
  assert.equal(c.cpu.model.length, 120);
  assert.equal(broadcastOf('10.1.2.3', '255.255.0.0'), '10.1.255.255');
});

test('wake: a magic packet is six 0xFF and the MAC sixteen times; the stand-in reads it back', () => {
  const p = magicPacket('02:00:00:00:00:42');
  assert.equal(p.length, 102);
  assert.equal(magicMac(p), '02:00:00:00:00:42');
  assert.throws(() => magicPacket('nope'), /isn’t a MAC/);
  assert.deepEqual(parseTarget('192.0.2.255'), { host: '192.0.2.255', port: 9 });
});

test('recommendation: installed models first, fitted to memory, with the trade-off; transcription says it has no runtime', () => {
  const models = INSTALLED.map((m) => toInstalled({ name: m.name, size: m.size, digest: 'a'.repeat(64), details: { parameter_size: m.parameter_size, family: m.family }, capabilities: m.capabilities }));
  const hub = (hw: ReturnType<typeof hubHardware>): DeviceModels => ({ id: 'hub', name: 'Example hub', hub: true, hardware: hw as never, models, url: 'http://127.0.0.1:1' });
  const big = recommend([hub(hubHardware())]);
  const by = Object.fromEntries(big.map((a) => [a.role, a]));
  assert.equal(by['triage-text']!.pick?.model, 'example-small:3b');
  assert.equal(by.reasoner!.pick?.model, 'example-deep:32b', 'the deepest that fits 24 GB, not the coder');
  assert.match(by.reasoner!.pick!.why, /deepest model that fits Example GPU 24GB with 24 GB/);
  assert.match(by.reasoner!.pick!.tradeoff, /can’t both stay loaded|Slower/);
  assert.equal(by.embedder!.pick?.model, 'example-embed');
  assert.equal(by.transcriber!.pick, null);
  assert.match(by.transcriber!.words, /no transcription runtime on your devices.*stays off/);

  // An 8 GB GPU: the 32B model doesn't fit, the 8B one does.
  const small = recommend([hub(hubHardware({ gpus: [{ vendor: 'nvidia', name: 'Example GPU 8GB', vram_bytes: 8 * GiB, vram_free_bytes: null, unified: false }] }))]);
  assert.equal(small.find((a) => a.role === 'reasoner')!.pick?.model, 'example-mid:8b');
  // No GPU: it runs on the CPU, and says long answers are slow.
  const cpu = recommend([hub(hubHardware({ gpus: [], ram_bytes: 16 * GiB }))]);
  assert.match(cpu.find((a) => a.role === 'reasoner')!.pick!.tradeoff, /CPU here, so long answers are slow/);
  // Nothing installed: one download suggested, never assigned by itself.
  const empty = recommend([{ ...hub(hubHardware()), models: [] }]);
  assert.equal(empty.find((a) => a.role === 'embedder')!.pick?.installed, false);
  assert.match(empty.find((a) => a.role === 'embedder')!.pick!.tradeoff, /Nova asks before it starts/);
  // A whisper binary on the PATH: found, but said plainly that Nova can't use it yet.
  const whisper = recommend([hub(hubHardware({ whisper: '/usr/local/bin/whisper-cli' }))]);
  assert.match(whisper.find((a) => a.role === 'transcriber')!.words, /found a transcription runtime.*can’t use it yet/);
});

test('decision answers are checked strictly against the template', () => {
  const t = { template_id: 'example.check', version: 1, situation: 's', inputs: {}, questions: [{ id: 'kind', type: 'choice', options: ['a', 'b', 'unknown'] }, { id: 'yes', type: 'noul' }, { id: 'size', type: 'score', min: 0, max: 10 }], escalation: { confidence_floor: 0.5 } } as never;
  assert.equal((answerSchema(t) as any).properties.answers.properties.kind.enum.length, 3);
  assert.deepEqual(checkAnswer(t, JSON.stringify({ answers: { kind: 'a', yes: 0.9, size: 3 }, confidence: 0.8, why: 'ok' })), { ok: true, answers: { kind: 'a', yes: 0.9, size: 3 }, confidence: 0.8, why: 'ok' });
  const bad = checkAnswer(t, JSON.stringify({ answers: { kind: 'c', yes: 2, extra: 1 }, confidence: 'high' }));
  assert.equal(bad.ok, false);
  assert.deepEqual((bad as { problems: string[] }).problems, ['kind must be one of a, b, unknown', 'yes must be a probability from 0 to 1', 'size must be a number from 0 to 10', 'extra isn’t a question of example.check', 'confidence must be a number from 0 to 1']);
  assert.deepEqual(checkAnswer(t, 'Sure! {"answers"'), { ok: false, problems: ['the reply isn’t JSON'] });
});

// ---- roles and the inference API ---------------------------------------------------------------

test('roles: the recommendation is accepted from installed models; infer by role, local, with a receipt', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url);
  try {
    const before = await core.models.view();
    assert.equal(before.standout, 'accept', 'one standout: take the recommendation');
    assert.equal(before.devices[0]!.hub, true);
    assert.match(before.devices[0]!.words, /Example GPU 24GB \(24 GB\) · 32 GB memory · 20 threads · 400 GB free disk/);
    assert.match(before.devices[0]!.capacity, /Runs models up to about 21 GB/);
    assert.equal(before.roles.find((r) => r.role === 'transcriber')!.state, 'no-runtime');
    const r = await core.models.accept();
    assert.deepEqual(r.assigned, ['triage-text', 'reasoner', 'embedder']);
    assert.match(r.left[0]!.why, /no transcription runtime/);
    const after = await core.models.view();
    assert.equal(after.standout, null);
    assert.deepEqual(after.roles.map((x) => x.state), ['ready', 'ready', 'ready', 'no-runtime']);
    await assert.rejects(core.models.assign('transcriber', { model: 'example-small:3b' }), /no transcription runtime/);
    await assert.rejects(core.models.assign('reasoner', { model: 'not-installed' }), /doesn’t have not-installed/);

    const out = await core.models.infer({ role: 'reasoner', messages: say('Hello there'), purpose: 'test' });
    assert.equal(out.served_by, 'local');
    assert.equal(out.model, 'example-deep:32b');
    assert.match(out.text!, /Stand-in example-deep:32b heard: Hello there/);
    const receipt = core.receipts.get(out.receipt_id);
    assert.equal(receipt.egress, 'local');
    assert.equal(receipt.provider, 'ollama');
    assert.equal(receipt.model, 'example-deep:32b');
    const emb = await core.models.infer({ role: 'embedder', input: ['one', 'two'] });
    assert.equal(emb.embeddings!.length, 2);
    await assert.rejects(core.models.infer({ role: 'transcriber', input: 'x' }), /no transcription runtime/);
    // Versions are recorded from what Nova read: every installed model, by digest.
    assert.equal(core.models.versions().filter((v) => !v.removed_at).length, INSTALLED.length);
  } finally {
    await core.close();
    await ollama.close();
  }
});

// ---- the fallback chains (LOCAL-MODELS, worked examples) ------------------------------------

test('local reasoner down, task local-preferred: the cloud serves, the receipt says so, and a problem is opened', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const cloud = await cloudStandIn();
  const { core } = modelsCore(ollama.url, { privacy: 'local-preferred' });
  try {
    await core.models.accept();
    setCloud(core, cloud.url, false);
    await ollama.close();
    const out = await core.models.infer({ role: 'reasoner', messages: say('Summarize my day'), privacy_mode: 'local-preferred' });
    assert.equal(out.served_by, 'cloud');
    assert.equal(out.text, 'Answer from the cloud stand-in.');
    assert.equal(out.egress, 'remote:example-cloud');
    assert.match(out.notes.join(' '), /local thinking and writing model wasn’t answering .* so Example cloud answered instead: this went off your devices/);
    assert.equal(core.receipts.get(out.receipt_id).egress, 'remote:example-cloud', 'the receipt discloses it');
    assert.equal(cloud.requests.length, 1);
    const problems = core.log.problems({ open: true }).filter((p) => p.source === 'models');
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /isn’t answering .*local-only work waits/);
    // A second fallback doesn't open a second problem for the same fault.
    await core.models.infer({ role: 'reasoner', messages: say('Again'), privacy_mode: 'local-preferred' });
    assert.equal(core.log.problems({ open: true }).filter((p) => p.source === 'models').length, 1);
  } finally {
    await core.close();
    await cloud.close();
  }
});

test('cloud unreachable, task cloud-allowed: the local reasoner serves and says the answer may be less thorough', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const cloud = await cloudStandIn();
  const { core } = modelsCore(ollama.url, { privacy: 'cloud-allowed' });
  try {
    await core.models.accept();
    setCloud(core, cloud.url, false);
    const first = await core.models.infer({ role: 'reasoner', messages: say('Plan a trip'), privacy_mode: 'cloud-allowed' });
    assert.equal(first.served_by, 'cloud', 'cloud-allowed: the cloud first, while it answers');
    await cloud.close();
    const out = await core.models.infer({ role: 'reasoner', messages: say('Plan a trip'), privacy_mode: 'cloud-allowed' });
    assert.equal(out.served_by, 'local');
    assert.equal(out.egress, 'local');
    assert.match(out.notes.join(' '), /Example cloud couldn’t be reached, so the local model \(example-deep:32b\) answered; the answer may be less thorough/);
  } finally {
    await core.close();
    await ollama.close();
  }
});

test('local-only, local reasoner down: it waits on local capacity, the person is told, the cloud stand-in gets zero requests, and it runs when capacity returns', { timeout: 60_000 }, async () => {
  let ollama = await startFakeOllama({ models: INSTALLED, reply: () => filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }], 'sum subtracted; it adds now.') });
  const port = ollama.port;
  const cloud = await cloudStandIn();
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  try {
    await core.models.accept();
    // A cloud model is set, and still must never be used: the person's setting is local-only.
    setCloud(core, cloud.url);
    writeCalc(core.workspace.root);
    core.providers.configure('openai-compatible', { role: 'reasoner' });
    core.providers.enable('openai-compatible', { approved: true });
    assert.equal(core.providers.view('openai-compatible').egress.coarse, 'local');

    // The direct API: refused with the honest status, nothing sent anywhere.
    await ollama.close();
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('hi'), privacy_mode: 'cloud-allowed' }), (e: unknown) => e instanceof ModelsWaiting && /^Waiting on local capacity: .*stays on your devices/.test((e as Error).message));

    // A local-only task through the provider set to the reasoner role.
    const task = core.ledger.create({ ...calcTask('openai-compatible', { privacy_mode: 'local-only' }), origin: { kind: 'user' } } as never);
    const waiting = await settled(core, task.id, (t) => t.state === 'waiting');
    assert.equal(waiting.state, 'waiting');
    assert.match(String(waiting.reason), /Waiting on local capacity: .*This is local-only, so it stays on your devices and runs when the model is back/);
    // The person is told, the way proactive messages go.
    const told = await until(() => core.triggers.messages(), (m) => m.some((x) => /is waiting\. Waiting on local capacity/.test(x.text)));
    assert.ok(told.some((x) => /“Make the failing test in calc\/ pass” is waiting/.test(x.text)), JSON.stringify(told));
    await sleep(400);
    assert.equal(core.ledger.get(task.id).state, 'waiting', 'still waiting while the model is down');

    // Capacity returns (the stand-in comes back on the same address): the task runs by itself.
    ollama = await startFakeOllama({ models: INSTALLED, port, reply: () => filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }], 'sum subtracted; it adds now.') });
    const asked = await settled(core, task.id, (t) => t.state === 'waiting' && /OK/.test(t.reason ?? ''));
    assert.match(String(asked.reason), /Nova needs your OK to run/);
    assert.ok(core.ledger.events(task.id).some((e) => e.kind === 'retried' || /Local capacity is back/.test(JSON.stringify(e.detail))));
    core.providers.approveTest(task.id);
    const done = await settled(core, task.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.equal(readFileSync(join(core.workspace.root, 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    const receipts = core.receipts.list({ task_id: task.id });
    assert.ok(receipts.length >= 1 && receipts.every((r) => r.egress === 'local' && r.provider === 'ollama'), JSON.stringify(receipts));

    assert.equal(cloud.requests.length, 0, 'local-only never reached the cloud stand-in');
    assert.equal(core.receipts.list({ egress: 'remote' }).length, 0);
  } finally {
    await core.close();
    await ollama.close();
    await cloud.close();
  }
});

// ---- waking a GPU spoke ------------------------------------------------------------------------

test('GPU spoke: woken over (loopback) Wake-on-LAN, latency measured and said honestly; small jobs stay on the hub', { timeout: 60_000 }, async () => {
  const hubOllama = await startFakeOllama({ models: INSTALLED });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  let wakes = true;
  const wol = await startFakeWol({ onWake: () => { if (wakes) setTimeout(() => spoke.setAsleep(false), 300); } });
  const { core } = modelsCore(hubOllama.url);
  try {
    const keys = generateDeviceKeys();
    const d = core.mesh.devices.add({ name: 'Example desktop', platform: 'linux x64', kind: 'computer', public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
    core.mesh.spokes.heartbeat(d, { hardware: hubHardware({ hostname: 'example-desktop', network: [{ name: 'eth0', mac: '02:00:00:00:00:42', address: '127.0.0.1', netmask: '255.0.0.0' }] }) });
    core.models.setWake({ target: wol.target, wait_s: 1 });
    await assert.rejects(core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: 'http://198.51.100.7:11434' }), /isn’t one of Example desktop’s addresses/);
    await core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url, hub_model: 'example-small:3b' });
    const map = await core.models.view();
    assert.equal(map.devices.length, 2);
    assert.match(map.devices[1]!.wake!.words, /how long it takes isn’t measured yet/);
    spoke.setAsleep(true);
    const big = say('x'.repeat(3000));

    // Never woken before, and it doesn't come up: Nova waited its setting, and says that was a guess.
    wakes = false;
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: big }), /Example desktop didn’t answer after Nova woke it: it waited \d+ s\. It has never been woken before, so that wait was a guess/);
    assert.equal(wol.packets.at(-1)!.mac, '02:00:00:00:00:42');

    // It wakes: served there, and the wait is measured.
    wakes = true;
    const out = await core.models.infer({ role: 'reasoner', messages: big });
    assert.equal(out.device, d.id);
    assert.match(out.notes.join(' '), /Nova woke Example desktop; it answered after \d+ s/);
    const latency = core.models.wakeLatency(d.id)!;
    assert.ok(latency >= 250 && latency < 5000, String(latency));

    // Asleep again, a small job: the hub's small model answers, nothing is woken.
    spoke.setAsleep(true);
    const packets = wol.packets.length;
    const small = await core.models.infer({ role: 'reasoner', messages: say('Is it Tuesday?') });
    assert.equal(small.device, 'hub');
    assert.equal(small.model, 'example-small:3b');
    assert.match(small.notes.join(' '), /Example desktop is asleep and this was small, so example-small:3b on the hub answered rather than waking it \(waking takes about \d+ s\)/);
    assert.equal(wol.packets.length, packets, 'no wake for a small job');

    // It doesn't come up this time: Nova waits as long as last time and a half, plus 2 s, and says so.
    wakes = false;
    const started = Date.now();
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: big }), /didn’t answer after Nova woke it: it waited \d+ s, half again what waking took last time/);
    const waited = Date.now() - started;
    assert.ok(waited >= latency * 1.5 + 1500 && waited < latency * 1.5 + 6000, `${waited} ms against a measured ${latency} ms`);
    assert.match((await core.models.view()).devices[1]!.wake!.words, /Wakes in about \d+ s \(measured\)/);
  } finally {
    await core.close();
    await hubOllama.close();
    await spoke.close();
    await wol.close();
  }
});

// ---- downloads and removal --------------------------------------------------------------------

test('download: a tier-2 task with streamed progress, its digest read back by Nova, the version recorded; removal likewise', { timeout: 60_000 }, async () => {
  const ollama = await startFakeOllama({ models: INSTALLED, library: LIBRARY, pullDelayMs: 15 });
  const { core } = modelsCore(ollama.url);
  const progress: { status: string; completed: number; total: number; digest: string | null }[] = [];
  core.models.on('progress', (p) => progress.push(p));
  try {
    const task = await core.models.requestPull({ model: 'example-new:7b' });
    assert.equal(task.approval_tier, 2);
    const asked = await settled(core, task.id, (t) => t.state === 'waiting');
    assert.equal(asked.reason, 'Needs your OK before it runs.');
    core.ledger.approve(task.id);
    const done = await settled(core, task.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.ok(done.verification!.ok);
    assert.match(done.verification!.checks[0]!.why, /Nova read example-new:7b from the runtime itself .*digest sha256:/);
    assert.ok(progress.some((p) => p.total > 0 && p.completed > 0 && p.completed < p.total), 'progress in between');
    assert.ok(progress.some((p) => p.status === 'verified' && /^[0-9a-f]{64}$/.test(p.digest ?? '')));
    assert.ok(ollama.installed().includes('example-new:7b'));
    const v = core.models.versions().find((x) => x.name === 'example-new:7b')!;
    assert.equal(v.task_id, task.id);

    // A digest Nova was told to expect that doesn't match: installed, but the task fails, plainly.
    const pinned = await core.models.requestPull({ model: 'nomic-embed-text', digest: '0'.repeat(64) });
    core.ledger.approve(pinned.id);
    const wrong = await settled(core, pinned.id);
    assert.equal(wrong.state, 'failed');
    assert.match(String(wrong.reason), /arrived with digest sha256:[0-9a-f]{12}…, not the sha256:000000000000… Nova was told to expect/);

    // Removal: refused while the model serves a role, then a tier-2 task read back by Nova.
    await core.models.assign('reasoner', { model: 'example-new:7b' });
    await assert.rejects(core.models.requestRemove({ model: 'example-new:7b' }), /serves thinking and writing\. Assign another model first/);
    core.models.unassign('reasoner');
    const rm = await core.models.requestRemove({ model: 'example-new:7b' });
    core.ledger.approve(rm.id);
    const removed = await settled(core, rm.id);
    assert.equal(removed.state, 'done', removed.reason ?? '');
    assert.match(removed.verification!.checks[0]!.why, /isn’t there/);
    assert.ok(!ollama.installed().includes('example-new:7b'));
    assert.ok(core.models.versions().find((x) => x.name === 'example-new:7b')!.removed_at);
  } finally {
    await core.close();
    await ollama.close();
  }
});

test('disk budget: refused up front when the size is known, stopped mid-download when it isn’t; nothing kept', { timeout: 60_000 }, async () => {
  const ollama = await startFakeOllama({ models: INSTALLED, library: LIBRARY, pullDelayMs: 10 });
  const { core } = modelsCore(ollama.url);
  try {
    // The installed models take about 45.8e9 bytes; a 50 GB budget leaves about 7.9e9.
    core.models.setDiskBudget(50);
    await assert.rejects(core.models.requestPull({ model: 'qwen3:32b' }), /Refused: qwen3:32b takes about 19 GB, and with the 43 GB your models already use that is past the disk budget of 50 GB/);
    const huge = await core.models.requestPull({ model: 'example-huge:70b' });
    core.ledger.approve(huge.id);
    const t = await settled(core, huge.id);
    assert.equal(t.state, 'failed');
    assert.match(String(t.reason), /Refused: example-huge:70b is at least 19 GB, and with the 43 GB your models already use that is past the disk budget of 50 GB\. Nova stopped the download/);
    await sleep(200);
    assert.ok(!ollama.installed().includes('example-huge:70b'), 'the stopped download left nothing installed');
    // Within the budget it goes ahead.
    const ok = await core.models.requestPull({ model: 'example-new:7b' });
    core.ledger.approve(ok.id);
    assert.equal((await settled(core, ok.id)).state, 'done');
  } finally {
    await core.close();
    await ollama.close();
  }
});

// ---- the local Decision Model Provider (ADR-7) ---------------------------------------------------

test('local decision provider: typed answers from the sorting model, receipts name it; out of schema escalates; policy binds it; rules when it is down', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url);
  try {
    // Nothing assigned: the rules answer, as before.
    const inputs = { class: 'event', action: 'message', quiet_hours: false, category_off: false };
    assert.equal((await core.decisions.decide('triage', inputs))!.provider, 'rules');
    await core.models.assign('triage-text', { model: 'example-small:3b' });

    const d = (await core.decisions.decide('triage', inputs))!;
    assert.equal(d.provider, 'local-model');
    assert.equal(d.answers.decision, 'act');
    assert.equal(d.escalate, false);
    assert.match(d.why, /example-small:3b on the hub/);
    const r = core.receipts.list().find((x) => x.purpose === 'decision: triage@1')!;
    assert.equal(r.provider, 'ollama');
    assert.equal(r.model, 'example-small:3b');
    assert.equal(r.egress, 'local');
    assert.ok(ollama.requests.some((q: { path: string; body: unknown }) => q.path === '/api/chat' && (q.body as { format?: unknown }).format), 'asked for the schema');
    assert.ok(ollama.requests.every((q: { body: unknown }) => (q.body as { think?: unknown })?.think === undefined), 'a model that doesn’t think isn’t told not to');
    // A thinking model asked for a schema has its reasoning turned off, so its answer is the JSON.
    await core.models.assign('triage-text', { model: 'example-deep:32b' });
    assert.equal((await core.decisions.decide('triage', inputs))!.provider, 'local-model');
    assert.equal((ollama.requests.at(-1)!.body as { think?: boolean }).think, false);
    await core.models.assign('triage-text', { model: 'example-small:3b' });

    // Noul, Choice and Score together.
    core.templates.builtIn({ template_id: 'example.check', version: 1, situation: 'Is this worth a look?', inputs: { subject: 'string' }, questions: [{ id: 'kind', type: 'choice', options: ['note', 'task', 'unknown'] }, { id: 'urgent', type: 'noul' }, { id: 'effort', type: 'score', min: 0, max: 10 }], escalation: { confidence_floor: 0.5 } });
    const n = (await core.decisions.decide('example.check', { subject: 'An example' }))!;
    assert.deepEqual(n.answers, { kind: 'note', urgent: 0.9, effort: 9 });
    assert.equal(n.provider, 'local-model');
    assert.equal(n.escalate, false);

    // The person's policy binds the model: a category turned off is dropped, whatever it says.
    const off = (await core.decisions.decide('triage', { ...inputs, category_off: true }))!;
    assert.equal(off.escalate, true);
    assert.match(off.why, /answered against your settings: your settings say “drop” here/);

    // Out of schema: nothing of it is used, and it escalates.
    await fetch(`${ollama.url}/__stand-in/reply`, { method: 'POST', body: JSON.stringify({ text: 'I think you should act on it.' }) });
    const bad = (await core.decisions.decide('triage', inputs))!;
    assert.equal(bad.provider, 'local-model');
    assert.equal(bad.escalate, true);
    assert.equal(bad.answers.decision, 'unknown');
    assert.match(bad.why, /answered outside the template: the reply isn’t JSON/);
    await fetch(`${ollama.url}/__stand-in/reply`, { method: 'POST', body: JSON.stringify({ json: { answers: { decision: 'maybe' }, confidence: 0.99, why: 'x' } }) });
    const wrong = (await core.decisions.decide('triage', inputs))!;
    assert.equal(wrong.escalate, true);
    assert.match(wrong.why, /decision must be one of act, queue, silent, drop, unknown/);

    // Down: the rules answer, and the receipt trail shows no remote decision provider was asked.
    await ollama.close();
    assert.equal((await core.decisions.decide('triage', inputs))!.provider, 'rules');
    assert.equal(core.receipts.list({ egress: 'remote' }).length, 0);
  } finally {
    await core.close();
    await ollama.close();
  }
});

test('local-only runs only local decision providers: a remote one registered first is never asked', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url);
  let asked = 0;
  core.decisions.register({ id: 'remote-example', egress: 'remote', questionTypes: ['choice', 'score', 'noul'], decide: async () => { asked++; throw new Error('should not be asked'); } }, { first: true });
  try {
    await core.models.assign('triage-text', { model: 'example-small:3b' });
    const d = (await core.decisions.decide('triage', { class: 'event', action: 'message', quiet_hours: false, category_off: false }))!;
    assert.equal(d.provider, 'local-model');
    assert.equal(asked, 0);
  } finally {
    await core.close();
    await ollama.close();
  }
});

// ---- budgets -----------------------------------------------------------------------------------

test('cloud budgets: usage tracked per call; over the period budget local answers, and with local down the work waits with the reason', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const cloud = await cloudStandIn();
  const { core } = modelsCore(ollama.url, { privacy: 'cloud-allowed' });
  try {
    await core.models.accept();
    // Unpriced with a budget: Nova won't spend what it can't count.
    setCloud(core, cloud.url, false);
    core.models.setBudget({ per_period_usd: 1, period: 'month' });
    const unpriced = await core.models.infer({ role: 'reasoner', messages: say('hello'), privacy_mode: 'cloud-allowed' });
    assert.equal(unpriced.served_by, 'local');
    assert.match(unpriced.notes.join(' '), /can’t tell what Example cloud costs, so with a budget set it doesn’t use it/);
    assert.equal(cloud.requests.length, 0);

    // Priced (an absurd $1000 per million tokens, so a call costs cents): the first call fits.
    setCloud(core, cloud.url, true);
    core.models.setBudget({ per_period_usd: 0.01, period: 'month' });
    const first = await core.models.infer({ role: 'reasoner', messages: say('hello'), privacy_mode: 'cloud-allowed' });
    assert.equal(first.served_by, 'cloud');
    assert.ok(first.usage.cost_usd! > 0.01);
    assert.ok(core.models.spent() > 0.01);
    // Now over: local stays the answer, and says why.
    const second = await core.models.infer({ role: 'reasoner', messages: say('hello'), privacy_mode: 'cloud-allowed' });
    assert.equal(second.served_by, 'local');
    assert.match(second.notes.join(' '), /This month’s cloud budget is used: \$0\.\d\d of \$0\.01\. So the local model \(example-deep:32b\) answered/);
    // With local down too, the task waits with the reason.
    await ollama.close();
    const task = core.ledger.create({ title: 'Example', owner: 'workspace', goal: 'g', origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'notes/example.md' }], privacy_mode: 'cloud-allowed', approval_tier: 2 } as never);
    await core.ledger.idle();
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('hello'), privacy_mode: 'cloud-allowed', task_id: task.id }), /Waiting on local capacity: .*This month’s cloud budget is used/);
    assert.equal(cloud.requests.length, 1, 'only the call within budget reached the cloud');
    // Per task: a task's own limit.
    core.models.setBudget({ per_task_usd: 0, period: 'month' });
    assert.match(String(core.models.budgetBlock(task.id)), /This task has used its cloud budget: \$0\.00 of \$0\.00/);
    core.models.setBudget({ period: 'month' });
    assert.equal(core.models.budgetBlock(task.id), null);
  } finally {
    await core.close();
    await cloud.close();
  }
});

test('a fresh core without any of this set up stays quiet: no model, rules decide, nothing contacted', async () => {
  const home = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'nova-models-fresh-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, models: { ollamaUrl: 'http://127.0.0.1:9', hardware: async () => hubHardware() as never } });
  try {
    assert.equal(core.models.placement('reasoner'), null);
    assert.equal(core.models.decisionsByModel(), false);
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('hi') }), /Waiting on local capacity: no model is assigned to thinking and writing yet/);
  } finally {
    await core.close();
  }
});

test('capture proposals (M6a) get a local-model answer under local-only, even with decisions kept on the rules, and the receipt names it', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  const inputs = { kind: 'screen', app: 'Editor', space: '', text: 'The recycling is collected on Thursdays.' };
  try {
    // Nothing assigned: the rules have no rule for it, so it escalates and nothing would be proposed.
    const none = (await core.decisions.decide('capture-promote', inputs))!;
    assert.equal(none.provider, 'rules');
    assert.equal(none.escalate, true);

    await core.models.assign('triage-text', { model: 'example-small:3b' });
    // The person keeps decisions on the rules: triage stays with them, but a template they have no
    // rule for still goes to the local model.
    core.profile.set('models', 'decisions', 'rules', 'settings');
    assert.equal((await core.decisions.decide('triage', { class: 'event', action: 'message', quiet_hours: false, category_off: false }))!.provider, 'rules');
    const d = (await core.decisions.decide('capture-promote', inputs))!;
    assert.equal(d.provider, 'local-model');
    assert.equal(d.escalate, false);
    assert.equal(d.answers.remember, 0.9);
    const r = core.receipts.list().find((x) => x.purpose === 'decision: capture-promote@1')!;
    assert.deepEqual([r.provider, r.model, r.egress, r.privacy_mode], ['ollama', 'example-small:3b', 'local', 'local-only']);
  } finally {
    await core.close();
    await ollama.close();
  }
});
