// The per-device Models screen's server side (model-fit step 3): what a device can plan with, per
// task class and privacy first (recommend.ts planCandidates, ranked by fit.ts recommendFit), and
// Install and assign (POST /api/v1/models/install): checked at the API's edge, an installed model
// assigned at once as PUT /models/roles does, every download the same tier-2 task POST /models/pull
// makes, waiting for the person's OK, and its role given only once Nova has verified it.
// Stand-ins on loopback only; no model runs and nothing reaches a real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { planCandidates, quantTag, type DeviceModels } from '../../src/core/models/recommend.ts';
import { GiB, PRIOR_OVERHEAD_BYTES, deviceBudget, recommendFit, type FitDevice } from '../../src/core/models/fit.ts';
import type { Hardware } from '../../src/core/models/hardware.ts';
import { generateDeviceKeys, type Core } from '../../src/core/index.ts';
import { INSTALLED, hubHardware, modelsCore } from '../support/models.ts';

const gpuDevice = (gb: number): FitDevice => ({ memory: 'gpu', budget_bytes: gb * GiB, other_use_bytes: 0, other_use_known: true, overhead_bytes: PRIOR_OVERHEAD_BYTES, overhead_source: 'prior' });
const empty = (o: Partial<DeviceModels> = {}): DeviceModels => ({ id: 'hub', name: 'Example hub', hub: true, hardware: hubHardware() as unknown as Hardware, models: [], url: null, ...o });

// ---- the candidates, per task class --------------------------------------------------------------

test('a 24 GB card with nothing installed plans from the catalog: coding at 16k picks 14B at Q8_0 (ADR case 1), vision has a pick, labelled an estimate', () => {
  const candidates = planCandidates(empty(), { privacy: 'local-only', cloud: null });
  const advise = (task: 'general-chat' | 'coding' | 'vision' | 'embeddings') => recommendFit({ device: gpuDevice(24), privacy: 'local-only', task, hub: true, candidates });
  const chat = advise('general-chat');
  assert.deepEqual([chat.pick?.name, chat.pick?.quant, chat.pick?.verdict], ['qwen3:32b', 'Q4_K_M', 'tight']);
  const coding = advise('coding');
  assert.deepEqual([coding.pick?.name, coding.pick?.quant, coding.pick?.context, coding.pick?.verdict], ['qwen3:14b', 'Q8_0', 16384, 'fits']);
  assert.deepEqual([coding.alternative?.name, coding.alternative?.quant], ['qwen3:8b', 'Q8_0']);
  const vision = advise('vision');
  assert.equal(vision.pick?.name, 'qwen2.5vl:7b');
  assert.equal(vision.pick?.basis, 'tier-table', 'without the projector’s size the vision verdict is an estimate');
  assert.equal(advise('embeddings').pick?.name, 'nomic-embed-text');
});

test('an 8 GB card: 8B won’t fit at 16k (ADR case 2), so coding at 16k picks the catalog’s 4B; with only 8B to plan, nothing fits and it says 6k', () => {
  const candidates = planCandidates(empty(), { privacy: 'local-only', cloud: null });
  const coding = recommendFit({ device: gpuDevice(8), privacy: 'local-only', task: 'coding', hub: true, candidates });
  assert.deepEqual([coding.pick?.name, coding.pick?.quant, coding.pick?.context, coding.pick?.verdict], ['qwen3:4b', 'Q4_K_M', 16384, 'fits']);
  const only8b = recommendFit({ device: gpuDevice(8), privacy: 'local-only', task: 'coding', hub: true, candidates: candidates.filter((c) => c.name === 'qwen3:8b') });
  assert.equal(only8b.pick, null);
  assert.deepEqual(only8b.nothing_fits, { name: 'qwen3:8b', quant: 'Q4_K_M', max_context: 6144 });
});

test('privacy first: under local-only nothing that runs off the devices is listed at all; otherwise the cloud model comes after local', () => {
  const remote = { name: 'example-cloud:latest', size: 1000, digest: 'c'.repeat(64), modified_at: '', family: '', parameter_size: '', params_b: null, quantization: '', capabilities: ['completion'], remote: true };
  const d = empty({ models: [remote] });
  const local = planCandidates(d, { privacy: 'local-only', cloud: 'Example cloud' });
  assert.deepEqual(local.filter((c) => c.where !== 'local'), [], 'no cloud model, no remote Ollama model');
  const pref = planCandidates(d, { privacy: 'local-preferred', cloud: 'Example cloud' });
  assert.deepEqual(pref.filter((c) => c.where !== 'local').map((c) => [c.name, c.where]), [['example-cloud:latest', 'remote'], ['Example cloud', 'cloud']]);
  const chat = recommendFit({ device: gpuDevice(24), privacy: 'local-preferred', task: 'general-chat', hub: true, candidates: pref });
  assert.equal(chat.cloud_order, 'after-local');
  assert.ok(chat.pick, 'a local pick comes first');
});

