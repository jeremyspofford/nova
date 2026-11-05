// The model-fit engine (docs/plans/model-fit-adr-2026-11-04.md): the ADR's golden cases, one test
// each, in integer bytes. Every figure is the ADR's, printed as GiB to two places; the boundary and
// the 6k context are also checked to the byte. Pure arithmetic: no network, no files.
//
// The unified-memory Macs are tested against UNIFIED_BUDGET_FRACTION_BELOW_36GB, an open owner
// question (2/3, the ADR's choice, or today's 0.75). Both expected tables are below, so the answer
// is a one-line change to that constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GiB, PRIOR_OVERHEAD_BYTES, UNIFIED_BUDGET_FRACTION_BELOW_36GB, TIER_TABLE, REFERENCE_SHAPES,
  deviceBudget, fit, learnOverhead, overheadWords, priorOverhead, recommendFit, unifiedBudgetBytes,
  type FitCandidate, type FitDevice, type FitModel, type Quant, type TaskAdvice, type Verdict,
} from '../../src/core/models/fit.ts';
import type { Hardware } from '../../src/core/models/hardware.ts';

// The ADR's assumed architectures (Qwen3 model cards, as recorded in the ADR).
const ARCH = {
  '8B': { params: 8_200_000_000, layers: 36, kv_heads: 8, head_dim: 128, name: 'qwen3:8b' },
  '14B': { params: 14_800_000_000, layers: 40, kv_heads: 8, head_dim: 128, name: 'qwen3:14b' },
  '32B': { params: 32_800_000_000, layers: 64, kv_heads: 8, head_dim: 128, name: 'qwen3:32b' },
} as const;
type Cls = keyof typeof ARCH;
const CTX = { '4k': 4096, '16k': 16384 } as const;

const g2 = (b: number) => (b / GiB).toFixed(2);
const device = (budget: number, memory: FitDevice['memory'] = 'gpu'): FitDevice => ({
  memory, budget_bytes: budget, other_use_bytes: 0, other_use_known: true, overhead_bytes: PRIOR_OVERHEAD_BYTES, overhead_source: 'prior',
});
const planned = (c: Cls, quant: Quant, ctx: keyof typeof CTX): FitModel => {
  const a = ARCH[c];
  return { name: a.name, params: a.params, weights_bytes: null, quant, context: CTX[ctx], arch: { layers: a.layers, kv_heads: a.kv_heads, head_dim: a.head_dim }, arch_source: 'catalog', kv_type: 'f16' };
};

// One golden row: model, quant, context, weights, KV, overhead, reserve, need, headroom, verdict.
type Row = [Cls, Quant, keyof typeof CTX, string, string, string, string, string, string, Verdict];
function checkRows(budget: number, rows: Row[], memory: FitDevice['memory'] = 'gpu') {
  for (const [c, q, ctx, w, kv, o, r, need, head, verdict] of rows) {
    const res = fit({ device: device(budget, memory), models: [planned(c, q, ctx)] });
    const label = `${c} ${q} ${ctx}`;
    assert.equal(res.basis, 'formula', label);
    assert.deepEqual(res.assumed, [{ quant: q, context: CTX[ctx], kv_type: 'f16' }], label);
    assert.deepEqual(
      [g2(res.parts[0]!.weights_bytes), g2(res.parts[0]!.kv_bytes), g2(res.overhead_bytes), g2(res.reserve_bytes), g2(res.need_bytes), g2(res.headroom_bytes), res.verdict],
      [w, kv, o, r, need, head, verdict], label,
    );
    assert.ok(Number.isInteger(res.need_bytes) && Number.isInteger(res.headroom_bytes), `${label}: integer bytes`);
    assert.equal(res.need_bytes, res.parts[0]!.weights_bytes + res.parts[0]!.kv_bytes + res.overhead_bytes + res.reserve_bytes + res.other_use_bytes, label);
    assert.equal(res.headroom_bytes, budget - res.need_bytes, label);
    assert.match(res.words, new RegExp(`at ${q} with ${ctx} context`), label);
  }
}

