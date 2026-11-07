// A Tight fit is never picked for the person (the owner, 2026-11-06; ADR open question 2): it may be
// installed or assigned only with their acknowledgement for that plan (accept_tight: true). Won't fit
// is always refused, and a refusal changes nothing. Checked at the API's edge: POST /models/install
// (each model and the plan as a whole) and PUT /models/roles/{role} (the model, and a computer's hub
// model). The 24 GB hub of tests/support/models.ts; stand-ins on loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { generateDeviceKeys, type Core } from '../../src/core/index.ts';
import { INSTALLED, hubHardware, modelsCore } from '../support/models.ts';

// 19.9e9 bytes of a 32B model, at 4k: Tight on the 24 GB hub. 40e9: Won't fit.
const TIGHT = { name: 'example-tight:32b', size: 19.9e9, parameter_size: '32.8B', family: 'example', capabilities: ['completion'] };
const HUGE = { name: 'example-huge:70b', size: 40e9, parameter_size: '70B', family: 'example', capabilities: ['completion'] };
const LIBRARY = { 'qwen3:32b': { size: 20.2e9, parameter_size: '32.8B', capabilities: ['completion'] } };

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

async function hub(run: (o: { core: Core; call: Awaited<ReturnType<typeof served>>['call']; tasks: () => number }) => Promise<void>) {
  const ollama = await startFakeOllama({ models: [...INSTALLED, TIGHT, HUGE], library: LIBRARY });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  const api = await served(core);
  try { await run({ core, call: api.call, tasks: () => core.ledger.list({ limit: 50 }).length }); } finally { await api.close(); await core.close(); await ollama.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

const TIGHT_PLAN = [{ model: TIGHT.name, quant: 'Q4_K_M', context: 4096, role: 'reasoner' }];

test('POST /models/install: a tight model is refused without the acknowledgement, changing nothing; with it, it is assigned', async () => {
  await hub(async ({ core, call, tasks }) => {
    const before = tasks();
    const r = await call('POST', '/models/install', { plan: TIGHT_PLAN });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /^That plan is tight on .*: Estimate: .*Fits, but tight, at Q4_K_M with 4k context.* It leaves little memory headroom, so replies may slow down sharply or fail under load\..*accept_tight: true.*Nothing was installed or assigned\.$/);
    for (const flag of [false, 'true', 1]) assert.equal((await call('POST', '/models/install', { plan: TIGHT_PLAN, accept_tight: flag })).status, 409, `accept_tight ${JSON.stringify(flag)} is not the acknowledgement`);
    assert.equal(core.models.placement('reasoner'), null, 'nothing assigned');
    assert.equal(tasks(), before, 'no task made');
    const ok = await call('POST', '/models/install', { plan: TIGHT_PLAN, accept_tight: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.assigned, [{ role: 'reasoner', model: TIGHT.name }]);
    assert.equal(core.models.placement('reasoner')?.model, TIGHT.name);
  });
});

test('POST /models/install: two models that each Fit but are tight together need the acknowledgement', async () => {
  await hub(async ({ core, call }) => {
    // example-deep:32b Fits alone (19.7e9 bytes), and so does the embedder; together they are Tight.
    const plan = [{ model: 'example-deep:32b', quant: 'Q4_K_M', context: 4096, role: 'reasoner' }, { model: 'example-embed', quant: 'Q4_K_M', role: 'embedder' }];
    assert.equal((await call('POST', '/models/install', { plan: plan.slice(0, 1) })).status, 201, 'the deep model alone Fits');
    core.models.unassign('reasoner');
    const r = await call('POST', '/models/install', { plan });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /^That plan is tight on .*Fits together, but tight: .*Nothing was installed or assigned\.$/);
    assert.equal(core.models.placement('reasoner'), null);
    assert.equal(core.models.placement('embedder'), null);
    const ok = await call('POST', '/models/install', { plan, accept_tight: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(core.models.placement('reasoner')?.model, 'example-deep:32b');
    assert.equal(core.models.placement('embedder')?.model, 'example-embed');
  });
});

test('POST /models/install: Won’t fit is refused even with the acknowledgement', async () => {
  await hub(async ({ core, call, tasks }) => {
    const before = tasks();
    for (const plan of [[{ model: 'qwen3:32b', quant: 'Q8_0', context: 4096, role: 'reasoner' }], [{ model: HUGE.name, quant: 'Q4_K_M', context: 4096, role: 'reasoner' }]]) {
      const r = await call('POST', '/models/install', { plan, accept_tight: true });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /doesn’t fit on .*Nothing was installed or assigned\./);
    }
    assert.equal(core.models.placement('reasoner'), null);
    assert.equal(tasks(), before);
  });
});

test('POST /models/install: a tight download carries the acknowledgement to the role it is given once verified', async () => {
  await hub(async ({ core, call }) => {
    const plan = [{ model: 'qwen3:32b', quant: 'Q4_K_M', context: 4096, role: 'reasoner' }];
    assert.equal((await call('POST', '/models/install', { plan })).status, 409, 'qwen3:32b at Q4_K_M is tight on the 24 GB hub');
    const r = await call('POST', '/models/install', { plan, accept_tight: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.tasks[0].id;
    assert.deepEqual((core.ledger.get(id).brief.inputs as { assign: unknown }).assign, { role: 'reasoner', context: 4096, accept_tight: true });
    assert.equal((await call('POST', `/tasks/${id}/approve`, {})).status, 200);
    const done = await until(async () => { await core.ledger.idle(); return core.ledger.get(id); }, (x) => ['done', 'failed'].includes(x.state));
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.equal((await until(() => core.models.placement('reasoner'), (p) => !!p))?.model, 'qwen3:32b');
    // Without that acknowledgement the same assignment is refused: it was the acknowledgement that let it through.
    core.models.unassign('reasoner');
    await assert.rejects(core.models.assign('reasoner', { model: 'qwen3:32b', context: 4096 }), /qwen3:32b is tight on .*Nothing was assigned\./);
  });
});

test('PUT /models/roles/{role}: tight is refused without accept_tight and assigned with it; Won’t fit is always refused', async () => {
  await hub(async ({ core, call }) => {
    const r = await call('PUT', '/models/roles/reasoner', { model: TIGHT.name });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /^example-tight:32b is tight on .*It leaves little memory headroom.*Nothing was assigned\.$/);
    assert.equal(core.models.placement('reasoner'), null, 'nothing assigned');
    const huge = await call('PUT', '/models/roles/reasoner', { model: HUGE.name, accept_tight: true });
    assert.equal(huge.status, 409, JSON.stringify(huge.body));
    assert.match(huge.body.error, /^example-huge:70b doesn’t fit on .*Nothing was assigned\.$/);
    assert.equal(core.models.placement('reasoner'), null);
    const ok = await call('PUT', '/models/roles/reasoner', { model: TIGHT.name, accept_tight: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(core.models.placement('reasoner')?.model, TIGHT.name);
    // A model that Fits needs nothing.
    assert.equal((await call('PUT', '/models/roles/triage-text', { model: 'example-small:3b' })).status, 200);
  });
});

test('POST /models/roles/accept never assigns a tight model: the defaults only pick Fits', async () => {
  const ollama = await startFakeOllama({ models: [TIGHT, INSTALLED[0]!, INSTALLED[4]!] });
  const { core } = modelsCore(ollama.url, { privacy: 'local-only' });
  try {
    const advice = await core.models.recommendation();
    assert.equal(advice.find((a) => a.role === 'reasoner')!.pick?.model, 'example-small:3b', 'the tight 32B is not the reasoner’s default');
    const r = await core.models.accept();
    assert.ok(r.assigned.includes('reasoner'));
    assert.equal(core.models.placement('reasoner')?.model, 'example-small:3b');
  } finally { await core.close(); await ollama.close(); }
});

test('PUT /models/roles/{role}: the hub model named for a computer’s role is fit-checked on the hub the same way', async () => {
  const hubOllama = await startFakeOllama({ models: [...INSTALLED, TIGHT, HUGE] });
  const spoke = await startFakeOllama({ models: [INSTALLED[1]!] });
  const { core } = modelsCore(hubOllama.url, { privacy: 'local-only' });
  const api = await served(core);
  try {
    const keys = generateDeviceKeys();
    const d = core.mesh.devices.add({ name: 'Example desktop', platform: 'linux x64', kind: 'computer', purposes: ['compute'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
    core.mesh.spokes.heartbeat(d, { hardware: hubHardware({ hostname: 'example-desktop', network: [{ name: 'eth0', mac: '02:00:00:00:00:42', address: '127.0.0.1', netmask: '255.0.0.0' }] }) });
    const body = { device: d.id, model: 'example-mid:8b', url: spoke.url };
    const tight = await api.call('PUT', '/models/roles/reasoner', { ...body, hub_model: TIGHT.name });
    assert.equal(tight.status, 409, JSON.stringify(tight.body));
    assert.match(tight.body.error, /^example-tight:32b is tight on .*Nothing was assigned\.$/);
    const huge = await api.call('PUT', '/models/roles/reasoner', { ...body, hub_model: HUGE.name, accept_tight: true });
    assert.equal(huge.status, 409, JSON.stringify(huge.body));
    assert.match(huge.body.error, /^example-huge:70b doesn’t fit on /);
    assert.equal(core.models.placement('reasoner'), null, 'nothing assigned');
    const ok = await api.call('PUT', '/models/roles/reasoner', { ...body, hub_model: TIGHT.name, accept_tight: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([core.models.placement('reasoner')?.model, core.models.placement('reasoner')?.hub_model], ['example-mid:8b', TIGHT.name]);
  } finally { await api.close(); await core.close(); await hubOllama.close(); await spoke.close(); }
});
