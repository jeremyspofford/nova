// Slice 1a of the knowledge-graph ADR (docs/plans/knowledge-graph-adr-2026-11-10.md §6; F-062): the
// Memory view's filter and its true source line. The match rule is the command palette's; the source
// line never says "from a conversation" unless a conversation was matched. The page side (no request,
// no address, no storage, held items, the count) is tests/ui/memory-filter.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_FILTER_SCOPE, matchNorm, memoryFilterCount, memoryMatch, renderMemory } from '../ui/js/view.js';

test('the match rule: lower case, accents, apostrophes, text inside, words that each start a word', () => {
  const cases = [
    ['', 'anything', true, 'nothing typed matches all'],
    ['   ', 'anything', true, 'only spaces is nothing typed'],
    ['FRIDAY', 'Works from home on Fridays.', true, 'lower case'],
    ['cafe', 'Meets Sam at the Café on Main', true, 'an accent'],
    ['dont', 'I don’t eat meat', true, 'a curly apostrophe'],
    ["don't", 'I dont eat meat', true, 'a straight apostrophe typed'],
    ['me on', 'Works from home on Fridays.', true, 'typed text inside a row'],
    ['seed end', 'Send the seed order before the end of the month.', true, 'each typed word starts a word'],
    ['eed', 'Send the seed order', true, 'inside a word is inside the row'],
    ['order seeds', 'Send the seed order', false, 'one typed word starts no word'],
    ['fridya', 'Works from home on Fridays.', false, 'no spelling correction'],
    ['home-office', 'Works from home office days', true, 'other marks count as spaces'],
  ];
  for (const [q, text, want, why] of cases) assert.equal(memoryMatch(q, text), want, `${why}: “${q}” in “${text}”`);
  assert.equal(matchNorm('Ça Va’s—Fine!'), 'ca vas fine');
});

test('the count and the scope line', () => {
  assert.equal(memoryFilterCount(14, 37), '14 of 37 shown.');
  assert.equal(MEMORY_FILTER_SCOPE, 'Looked in memories and day notes. Did not look inside conversations.');
});

const NOW = new Date('2026-11-10T12:00:00');
const entry = (id, text, extra = {}) => ({ id, text, time: null, from: null, at: '2026-11-09T10:00:00Z', updated: null, by: 'nova', ...extra });
const data = (entries, more = {}) => ({ sections: [{ title: 'Facts', entries }], days: [], titles: { s1: 'The kitchen shelf' }, ...more });
const sourceOf = (html, id) => new RegExp(`id="m-${id}"[\\s\\S]*?<p class="memory-source">([\\s\\S]*?)</p>`).exec(html)?.[1] ?? null;

// Slice 1a's rule, kept: no row names a conversation it didn't match. F-038 (tests/memory-origin.test.js)
// then names captured items, devices and imports truly, so this checks only what 1a settled.
test('the source line: a matched conversation links to its turn; an unmatched one is not guessed at', () => {
  const html = renderMemory(data([
    entry('matched', 'Shelf at eye level.', { from: 's1/k1' }),
    entry('hand', 'Written by hand.', { by: 'hand' }),
    entry('gone', 'From a conversation Nova has no title for.', { from: 's9/k2' }),
  ]), NOW);
  assert.match(sourceOf(html, 'matched'), /from <a class="memory-from" href="\/c\/s1#t-k1">“The kitchen shelf”<\/a>/);
  assert.equal(sourceOf(html, 'hand'), 'written into MEMORY.md by hand');
  assert.equal(sourceOf(html, 'gone'), 'Nova cannot show where this came from yet.');
  assert.doesNotMatch(html, /from a conversation/, 'no row says "from a conversation" without a matched one');
});

test('the filter box is drawn once, with the list, and not on an empty Memory', () => {
  const html = renderMemory(data([entry('a', 'One thing.')]), NOW);
  assert.equal(html.match(/id="memory-filter"/g)?.length, 1);
  assert.match(html, /<input type="search"[^>]*id="memory-filter"[^>]*aria-describedby="memory-filter-count memory-filter-scope"/);
  assert.match(html, /<p class="memory-filter-count" id="memory-filter-count" role="status"><\/p>/);
  assert.ok(html.indexOf('id="memory-filter"') < html.indexOf('class="memory-list"'), 'the box comes before the list');
  assert.doesNotMatch(renderMemory({ sections: [], days: [] }, NOW), /memory-filter/, 'nothing to filter: no box');
  // Something waiting and nothing kept: still nothing to filter.
  assert.doesNotMatch(renderMemory({ sections: [], days: [], candidates: [{ id: 'c1', op: 'remember', content: 'x', taint: [] }] }, NOW), /memory-filter/);
});

test('held items sit above the box, outside what it filters', () => {
  const html = renderMemory(data([entry('a', 'One thing.')], { candidates: [{ id: 'c1', op: 'forget', target_text: 'One thing.', taint: [] }] }), NOW);
  assert.ok(html.indexOf('id="waiting"') < html.indexOf('id="memory-filter"'));
});
