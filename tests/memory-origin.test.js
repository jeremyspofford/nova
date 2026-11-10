// F-038 (≡ A-086): the Memory view says where each memory came from, truly, in every case, and marks
// what Nova wrote that the person hasn't checked. Placed straight after slice 1a by the owner's ruling
// on the knowledge-graph ADR (docs/plans/knowledge-graph-adr-2026-11-10.md, question 8). It reads only
// the records and stores Nova already keeps: the memory row (source, recorded_by, user_state), the
// device registry for names, and capture's promotion rows. No new route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryOrigin, renderMemory, unchecked } from '../ui/js/view.js';
import { originsOf } from '../src/memory.js';

const NO_SOURCE = 'Nova cannot show where this came from yet.';
const NOW = new Date('2026-11-10T12:00:00');
const entry = (id, extra = {}) => ({ id, text: `Memory ${id}.`, time: null, from: null, at: '2026-11-09T10:00:00Z', updated: null, by: 'nova', state: 'unreviewed', device: null, root: id, ...extra });
const o = {
  titles: { s1: 'The kitchen shelf' },
  devices: { 'phone-1': 'Kitchen phone', 'laptop-1': 'Work laptop' },
  captured: { cap2: { count: 2, devices: ['laptop-1'] }, cap1: { count: 1, devices: [] }, capgone: { count: 0, devices: [] }, capboth: { count: 3, devices: ['laptop-1', 'phone-1'] } },
};

test('every origin form says something true, and only a matched conversation says "from" one', () => {
  const rows = [
    ['conversation', entry('c', { from: 's1/k1' }), 'conversation', /^from <a class="memory-from" href="\/c\/s1#t-k1">“The kitchen shelf”<\/a>$/],
    ['conversation with no title', entry('g', { from: 's9/k2' }), 'unknown', NO_SOURCE],
    ['captured on one device', entry('cap2', { from: 'capture:e1,e2' }), 'capture', 'from 2 captured items on “Work laptop”'],
    ['captured on two devices', entry('capboth', { from: 'capture:e1,e2,e3' }), 'capture', 'from 3 captured items on “Work laptop” and “Kitchen phone”'],
    ['captured, device unknown', entry('cap1', { from: 'capture:e1' }), 'capture', 'from 1 captured item'],
    ['captured, rows not readable', entry('capgone', { from: 'capture:e1' }), 'capture', 'from captured items'],
    ['a device note kept', entry('d', { from: 'device:phone-1' }), 'device', 'sent by your device “Kitchen phone”'],
    ['a device note written by the device', entry('d2', { device: 'laptop-1' }), 'device', 'sent by your device “Work laptop”'],
    ['a device no longer paired', entry('d3', { from: 'device:old-9' }), 'device', 'sent by a device that is no longer paired'],
    ['an import', entry('i', { from: 'imported from notes/garden.md' }), 'import', 'imported from notes/garden.md'],
    ['typed by hand', entry('h', { by: 'hand', state: 'confirmed' }), 'hand', 'written into MEMORY.md by hand'],
    ['Nova, no source at all', entry('n'), 'unknown', NO_SOURCE],
    ['an edit of the person with no source', entry('y', { by: 'you', state: 'confirmed' }), 'none', ''],
    ['something else in the source', entry('x', { from: 'correction?' }), 'unknown', NO_SOURCE],
  ];
  for (const [why, e, kind, words] of rows) {
    const got = memoryOrigin(e, o);
    assert.equal(got.kind, kind, why);
    if (words instanceof RegExp) assert.match(got.words, words, why); else assert.equal(got.words, words, why);
    if (kind !== 'conversation') assert.doesNotMatch(got.words, /conversation/, `${why}: never "from a conversation"`);
  }
});

test('a device name is escaped and cut, never markup', () => {
  const got = memoryOrigin(entry('d', { from: 'device:evil' }), { devices: { evil: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(got.words, /<img/);
  assert.match(got.words, /&lt;img/);
});

test('"Not yet checked": only on a memory Nova wrote that the person has not confirmed', () => {
  assert.equal(unchecked(entry('a')), true);
  assert.equal(unchecked(entry('a', { state: 'confirmed' })), false);
  assert.equal(unchecked(entry('a', { by: 'hand', state: 'unreviewed' })), false, 'the person’s own words are theirs');
  assert.equal(unchecked(entry('a', { by: 'you', state: 'unreviewed' })), false);
  assert.equal(unchecked({ id: 'n1', text: 'a day note', by: 'nova' }), false, 'a day note has no review state');
  const html = renderMemory({ sections: [{ title: 'Facts', entries: [entry('u', { from: 's1/k1' }), entry('ok', { from: 's1/k1', state: 'confirmed' })] }], days: [], titles: o.titles }, NOW);
  const row = (id) => new RegExp(`id="m-${id}"[\\s\\S]*?</li>`).exec(html)[0];
  assert.match(row('u'), /<span class="memory-unchecked">Not yet checked<\/span>/);
  assert.match(row('u'), /data-action="confirm-memory" aria-label="Confirm this is right">Confirm</);
  assert.doesNotMatch(row('ok'), /Not yet checked|confirm-memory/);
  // Quiet: no count of unchecked memories anywhere on the page (owner ruling on F-034).
  assert.doesNotMatch(html, /\d+ (?:not yet checked|unchecked|to check)/i);
});

test('originsOf: device names from the registry, capture from its promotion rows, by the chain’s first row', () => {
  const read = {
    sections: [{ title: 'Facts', entries: [
      entry('m1', { from: 'device:phone-1' }),
      entry('m2', { from: 'capture:e1,e2', root: 'm0' }),
      entry('m3', { device: 'gone-1' }),
      entry('m4', { from: 's1/k1' }),
    ] }],
    days: [{ day: '2026-11-09', entries: [{ id: 'n1', text: 'x', from: 'device:laptop-1', by: 'nova' }] }],
  };
  const asked = [];
  const got = originsOf(read, {
    deviceName: (id) => ({ 'phone-1': 'Kitchen phone', 'laptop-1': 'Work laptop' }[id] ?? null),
    promotions: (m) => { asked.push(m); return m === 'm0' ? [{ device_id: 'laptop-1' }, { device_id: 'laptop-1' }, { device_id: null }] : []; },
  });
  assert.deepEqual(asked, ['m0'], 'capture rows are read for the memory the promotion named: the first of its chain');
  assert.deepEqual(got.captured, { m2: { count: 3, devices: ['laptop-1'] } });
  assert.deepEqual(got.devices, { 'phone-1': 'Kitchen phone', 'laptop-1': 'Work laptop' }, 'a device no longer on the registry has no name');
});

test('originsOf: a store that throws leaves the row honest, not broken', () => {
  const got = originsOf({ sections: [{ title: 'Facts', entries: [entry('m', { from: 'capture:e1' })] }], days: [] }, { deviceName: () => null, promotions: () => { throw new Error('gone'); } });
  assert.deepEqual(got.captured, { m: { count: 0, devices: [] } });
  assert.equal(memoryOrigin(entry('m', { from: 'capture:e1' }), got).words, 'from captured items');
});