// The candidates every recommendation sees: the three classes, planned, plus a cloud model and an
// Ollama model that runs remotely. Under local-only neither may appear anywhere in the output.
const CANDIDATES: FitCandidate[] = [
  ...(Object.keys(ARCH) as Cls[]).map((c): FitCandidate => ({
    name: ARCH[c].name, params: ARCH[c].params, capabilities: ['completion'], where: 'local', installed: null,
    arch: { layers: ARCH[c].layers, kv_heads: ARCH[c].kv_heads, head_dim: ARCH[c].head_dim }, arch_source: 'catalog',
  })),
  { name: 'example-cloud-model', params: 400_000_000_000, capabilities: ['completion'], where: 'cloud', installed: null, arch: null, arch_source: null },
  { name: 'example-remote:120b-cloud', params: 120_000_000_000, capabilities: ['completion'], where: 'remote', installed: null, arch: null, arch_source: null },
];
const CLOUDY = ['example-cloud-model', 'example-remote:120b-cloud'];

const short = (p: TaskAdvice['pick']) => (p ? `${p.name} ${p.quant} ${p.context / 1024}k ${p.verdict}` : null);
function advise(budget: number, task: 'general-chat' | 'coding', memory: FitDevice['memory'] = 'gpu') {
  const a = recommendFit({ device: device(budget, memory), privacy: 'local-only', task, hub: true, candidates: CANDIDATES });
  const out = JSON.stringify(a);
  for (const n of CLOUDY) assert.ok(!out.includes(n), `${n} must not appear under local-only`);
  assert.deepEqual(a.cloud, []);
  return a;
}

// ---- Case 1: a 24 GB RTX 3090 --------------------------------------------------------------------

test('Case 1, a 24 GB RTX 3090: the ADR table, to the hundredth of a GB', () => {
  checkRows(24 * GiB, [
    ['8B', 'Q8_0', '16k', '8.11', '2.25', '1.00', '1.20', '12.56', '11.44', 'fits'],
    ['14B', 'Q8_0', '4k', '14.65', '0.63', '1.00', '1.20', '17.47', '6.53', 'fits'],
    ['14B', 'Q8_0', '16k', '14.65', '2.50', '1.00', '1.20', '19.35', '4.65', 'fits'],
    ['32B', 'Q4_K_M', '4k', '19.09', '1.00', '1.00', '1.20', '22.29', '1.71', 'tight'],
    ['32B', 'Q4_K_M', '16k', '19.09', '4.00', '1.00', '1.20', '25.29', '-1.29', 'wont-fit'],
    ['32B', 'Q8_0', '4k', '32.46', '1.00', '1.00', '1.20', '35.66', '-11.66', 'wont-fit'],
  ]);
});

test('Case 1, a 24 GB RTX 3090: chat picks 32B Q4_K_M (tight), coding picks 14B Q8_0 at 16k', () => {
  const chat = advise(24 * GiB, 'general-chat');
  assert.equal(short(chat.pick), 'qwen3:32b Q4_K_M 4k tight');
  assert.equal(short(chat.alternative), 'qwen3:14b Q8_0 4k fits');
  const code = advise(24 * GiB, 'coding');
  assert.equal(short(code.pick), 'qwen3:14b Q8_0 16k fits');
  assert.equal(short(code.alternative), 'qwen3:8b Q8_0 16k fits');
});

// ---- Case 2: an 8 GB card ------------------------------------------------------------------------

test('Case 2, an 8 GB card: the ADR table', () => {
  checkRows(8 * GiB, [
    ['8B', 'Q4_K_M', '4k', '4.77', '0.56', '1.00', '0.50', '6.84', '1.16', 'fits'],
    ['8B', 'Q4_K_M', '16k', '4.77', '2.25', '1.00', '0.50', '8.52', '-0.52', 'wont-fit'],
    ['8B', 'Q8_0', '4k', '8.11', '0.56', '1.00', '0.50', '10.18', '-2.18', 'wont-fit'],
    ['14B', 'Q4_K_M', '4k', '8.61', '0.63', '1.00', '0.50', '10.74', '-2.74', 'wont-fit'],
  ]);
});