test('an installed model plans with its own file and quant; the catalog doesn’t list it twice', () => {
  const m = { name: 'qwen3:8b', size: 5_200_000_000, digest: 'a'.repeat(64), modified_at: '', family: 'qwen3', parameter_size: '8.2B', params_b: 8.2, quantization: 'Q4_K_M', capabilities: ['completion'], remote: false };
  const c = planCandidates(empty({ models: [m] }), { privacy: 'local-only', cloud: null });
  assert.equal(c.filter((x) => x.name === 'qwen3:8b').length, 1);
  assert.deepEqual(c.find((x) => x.name === 'qwen3:8b')!.installed, { quant: 'Q4_K_M', weights_bytes: 5_200_000_000 });
});

test('a quant other than the default downloads by Ollama’s tag for it', () => {
  assert.equal(quantTag('qwen3:8b', 'Q4_K_M', 'Q4_K_M'), 'qwen3:8b');
  assert.equal(quantTag('qwen3:8b', 'Q8_0', 'Q4_K_M'), 'qwen3:8b-q8_0');
  assert.equal(quantTag('qwen3:14b', 'F16', 'Q4_K_M'), 'qwen3:14b-fp16');
  assert.equal(quantTag('nomic-embed-text', 'F16', 'F16'), 'nomic-embed-text');
});

// ---- the API -------------------------------------------------------------------------------------

