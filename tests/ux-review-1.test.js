// UX review 1, F4, the pure part: identical status lines one after another show once. Held memory
// says how many wait; two margins in a row that say the same thing show once; different lines,
// or the same line apart, are all kept. (tests/ingest/held-once.test.js: the event fires once.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseLines, renderKept, renderTurn } from '../ui/js/view.js';

const count = (html, re) => (html.match(re) ?? []).length;

test('held memory: one line, saying how many wait', () => {
  assert.equal(count(renderKept([{ op: 'remember', ok: true, held: true, id: 'a' }]), /waiting for your OK/g), 1);
  assert.match(renderKept([{ op: 'remember', ok: true, held: true, id: 'a' }]), /waiting for your OK<\/a>: this came after reading something from outside/);
  const two = renderKept([{ op: 'remember', ok: true, held: true, id: 'a' }, { op: 'note', ok: true, held: true, id: 'b' }]);
  assert.equal(count(two, /waiting for your OK/g), 1);
  assert.match(two, /2 things waiting for your OK/);
});

test('identical lines one after another collapse; different or separated ones stay', () => {
  const forgot = { op: 'forget', ok: true, id: 'x' };
  assert.equal(count(renderKept([forgot, forgot]), /forgot something/g), 1);
  const memory = new Map([['m1', { text: 'Likes tea.' }], ['m2', { text: 'Likes coffee.' }]]);
  const kept = renderKept([{ op: 'remember', ok: true, id: 'm1' }, { op: 'remember', ok: true, id: 'm2' }], memory);
  assert.equal(count(kept, /kept in memory/g), 2, 'two different memories are two lines');
  assert.equal(count(collapseLines([['a', 'A'], ['b', 'B'], ['a', 'A']]), /A/g), 2, 'the same line, apart, is kept');
});

test('two margins in a row that say the same thing show once', () => {
  const held = { kind: 'memory', ops: [{ op: 'remember', ok: true, held: true, id: 'a' }] };
  const turn = { id: 't1', text: 'Hi', ts: '2026-10-31T09:00:00Z', state: 'done', items: [{ kind: 'text', id: 'x', text: 'Hello.', ts: '2026-10-31T09:00:01Z' }, held, { ...held }] };
  const html = renderTurn(turn);
  assert.equal(count(html, /waiting for your OK/g), 1);
  assert.match(html, /<div class="margins" role="note" aria-label="Kept in memory">/, 'a note, not a landmark');
  assert.doesNotMatch(html, /<aside/);
});