test('Case 2, an 8 GB card: 8B Q4_K_M fits up to 6k, from 995,328,396 bytes ÷ 147,456 per token', () => {
  const res = fit({ device: device(8 * GiB), models: [planned('8B', 'Q4_K_M', '16k')] });
  const room = Math.floor(8 * GiB * 0.9) - res.parts[0]!.weights_bytes - res.overhead_bytes - res.reserve_bytes;
  assert.equal(room, 995_328_396);
  assert.equal(Math.floor(room / 147_456), 6750);
  assert.equal(res.max_context_fits, 6144);
  assert.equal(res.words, 'Won’t fit at Q4_K_M with 16k context. At Q4_K_M it fits up to 6k.');
});

test('Case 2, an 8 GB card: chat picks 8B Q4_K_M; coding has no local pick and says 6k', () => {
  const chat = advise(8 * GiB, 'general-chat');
  assert.equal(short(chat.pick), 'qwen3:8b Q4_K_M 4k fits');
  assert.equal(chat.alternative, null);
  const code = advise(8 * GiB, 'coding');
  assert.equal(code.pick, null);
  assert.equal(code.alternative, null);
  assert.deepEqual(code.nothing_fits, { name: 'qwen3:8b', quant: 'Q4_K_M', max_context: 6144 });
  assert.match(code.words, /qwen3:8b at Q4_K_M fits up to 6k/);
});

// ---- Cases 3 and 4: unified-memory Macs, against the pending budget constant --------------------

const TWO_THIRDS = UNIFIED_BUDGET_FRACTION_BELOW_36GB === 2 / 3;
assert.ok(TWO_THIRDS || UNIFIED_BUDGET_FRACTION_BELOW_36GB === 0.75, 'the Mac tables below cover 2/3 and 0.75 only');

test('unified memory: the budget is the named constant × RAM below 36 GB, 3/4 from 36 GB', () => {
  assert.equal(unifiedBudgetBytes(16 * GiB), Math.floor(16 * GiB * UNIFIED_BUDGET_FRACTION_BELOW_36GB));
  assert.equal(unifiedBudgetBytes(32 * GiB), Math.floor(32 * GiB * UNIFIED_BUDGET_FRACTION_BELOW_36GB));
  assert.equal(unifiedBudgetBytes(36 * GiB), 27 * GiB);
  assert.equal(unifiedBudgetBytes(64 * GiB), 48 * GiB);
});

test('Case 3, a 16 GB unified-memory Mac: the table at the pending budget fraction', () => {
  const budget = unifiedBudgetBytes(16 * GiB);
  if (TWO_THIRDS) {
    assert.equal(g2(budget), '10.67');
    checkRows(budget, [
      ['8B', 'Q4_K_M', '4k', '4.77', '0.56', '1.00', '0.53', '6.87', '3.80', 'fits'],
      ['8B', 'Q4_K_M', '16k', '4.77', '2.25', '1.00', '0.53', '8.56', '2.11', 'fits'],
      ['8B', 'Q8_0', '4k', '8.11', '0.56', '1.00', '0.53', '10.21', '0.46', 'tight'],
      ['14B', 'Q4_K_M', '4k', '8.61', '0.63', '1.00', '0.53', '10.77', '-0.11', 'wont-fit'],
    ], 'unified');
  } else {
    // At 0.75 (budget 12.00 GB) 14B at Q4_K_M, 4k is Tight instead of Won't fit, as the ADR says.
    checkRows(budget, [
      ['8B', 'Q4_K_M', '4k', '4.77', '0.56', '1.00', '0.60', '6.94', '5.06', 'fits'],
      ['8B', 'Q4_K_M', '16k', '4.77', '2.25', '1.00', '0.60', '8.62', '3.38', 'fits'],
      ['8B', 'Q8_0', '4k', '8.11', '0.56', '1.00', '0.60', '10.28', '1.72', 'fits'],
      ['14B', 'Q4_K_M', '4k', '8.61', '0.63', '1.00', '0.60', '10.84', '1.16', 'tight'],
    ], 'unified');
  }
});

