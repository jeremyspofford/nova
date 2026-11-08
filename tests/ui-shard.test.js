import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { shards } from '../scripts/ui-shard.js';

const files = readdirSync('tests/ui').filter((f) => f.endsWith('.test.ts'));

test('UI shards: every UI test file runs in exactly one shard, at every shard count', () => {
  for (const n of [1, 2, 3, 4, 6]) {
    const all = shards(files, n).flat();
    assert.equal(all.length, files.length, `${n} shards: no file twice`);
    assert.deepEqual([...all].sort(), [...files].sort(), `${n} shards: no file left out`);
  }
});

test('UI shards: the five slowest files never share a shard when there are at least five', () => {
  const slow = ['m9-contrast.test.ts', 'fold-postures.test.ts', 'm9-vitals.test.ts', 'ui-rebuild-compositions.test.ts', 'models-screen-app.test.ts'];
  const where = shards(files, 5).map((s) => s.filter((f) => slow.includes(f)).length);
  assert.ok(where.every((c) => c <= 1), `slow files per shard: ${where}`);
});