async function served(core: Core) {
  const server: Server = createServer(async (req, res) => { await core.handle(req, res, new URL(req.url!, 'http://127.0.0.1'), { kind: 'console' }, 'console'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

test('GET /models: each compute device carries what the screen plans with; local-only lists no cloud model', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  const api = await served(core);
  try {
    const v = (await api.call('GET', '/models')).body;
    const hub = v.devices[0];
    assert.equal(hub.compute, true);
    assert.ok(hub.plan.candidates.some((c: { name: string }) => c.name === 'qwen3:32b'), 'the catalog');
    assert.ok(hub.plan.candidates.some((c: { name: string; installed: unknown }) => c.name === 'example-mid:8b' && c.installed), 'the installed models');
    assert.deepEqual(hub.plan.candidates.filter((c: { where: string }) => c.where !== 'local'), []);
    assert.equal(hub.plan.overhead.n, 0);
    assert.deepEqual(hub.plan.loaded, []);
    assert.equal(hub.plan.models_live, true);
  } finally { await api.close(); await core.close(); await ollama.close(); }
});

test('POST /models/install is checked at the edge: the plan’s shape, models Nova lists, quants, contexts, one model per role, and the fit', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  const api = await served(core);
  try {
    const tasks = () => core.ledger.list({ limit: 50 }).length;
    const before = tasks();
    const refused = async (body: unknown, status: number, why: RegExp) => {
      const r = await api.call('POST', '/models/install', body);
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.match(r.body.error, why);
    };
    await refused({}, 400, /plan is what to put on the device/);
    await refused({ plan: [] }, 400, /1 to 4/);
    await refused({ plan: [{ model: 'example-unknown:1b', quant: 'Q4_K_M', context: 4096 }] }, 400, /isn’t a model Nova lists/);
    await refused({ plan: [{ model: 'qwen3:8b', quant: 'Q3_K', context: 4096 }] }, 400, /quant is one of/);
    await refused({ plan: [{ model: 'qwen3:8b', quant: 'Q4_K_M', context: 10 }] }, 400, /context is how many tokens/);
    await refused({ plan: [{ model: 'qwen3:8b', quant: 'Q4_K_M', context: 4096, role: 'reasoner' }, { model: 'qwen3:4b', quant: 'Q4_K_M', context: 4096, role: 'reasoner' }] }, 400, /one model of the plan/);
    await refused({ plan: [{ model: 'nomic-embed-text', quant: 'F16', role: 'reasoner' }] }, 400, /can’t serve thinking and writing/);
    await refused({ plan: [{ model: 'qwen3:32b', quant: 'Q8_0', context: 4096 }] }, 409, /doesn’t fit on .*Nothing was installed or assigned/);
    await refused({ device: 'not-a-device', plan: [{ model: 'qwen3:8b', quant: 'Q4_K_M', context: 4096 }] }, 400, /device is the hub, or one of your paired computers/);
    assert.equal(tasks(), before, 'nothing refused made a task');
    assert.equal(core.models.placement('reasoner'), null, 'nothing refused assigned a role');
  } finally { await api.close(); await core.close(); await ollama.close(); }
});

test('POST /models/install: an installed model is assigned now; a download is a tier-2 task that waits for the OK, then its role is given once Nova has verified it', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED, library: { 'nomic-embed-text': { size: 0.27e9, layers: 2, parameter_size: '137M', capabilities: ['embedding'] } } });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  const api = await served(core);
  try {
    const r = await api.call('POST', '/models/install', { plan: [
      { model: 'example-mid:8b', quant: 'Q4_K_M', context: 8192, role: 'reasoner' },
      { model: 'nomic-embed-text', quant: 'F16', role: 'embedder' },
    ] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.assigned, [{ role: 'reasoner', model: 'example-mid:8b' }]);
    assert.equal(core.models.placement('reasoner')?.model, 'example-mid:8b');
    assert.equal(core.models.placement('reasoner')?.context, 8192, 'the context planned is the one the role runs with');
    assert.equal(r.body.tasks.length, 1);
    const id = r.body.tasks[0].id;
    const t = core.ledger.get(id);
    assert.equal(t.approval_tier, 2, 'the same tier as every model download');
    assert.equal(t.state, 'waiting', 'it waits for the OK');
    assert.ok(!ollama.installed().includes('nomic-embed-text'), 'nothing downloads before the OK');
    assert.equal(core.models.placement('embedder'), null, 'no role before the download is verified');

    const ok = await api.call('POST', `/tasks/${id}/approve`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const done = await until(async () => { await core.ledger.idle(); return core.ledger.get(id); }, (x) => ['done', 'failed'].includes(x.state));
    assert.equal(done.state, 'done', done.reason ?? '');
    const placed = await until(() => core.models.placement('embedder'), (p) => !!p);
    assert.equal(placed?.model, 'nomic-embed-text');
  } finally { await api.close(); await core.close(); await ollama.close(); }
});

test('POST /models/install: a quant other than the default asks for its own tag; a download with no role is assigned nothing', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  const api = await served(core);
  try {
    const r = await api.call('POST', '/models/install', { plan: [{ model: 'qwen3:8b', quant: 'Q8_0', context: 4096 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const t = core.ledger.get(r.body.tasks[0].id);
    assert.equal((t.brief.inputs as { model: string }).model, 'qwen3:8b-q8_0');
    assert.equal((t.brief.inputs as { assign?: unknown }).assign, undefined);
    assert.match(r.body.words, /nothing is assigned until you choose/);
  } finally { await api.close(); await core.close(); await ollama.close(); }
});

test('POST /models/install: a paired computer without the compute role gets no model work', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  const api = await served(core);
  try {
    const keys = generateDeviceKeys();
    const d = core.mesh.devices.add({ name: 'Example desktop', platform: 'linux x64', kind: 'computer', purposes: ['storage'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
    core.mesh.spokes.heartbeat(d, { hardware: hubHardware({ hostname: 'example-desktop' }) });
    const r = await api.call('POST', '/models/install', { device: d.id, plan: [{ model: 'qwen3:8b', quant: 'Q4_K_M', context: 4096 }] });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /isn’t a compute device/);
    const view = (await api.call('GET', '/models')).body;
    assert.equal(view.devices.find((x: { id: string }) => x.id === d.id).plan, null, 'the screen plans nothing for it');
  } finally { await api.close(); await core.close(); await ollama.close(); }
});

// deviceBudget is what the screen's bar is drawn against: loaded models aren't "other use".
test('the screen’s budget: memory the runtime reports for loaded models isn’t counted as other programs’ use', () => {
  const hw = hubHardware({ gpus: [{ vendor: 'nvidia', name: 'Example GPU 24GB', vram_bytes: 24 * GiB, vram_free_bytes: 14 * GiB, unified: false }] }) as unknown as Hardware;
  assert.equal(deviceBudget(hw, { loaded_vram_bytes: 9 * GiB }).other_use_bytes, 1 * GiB);
});