test('Case 3, a 16 GB unified-memory Mac: picks at the pending budget fraction', () => {
  const budget = unifiedBudgetBytes(16 * GiB);
  const chat = advise(budget, 'general-chat', 'unified');
  const code = advise(budget, 'coding', 'unified');
  if (TWO_THIRDS) {
    // Fits ranks before Tight within a class, so not 8B at Q8_0.
    assert.equal(short(chat.pick), 'qwen3:8b Q4_K_M 4k fits');
    assert.equal(chat.alternative, null);
    assert.equal(short(code.pick), 'qwen3:8b Q4_K_M 16k fits');
    assert.equal(code.alternative, null);
  } else {
    assert.equal(short(chat.pick), 'qwen3:14b Q4_K_M 4k tight');
    assert.equal(short(chat.alternative), 'qwen3:8b Q8_0 4k fits');
    assert.equal(short(code.pick), 'qwen3:8b Q4_K_M 16k fits');
    assert.equal(code.alternative, null);
  }
});

test('Case 4, a 32 GB unified-memory Mac: the table at the pending budget fraction', () => {
  const budget = unifiedBudgetBytes(32 * GiB);
  if (TWO_THIRDS) {
    assert.equal(g2(budget), '21.33');
    checkRows(budget, [
      ['8B', 'Q8_0', '16k', '8.11', '2.25', '1.00', '1.07', '12.43', '8.90', 'fits'],
      ['14B', 'Q4_K_M', '16k', '8.61', '2.50', '1.00', '1.07', '13.18', '8.15', 'fits'],
      ['14B', 'Q8_0', '4k', '14.65', '0.63', '1.00', '1.07', '17.34', '4.00', 'fits'],
      ['14B', 'Q8_0', '16k', '14.65', '2.50', '1.00', '1.07', '19.21', '2.12', 'tight'],
      ['32B', 'Q4_K_M', '4k', '19.09', '1.00', '1.00', '1.07', '22.16', '-0.83', 'wont-fit'],
    ], 'unified');
  } else {
    assert.equal(budget, 24 * GiB); // the same budget as the 3090, so Case 1's table applies
  }
});

test('Case 4, a 32 GB Mac: 14B Q8_0 at 16k is Tight by 12,577,977 bytes over the Fits limit', () => {
  if (!TWO_THIRDS) return;
  const budget = unifiedBudgetBytes(32 * GiB);
  assert.equal(budget, 22_906_492_245);
  const res = fit({ device: device(budget, 'unified'), models: [planned('14B', 'Q8_0', '16k')] });
  assert.equal(res.reserve_bytes, 1_145_324_613);
  assert.equal(res.need_bytes, 20_628_420_997);
  assert.ok(res.need_bytes * 10 > budget * 9 && res.need_bytes <= budget);
  assert.equal(res.need_bytes - Math.floor(budget * 0.9), 12_577_977);
  assert.equal(res.verdict, 'tight');
});

test('Case 4, a 32 GB unified-memory Mac: picks at the pending budget fraction', () => {
  const budget = unifiedBudgetBytes(32 * GiB);
  const chat = advise(budget, 'general-chat', 'unified');
  const code = advise(budget, 'coding', 'unified');
  if (TWO_THIRDS) {
    assert.equal(short(chat.pick), 'qwen3:14b Q8_0 4k fits');
    assert.equal(short(chat.alternative), 'qwen3:8b Q8_0 4k fits');
    // 14B at Q8_0 at 16k is Tight, so the Fits one at Q4_K_M is the pick.
    assert.equal(short(code.pick), 'qwen3:14b Q4_K_M 16k fits');
    assert.equal(short(code.alternative), 'qwen3:8b Q8_0 16k fits');
  } else {
    assert.equal(short(chat.pick), 'qwen3:32b Q4_K_M 4k tight');
    assert.equal(short(code.pick), 'qwen3:14b Q8_0 16k fits');
  }
});

