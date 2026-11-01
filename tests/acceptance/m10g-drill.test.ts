// The promotion drill (M10g), as a test: tests/acceptance/m10g-drill.ts runs every case and asserts as
// it goes. `node scripts/promotion-drill.ts` runs the same drill and records it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDrill } from './m10g-drill.ts';

test('the promotion drill: planned, rolled back at epoch + 2, emergency from a backup, fenced; never two hubs; no private key leaves its device', { timeout: 900_000 }, async () => {
  const lines: string[] = [];
  const r = await runDrill({ say: (l) => lines.push(l) });
  assert.deepEqual(r.steps.map((s) => s.case), [0, 1, 2, 3, 4, 6, 5, 7, 10, 8, 9], lines.join('\n'));
  assert.equal(r.probes.both, 0);
  assert.deepEqual(r.keys.found, []);
});
