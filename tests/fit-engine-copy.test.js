// The browser's copy of the fit engine (ui/js/fit-engine.js) is fit.ts with its types erased and
// nothing else, so the Models screen's composition shows the engine's real verdicts. It fails when
// fit.ts changes without the copy being regenerated (node scripts/gen-fit-engine.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TARGET, engineModule } from '../scripts/gen-fit-engine.js';
import * as ts from '../src/core/models/fit.ts';

test('ui/js/fit-engine.js is fit.ts with its types erased', () => {
  assert.equal(readFileSync(TARGET, 'utf8'), engineModule(), 'run: node scripts/gen-fit-engine.js');
});

test('the browser copy computes what fit.ts computes', async () => {
  const js = await import('../ui/js/fit-engine.js');
  assert.deepEqual(Object.keys(js).sort(), Object.keys(ts).sort(), 'the same exports');
  const device = { memory: 'gpu', budget_bytes: 24 * ts.GiB, other_use_bytes: 0, other_use_known: true, overhead_bytes: ts.PRIOR_OVERHEAD_BYTES, overhead_source: 'prior' };
  const model = { name: 'qwen3:32b', params: 32_800_000_000, weights_bytes: null, quant: 'Q4_K_M', context: 4096, arch: { layers: 64, kv_heads: 8, head_dim: 128 }, arch_source: 'catalog', kv_type: 'f16' };
  assert.deepEqual(js.fit({ device, models: [model] }), ts.fit({ device, models: [model] }));
  assert.equal(js.fit({ device, models: [model] }).verdict, 'tight', 'ADR golden case 1: 32B at Q4_K_M, 4k on a 3090 is Tight');
});