// ---- Case 5: the learned overhead (3090) ---------------------------------------------------------

const AT = '2026-11-04T12:00:00.000Z';
const loaded14b = (size: number, size_vram = size) => ({
  size_bytes: size, size_vram_bytes: size_vram, weights_bytes: 9_300_000_000, context: 4096,
  arch: { layers: 40, kv_heads: 8, head_dim: 128 }, kv_type: 'f16' as const,
});

test('Case 5, learned overhead: 10.70 GB loaded for an 8.66 GB file observes 1.41 GB and learns 1.12 GB', () => {
  const size = Math.round(10.70 * GiB);
  assert.equal(g2(9_300_000_000), '8.66');
  const r = learnOverhead(priorOverhead(), loaded14b(size), AT);
  assert.equal(r.outcome, 'learned');
  assert.equal(g2(r.observed_bytes!), '1.41');
  assert.equal(g2(r.state.bytes), '1.12');
  assert.equal(r.state.bytes, Math.round(PRIOR_OVERHEAD_BYTES + 0.3 * (r.observed_bytes! - PRIOR_OVERHEAD_BYTES)));
  assert.deepEqual([r.state.n, r.state.last_observed, r.state.updated_at], [1, r.observed_bytes, AT]);
  assert.equal(overheadWords(r.state), 'Overhead: 1.1 GB, measured from 1 load');
  assert.equal(overheadWords(priorOverhead()), 'Overhead: 1.0 GB, Nova’s estimate');

  // The next estimate uses it; the reserve is never learned.
  const before = fit({ device: device(24 * GiB), models: [planned('14B', 'Q4_K_M', '4k')] });
  const after = fit({ device: { ...device(24 * GiB), overhead_bytes: r.state.bytes, overhead_source: 'learned' }, models: [planned('14B', 'Q4_K_M', '4k')] });
  assert.equal(after.overhead_bytes, r.state.bytes);
  assert.equal(after.reserve_bytes, before.reserve_bytes);
  assert.equal(after.need_bytes - before.need_bytes, r.state.bytes - PRIOR_OVERHEAD_BYTES);
});

test('Case 5, learned overhead: a partial load teaches nothing', () => {
  const prior = priorOverhead();
  const size = Math.round(10.70 * GiB);
  const r = learnOverhead(prior, loaded14b(size, size - 1), AT);
  assert.equal(r.outcome, 'partial');
  assert.deepEqual(r.state, prior);
});

test('Case 5, learned overhead: a 5 GB observation is discarded and logged; so is one under 0.25 GB', () => {
  const kv = 40 * 4096 * 8 * 128 * 2 * 2;
  for (const observed of [5 * GiB, 0.2 * GiB]) {
    const logged: string[] = [];
    const prior = priorOverhead();
    const r = learnOverhead(prior, loaded14b(9_300_000_000 + kv + Math.round(observed)), AT, (line) => logged.push(line));
    assert.equal(r.outcome, 'discarded');
    assert.equal(r.observed_bytes, Math.round(observed));
    assert.deepEqual(r.state, prior);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /discarded/);
  }
});

test('learned overhead: stays within 0.25–4 GB, even from a stored value outside it', () => {
  const kv = 40 * 4096 * 8 * 128 * 2 * 2;
  const high = learnOverhead({ bytes: 3.9 * GiB, n: 9, last_observed: 3.9 * GiB, updated_at: AT }, loaded14b(9_300_000_000 + kv + 4 * GiB), AT);
  assert.ok(high.state.bytes <= 4 * GiB && high.state.bytes > 3.9 * GiB);
  const corrupt = learnOverhead({ bytes: 40 * GiB, n: 2, last_observed: null, updated_at: AT }, loaded14b(9_300_000_000 + kv + 2 * GiB), AT);
  assert.ok(corrupt.state.bytes <= 4 * GiB);
});

// ---- Combinations, the fallback tier table, privacy, the budget ---------------------------------

