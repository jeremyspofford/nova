// The fit engine wired into the model manager (docs/plans/model-fit-adr-2026-11-04.md, step 2b):
// chat calls send the context the verdict assumed (num_ctx); what Ollama reports about loaded models
// is kept, parsed as outside data; the learned overhead is recorded after real loads, in a table a
// standby gets; and the role recommendations use the engine instead of file size × 1.15.
// Stand-ins on loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { Ollama, toInstalled } from '../../src/core/models/ollama.ts';
import { capacityWords, recommend, type DeviceModels } from '../../src/core/models/recommend.ts';
import { GiB, PRIOR_OVERHEAD_BYTES } from '../../src/core/models/fit.ts';
import type { Hardware } from '../../src/core/models/hardware.ts';
import { INSTALLED, hubHardware, modelsCore, say } from '../support/models.ts';

const g2 = (b: number) => (b / GiB).toFixed(2);

// A stand-in Ollama whose /api/ps answer the test sets: one installed model, qwen3:14b at Q4_K_M
// (the ADR's case 5), with the shape /api/show reports in model_info.
async function shapedOllama() {
  const requests: { path: string; body: any }[] = [];
  const state: { ps: unknown } = { ps: { models: [] } };
  const srv: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url!, body });
    const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/version') return json({ version: '0.0.1' });
    if (req.url === '/api/tags') return json({ models: [{ name: 'qwen3:14b', size: 9_300_000_000, digest: 'b'.repeat(64), details: { parameter_size: '14.8B', quantization_level: 'Q4_K_M', family: 'qwen3' }, capabilities: ['completion'] }] });
    if (req.url === '/api/show') {
      return json({ details: { parameter_size: '14.8B' }, capabilities: ['completion'], model_info: {
        'general.architecture': 'qwen3', 'qwen3.block_count': 40, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128,
        'qwen3.attention.head_count': 40, 'qwen3.embedding_length': 5120, 'qwen3.context_length': 40960,
      } });
    }
    if (req.url === '/api/ps') return json(state.ps);
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: 'ok' }, done: false })}\n`);
      return res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, requests, state, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

// What /api/ps says for one loaded qwen3:14b.
const loadedAs = (o: { size: number; vram?: number; context?: number }) => ({ models: [{
  name: 'qwen3:14b', model: 'qwen3:14b', size: o.size, size_vram: o.vram ?? o.size, digest: 'b'.repeat(64),
  expires_at: '2026-11-04T10:05:00Z', ...(o.context ? { context_length: o.context } : {}),
}] });

// ---- 1. num_ctx --------------------------------------------------------------------------------

test('chat calls send the context the fit assumed as options.num_ctx: the role’s default, or the one set for it', async () => {
  const ollama = await startFakeOllama({ models: INSTALLED });
  const { core } = modelsCore(ollama.url);
  const chats = () => ollama.requests.filter((r: { path: string }) => r.path === '/api/chat') as { body: { options?: Record<string, unknown> } }[];
  try {
    await core.models.accept();
    await core.models.infer({ role: 'reasoner', messages: say('hi') });
    assert.equal(chats().at(-1)!.body.options?.num_ctx, 4096, 'general chat is planned, and run, at 4k');
    // A typed answer keeps temperature 0 and gets the context too.
    await core.models.infer({ role: 'triage-text', messages: say('sort this'), format: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });
    assert.deepEqual(chats().at(-1)!.body.options, { temperature: 0, num_ctx: 4096 });
    // A context set for the role is the one sent, and the one the recommendation's verdict names.
    await core.models.assign('reasoner', { model: 'example-mid:8b', context: 16384 });
    assert.equal(core.models.placement('reasoner')!.context, 16384);
    await core.models.infer({ role: 'reasoner', messages: say('hi') });
    assert.equal(chats().at(-1)!.body.options?.num_ctx, 16384);
    await assert.rejects(core.models.assign('reasoner', { model: 'example-mid:8b', context: 100 }), /context is/);
    await assert.rejects(core.models.assign('reasoner', { model: 'example-mid:8b', context: '4096' }), /context is/);
    await assert.rejects(core.models.assign('embedder', { model: 'example-embed', context: 4096 }), /context is/);
  } finally {
    await core.close();
    await ollama.close();
  }
});

// ---- 2. /api/ps, kept --------------------------------------------------------------------------

test('Ollama.loaded keeps size, size_vram, context_length and expires_at per loaded model, parsed as outside data; ps() still gives names', async () => {
  const s = await shapedOllama();
  try {
    s.state.ps = { models: [
      { name: 'qwen3:14b', size: 11_489_037_517, size_vram: 11_489_037_517, context_length: 4096, expires_at: '2026-11-04T10:05:00Z', digest: 'b'.repeat(64) },
      { model: 'partial:8b', size: 9e9, size_vram: 4e9, expires_at: 'soon' },
      { name: 'odd', size: -1, size_vram: 'lots', context_length: 1.5, expires_at: 7 },
      'not a model', { size: 5 }, null,
    ] };
    const rt = new Ollama(s.url);
    assert.deepEqual(await rt.loaded(), [
      { name: 'qwen3:14b', digest: 'b'.repeat(64), size_bytes: 11_489_037_517, vram_bytes: 11_489_037_517, context: 4096, expires_at: '2026-11-04T10:05:00.000Z' },
      { name: 'partial:8b', digest: '', size_bytes: 9e9, vram_bytes: 4e9, context: null, expires_at: null },
      { name: 'odd', digest: '', size_bytes: null, vram_bytes: null, context: null, expires_at: null },
    ]);
    s.state.ps = { models: 'none' };
    assert.deepEqual(await rt.loaded(), []);
    // The shape, from model_info.
    assert.deepEqual((await rt.show('qwen3:14b'))!.arch, { layers: 40, kv_heads: 8, head_dim: 128 });
    assert.equal((await rt.show('qwen3:14b'))!.max_context, 40960);
  } finally {
    await s.close();
  }
});

// ---- 3. the device overhead --------------------------------------------------------------------

test('after a real load fully on the GPU, the device’s overhead is learned (30% toward the reading, bounded), once per load, replicated; partial loads and wild readings are not', async () => {
  const s = await shapedOllama();
  const { core, home } = modelsCore(s.url);
  const row = () => core.db.get<{ device_id: string; backend: string; learned_bytes: number; samples: number; last_observed_bytes: number | null }>('SELECT * FROM device_overhead');
  const psCalls = () => s.requests.filter((r) => r.path === '/api/ps').length;
  try {
    const hub = core.db.get<{ id: string }>(`SELECT id FROM device WHERE role = 'hub'`)!.id;
    await core.models.assign('reasoner', { model: 'qwen3:14b' });
    // The ADR's case 5: loaded at 4k, 10.70 GB, all of it on the GPU.
    s.state.ps = loadedAs({ size: Math.round(10.70 * GiB), context: 4096 });
    await core.models.infer({ role: 'reasoner', messages: say('hi') });
    const first = row()!;
    assert.equal(first.device_id, hub, 'keyed by the hub’s own device id, so a hub that takes over doesn’t take it for its own');
    assert.equal(first.backend, 'ollama');
    assert.equal(first.samples, 1);
    assert.equal(g2(first.last_observed_bytes!), '1.41');
    assert.equal(g2(first.learned_bytes), '1.12', '1.00 + 0.3 × (1.41 − 1.00)');
    assert.ok(core.db.get(`SELECT 1 FROM sync_log WHERE tbl = 'device_overhead'`), 'replicated, so a standby knows it');
    assert.equal((await core.models.view()).devices[0]!.overhead, 'Overhead: 1.1 GB, measured from 1 load');

    // The same load, asked again: not counted twice.
    const before = psCalls();
    await core.models.infer({ role: 'reasoner', messages: say('again') });
    assert.ok(psCalls() > before, 'Nova read /api/ps after the call');
    assert.equal(row()!.samples, 1);

    // A load partly on the CPU says nothing about overhead.
    s.state.ps = loadedAs({ size: Math.round(10.70 * GiB), vram: 6 * GiB, context: 8192 });
    await core.models.infer({ role: 'reasoner', messages: say('partial') });
    assert.deepEqual(row(), first);

    // A reading past 4 GB is discarded and logged, not learned.
    s.state.ps = loadedAs({ size: 9_300_000_000 + 40 * 2048 * 8 * 128 * 4 + 5 * GiB, context: 2048 });
    await core.models.infer({ role: 'reasoner', messages: say('wild') });
    assert.deepEqual(row(), first);
    assert.match(readFileSync(join(home, 'logs', 'nova.log'), 'utf8'), /overhead reading of 5\.0 GB was discarded/);

    // The num_ctx Nova sent stands in for a context /api/ps doesn't report.
    s.state.ps = loadedAs({ size: 9_300_000_000 + 40 * 4096 * 8 * 128 * 4 + Math.round(1.41 * GiB) + 1 });
    await core.models.infer({ role: 'reasoner', messages: say('no context reported') });
    assert.equal(row()!.samples, 2);
  } finally {
    await core.close();
    await s.close();
  }
});

// ---- 4. recommendations from the engine --------------------------------------------------------

const installed = (list: { name: string; size: number; parameter_size: string; quant?: string; capabilities?: string[] }[]) =>
  list.map((m) => toInstalled({ name: m.name, size: m.size, digest: 'a'.repeat(64), details: { parameter_size: m.parameter_size, quantization_level: m.quant ?? 'Q4_K_M', family: 'qwen3' }, capabilities: m.capabilities ?? ['completion'] }));
const deviceOf = (hw: ReturnType<typeof hubHardware>, models: ReturnType<typeof installed> | [], over: Partial<DeviceModels> = {}): DeviceModels =>
  ({ id: 'hub', name: 'Example hub', hub: true, hardware: hw as never, models, url: 'http://127.0.0.1:1', ...over });
const mac16 = () => hubHardware({ gpus: [{ vendor: 'apple', name: 'Apple M2', vram_bytes: Math.floor(16 * GiB * 0.75), vram_free_bytes: null, unified: true }], ram_bytes: 16 * GiB });
const card8 = () => hubHardware({ gpus: [{ vendor: 'nvidia', name: 'Example GPU 8GB', vram_bytes: 8 * GiB, vram_free_bytes: null, unified: false }] });

test('recommendations use the fit engine: context and the learned overhead count, and the verdict says what it assumed', () => {
  const qwen = installed([{ name: 'qwen3:14b', size: 9_300_000_000, parameter_size: '14.8B' }, { name: 'qwen3:8b', size: 5_200_000_000, parameter_size: '8.2B' }]);
  // A 16 GB Mac: 14B at Q4_K_M and 4k won't fit its budget (2/3 of RAM), so 8B is the pick. File
  // size × 1.15 against 0.75 × RAM picked the 14B.
  const mac = recommend([deviceOf(mac16(), qwen)]).find((a) => a.role === 'reasoner')!.pick!;
  assert.equal(mac.model, 'qwen3:8b');
  assert.deepEqual([mac.fit!.verdict, mac.fit!.quant, mac.fit!.context], ['fits', 'Q4_K_M', 4096]);
  assert.match(mac.fit!.words, /^Estimate: Nova doesn’t know this model’s shape\. Fits comfortably at Q4_K_M with 4k context\./);
  // Nothing installed on it: the download suggested is 8B, not 14B.
  assert.equal(recommend([deviceOf(mac16(), [])]).find((a) => a.role === 'reasoner')!.pick!.model, 'qwen3:8b');
  assert.match(capacityWords(mac16() as Hardware), /^Runs models up to about .* parameters at Q4_K_M with 4k context\) on Apple M2, sharing 11 GB of memory\.$/);

  // The 24 GB hub: a 19.9e9-byte 32B model is only Tight there, so it is never the default (owner,
  // 2026-11-06); the 3B, which Fits, is.
  const tightHub = recommend([deviceOf(hubHardware(), installed([
    { name: 'example-deep:32b', size: 19.9e9, parameter_size: '32.8B' }, { name: 'example-small:3b', size: 2.0e9, parameter_size: '3.2B' },
  ]))]);
  assert.equal(tightHub.find((a) => a.role === 'reasoner')!.pick!.model, 'example-small:3b');
  assert.equal(tightHub.find((a) => a.role === 'reasoner')!.pick!.fit!.verdict, 'fits');
  // A 19.7e9-byte one Fits, and it and the 8B sorting model can't both stay loaded, now that the KV
  // cache for each is counted.
  const hub = recommend([deviceOf(hubHardware(), installed([
    { name: 'example-deep:32b', size: 19.7e9, parameter_size: '32.8B' }, { name: 'example-mid:8b', size: 5.0e9, parameter_size: '8.0B' },
  ]))]);
  assert.equal(hub.find((a) => a.role === 'reasoner')!.pick!.model, 'example-deep:32b');
  assert.equal(hub.find((a) => a.role === 'reasoner')!.pick!.fit!.verdict, 'fits');
  assert.match(hub.find((a) => a.role === 'reasoner')!.pick!.tradeoff, /can’t both stay loaded/);
  assert.equal(capacityWords(hubHardware() as Hardware), 'Runs models up to about 21 GB (around 35B parameters at Q4_K_M with 4k context) on Example GPU 24GB with 24 GB.');

  // An 8 GB card fits the 8B at the prior overhead; with 4 GB learned from real loads, it doesn't.
  const eight = installed([{ name: 'qwen3:8b', size: 5_000_000_000, parameter_size: '8.2B' }]);
  assert.equal(recommend([deviceOf(card8(), eight)]).find((a) => a.role === 'reasoner')!.pick?.model, 'qwen3:8b');
  const heavy = { bytes: 4 * GiB, n: 3, last_observed: 4 * GiB, updated_at: '2026-11-04T00:00:00.000Z' };
  const heavyAdvice = recommend([deviceOf(card8(), eight, { overhead: heavy })]).find((a) => a.role === 'reasoner')!;
  assert.equal(heavyAdvice.pick, null, 'neither the installed 8B nor any download fits');
  assert.match(heavyAdvice.words, /No text model that fits/);
  assert.ok(PRIOR_OVERHEAD_BYTES < heavy.bytes);
});
