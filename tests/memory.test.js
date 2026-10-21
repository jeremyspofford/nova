import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchMemory, terms } from '../src/memory.js';

const home = mkdtempSync(join(tmpdir(), 'nova-m-'));
mkdirSync(join(home, 'memory'));
writeFileSync(join(home, 'memory', '2026-10-19.md'), '# Monday\n\n- Maverick has a new inhaler plan from Dr. Lee.\n- Paid the electric bill.\n');
writeFileSync(join(home, 'memory', '2026-10-20.md'), '# Tuesday\n\n- Flying Tools VPC endpoint migration is the only client work this week.\n');
writeFileSync(join(home, 'memory', 'README.md'), 'inhaler inhaler inhaler');

test('terms drop stopwords and short words', () => {
  assert.deepEqual(terms("What's Maverick's inhaler plan?"), ['maverick', 'inhaler', 'plan']);
});

test('finds the matching bullet with its source', () => {
  const hits = searchMemory(home, "What is Maverick's inhaler plan again?");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'memory/2026-10-19.md');
  assert.match(hits[0].text, /inhaler plan/);
});

test('ignores README and unrelated questions', () => {
  assert.deepEqual(searchMemory(home, 'Tell me a joke about penguins'), []);
});

test('no memory folder is not an error', () => {
  assert.deepEqual(searchMemory(join(home, 'nope'), 'inhaler plan'), []);
});