test('a combination counts overhead and the reserve once, and names each model’s quant and context', () => {
  const one = fit({ device: device(24 * GiB), models: [planned('8B', 'Q4_K_M', '4k')] });
  const two = fit({ device: device(24 * GiB), models: [planned('8B', 'Q4_K_M', '4k'), planned('14B', 'Q4_K_M', '4k')] });
  assert.equal(two.parts.length, 2);
  assert.equal(two.overhead_bytes, one.overhead_bytes);
  assert.equal(two.reserve_bytes, one.reserve_bytes);
  assert.equal(two.need_bytes, two.parts.reduce((s, p) => s + p.weights_bytes + p.kv_bytes, 0) + two.overhead_bytes + two.reserve_bytes);
  assert.equal(two.assumed.length, 2);
  assert.equal(two.max_context_fits, null);
  assert.match(two.words, /qwen3:8b at Q4_K_M with 4k context/);
  assert.match(two.words, /qwen3:14b at Q4_K_M with 4k context/);
});

test('installed models use the file’s size, not bits per weight', () => {
  const m = { ...planned('14B', 'Q4_K_M', '4k'), weights_bytes: 9_300_000_000 };
  assert.equal(fit({ device: device(24 * GiB), models: [m] }).parts[0]!.weights_bytes, 9_300_000_000);
});

test('the fallback tier table: the ADR bands, labelled as the fallback, from the same formula', () => {
  const rows = TIER_TABLE.map((r) => [r.band_gb, r.expect]);
  assert.deepEqual(rows, [
    [4, '3B (tight)'],
    [6, '4B'],
    [8, '8B'],
    [12, '14B (tight), or 8B at Q8_0'],
    [16, '14B'],
    [24, '32B (tight), or 14B at Q8_0'],
    [32, '32B'],
    [48, '32B at Q8_0'],
  ]);
  for (const r of TIER_TABLE) assert.equal(r.basis, 'tier-table');
  for (const r of TIER_TABLE) assert.match(r.label, /^Estimate/);
});

test('the fallback tier table is never more generous than the engine for a catalog model', () => {
  const rank: Record<Verdict, number> = { fits: 0, tight: 1, 'wont-fit': 2 };
  let checked = 0;
  for (const row of TIER_TABLE) {
    for (const e of row.entries) {
      const shape = REFERENCE_SHAPES.find((s) => s.class === e.class)!;
      const res = fit({ device: device(row.band_gb * GiB), models: [{ name: shape.name, params: shape.params, weights_bytes: null, quant: e.quant, context: 4096, arch: shape.arch, arch_source: 'catalog', kv_type: 'f16' }] });
      assert.ok(rank[e.verdict] >= rank[res.verdict], `${row.band_gb} GB ${e.class} ${e.quant}`);
      checked++;
    }
  }
  assert.ok(checked > 10);
});

test('a model whose shape Nova doesn’t know is estimated from the reference shapes, and says so', () => {
  const res = fit({ device: device(8 * GiB), models: [{ ...planned('8B', 'Q4_K_M', '4k'), name: 'example-unknown:8b', arch: null, arch_source: null }] });
  assert.equal(res.basis, 'tier-table');
  assert.match(res.words, /^Estimate: Nova doesn’t know this model’s shape\./);
  assert.equal(res.max_context_fits, null);
  const known = fit({ device: device(8 * GiB), models: [planned('8B', 'Q4_K_M', '4k')] });
  assert.ok(res.need_bytes >= known.need_bytes);
});

test('privacy filters first: local-preferred lists cloud after local; local-only drops cloud and remote', () => {
  const base = { device: device(24 * GiB), task: 'general-chat' as const, hub: true, candidates: CANDIDATES };
  const pref = recommendFit({ ...base, privacy: 'local-preferred' });
  assert.equal(short(pref.pick), 'qwen3:32b Q4_K_M 4k tight');
  assert.deepEqual(pref.cloud.map((c) => c.name), CLOUDY);
  assert.equal(pref.cloud_order, 'after-local');
  for (const c of pref.cloud) assert.equal(c.words, 'runs off your devices');
  const allowed = recommendFit({ ...base, privacy: 'cloud-allowed' });
  assert.equal(allowed.cloud_order, 'beside-local');
  advise(24 * GiB, 'general-chat');
});

test('task classes: chat leaves coders out, coding ranks coders first, screening is small and on the hub', () => {
  const coder: FitCandidate = { ...CANDIDATES[0]!, name: 'example-coder:8b' };
  const cands = [...CANDIDATES, coder];
  const chat = recommendFit({ device: device(24 * GiB), privacy: 'local-only', task: 'general-chat', hub: true, candidates: cands });
  assert.ok(!JSON.stringify(chat).includes('example-coder'));
  const code = recommendFit({ device: device(24 * GiB), privacy: 'local-only', task: 'coding', hub: true, candidates: cands });
  assert.equal(code.pick?.name, 'example-coder:8b');
  const screen = recommendFit({ device: device(24 * GiB), privacy: 'local-only', task: 'screening', hub: true, candidates: cands });
  assert.equal(short(screen.pick), 'qwen3:8b Q8_0 4k fits');
  const spoke = recommendFit({ device: device(24 * GiB), privacy: 'local-only', task: 'screening', hub: false, candidates: cands });
  assert.equal(spoke.pick, null);
  const tx = recommendFit({ device: device(24 * GiB), privacy: 'local-only', task: 'transcription', hub: true, candidates: cands });
  assert.equal(tx.pick, null);
});

const hw = (over: Partial<Hardware>): Hardware => ({
  at: AT, platform: 'linux', arch: 'x64', hostname: 'example', cpu: { model: 'Example CPU', threads: 8 },
  ram_bytes: 32 * GiB, ram_free_bytes: 16 * GiB, gpus: [], disk: null, network: [], whisper: null, sources: [], ...over,
});

test('the device budget: one GPU’s VRAM, the unified constant on a Mac, half the RAM on the CPU', () => {
  const card = deviceBudget(hw({ gpus: [{ vendor: 'nvidia', name: 'Example 24GB', vram_bytes: 24576 * 1024 * 1024, vram_free_bytes: 23 * GiB, unified: false }] }), { loaded_vram_bytes: 0 });
  assert.deepEqual([card.memory, card.budget_bytes, card.other_use_bytes, card.other_use_known, card.overhead_source], ['gpu', 24 * GiB, 1 * GiB, true, 'prior']);
  // hardware.ts still writes 0.75 × RAM for an Apple GPU; the engine uses its own constant.
  const mac = deviceBudget(hw({ platform: 'darwin', arch: 'arm64', ram_bytes: 16 * GiB, gpus: [{ vendor: 'apple', name: 'Apple M-series', vram_bytes: 12 * GiB, vram_free_bytes: null, unified: true }] }));
  assert.deepEqual([mac.memory, mac.budget_bytes, mac.other_use_known], ['unified', unifiedBudgetBytes(16 * GiB), false]);
  const cpu = deviceBudget(hw({}));
  assert.deepEqual([cpu.memory, cpu.budget_bytes], ['cpu', 16 * GiB]);
  const two = deviceBudget(hw({ gpus: [8, 24].map((n) => ({ vendor: 'nvidia' as const, name: `Example ${n}GB`, vram_bytes: n * GiB, vram_free_bytes: null, unified: false })) }));
  assert.equal(two.budget_bytes, 24 * GiB);
  const learned = deviceBudget(hw({}), { overhead: { bytes: 1.2 * GiB, n: 3, last_observed: 1.3 * GiB, updated_at: AT } });
  assert.deepEqual([learned.overhead_bytes, learned.overhead_source], [1.2 * GiB, 'learned']);
});

test('verdicts say what Nova can’t see, and when the work runs on the CPU', () => {
  const unseen = fit({ device: { ...device(24 * GiB), other_use_known: false }, models: [planned('8B', 'Q4_K_M', '4k')] });
  assert.match(unseen.words, /can’t see what else is using/);
  const cpu = fit({ device: device(16 * GiB, 'cpu'), models: [planned('8B', 'Q4_K_M', '4k')] });
  assert.match(cpu.words, /on the CPU, slow/);
});
