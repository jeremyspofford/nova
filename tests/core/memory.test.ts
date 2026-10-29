import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Memory, terms } from '../../src/core/memory.ts';
import { sha256 } from '../../src/core/workspace.ts';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'nova-memory-'));
  const db = new Db(':memory:');
  db.migrate();
  let clock = new Date('2026-10-01T09:00:00Z');
  const memory = new Memory({ db, home, now: () => clock });
  const tick = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { db, home, memory, tick };
}

// Every row of every table, as text, so a test can prove a string is nowhere in the database.
function everything(db: Db): string {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  return tables.map((t) => JSON.stringify(db.all(`SELECT * FROM "${t.name}"`))).join('\n');
}

test('every record carries its provenance; Nova’s are unreviewed and the person’s confirmed', () => {
  const { memory } = setup();
  const a = memory.remember({ kind: 'preference', content: 'Takes tea without sugar.', source: 'session:s1', recorded_by: 'nova', confidence: 0.8 });
  const b = memory.remember({ kind: 'fact', content: 'The spare key is in the blue drawer.', recorded_by: 'person', observed_at: '2026-09-30T12:00:00Z' });
  assert.equal(a.user_state, 'unreviewed');
  assert.equal(a.source, 'session:s1');
  assert.equal(a.recorded_by, 'nova');
  assert.equal(a.observed_at, '2026-10-01T09:00:00.000Z');
  assert.equal(a.confidence, 0.8);
  assert.equal(a.scope, 'personal');
  assert.equal(a.created_at, '2026-10-01T09:00:00.000Z');
  assert.equal(b.user_state, 'confirmed');
  assert.equal(b.observed_at, '2026-09-30T12:00:00.000Z');
  assert.equal(b.confidence, null);
  assert.deepEqual(memory.get(a.id), a);
  assert.deepEqual(memory.events(a.id).map((e) => [e.kind, e.by]), [['remembered', 'nova']]);
});

test('bad input is refused in plain words', () => {
  const { memory } = setup();
  const ok = { kind: 'fact', content: 'x', recorded_by: 'person' } as const;
  assert.throws(() => memory.remember({ ...ok, kind: 'rumour' as 'fact' }), /kind must be one of timeline, entity, fact, preference, decision, commitment/);
  assert.throws(() => memory.remember({ ...ok, content: '  ' }), /needs something to remember/);
  assert.throws(() => memory.remember({ ...ok, confidence: 1.5 }), /confidence must be a number from 0 to 1/);
  assert.throws(() => memory.remember({ ...ok, scope: 'Not A Scope!' }), /scope must be/);
  assert.throws(() => memory.remember({ ...ok, recorded_by: '' }), /who recorded it/);
  assert.throws(() => memory.remember({ ...ok, expires: 'someday' }), /expires must be a date/);
  assert.throws(() => memory.correct('nope', 'y', 'person'), /no memory with id "nope"/);
});

test('a correction supersedes the old record, which stays readable: history is not rewritten', () => {
  const { memory } = setup();
  const first = memory.remember({ kind: 'fact', content: 'The meeting room is on floor two.', recorded_by: 'nova', confidence: 0.6, scope: 'work' });
  const second = memory.correct(first.id, 'The meeting room is on floor three.', 'person');
  assert.equal(second.supersedes, first.id);
  assert.equal(second.user_state, 'confirmed');
  assert.equal(second.recorded_by, 'person');
  assert.equal(second.kind, 'fact');
  assert.equal(second.scope, 'work');
  const old = memory.get(first.id);
  assert.equal(old.content, 'The meeting room is on floor two.');
  assert.equal(old.superseded_by, second.id);
  assert.equal(old.user_state, 'corrected');
  const third = memory.correct(second.id, 'The meeting room is on floor four.', 'nova');
  assert.equal(third.user_state, 'unreviewed');
  assert.deepEqual(memory.history(third.id).map((r) => r.id), [first.id, second.id, third.id]);
  assert.deepEqual(memory.active().map((r) => r.id), [third.id], 'only the newest is active');
  assert.throws(() => memory.correct(first.id, 'again', 'person'), /already been corrected/);
  assert.equal(memory.list({ state: 'corrected' }).length, 2);
});

test('confirm marks a record confirmed', () => {
  const { memory } = setup();
  const a = memory.remember({ kind: 'decision', content: 'Use the small tent this year.', recorded_by: 'nova' });
  assert.equal(memory.confirm(a.id).user_state, 'confirmed');
  assert.deepEqual(memory.events(a.id).map((e) => e.kind), ['remembered', 'confirmed']);
});

test('forget deletes the record and its whole chain, leaving an audit trail with no content', () => {
  const { db, memory } = setup();
  const keep = memory.remember({ kind: 'fact', content: 'Unrelated thing to keep.', recorded_by: 'person' });
  const a = memory.remember({ kind: 'entity', content: 'Example Person lives at 12 Sample Street.', recorded_by: 'nova' });
  const b = memory.correct(a.id, 'Example Person lives at 14 Sample Street.', 'person');
  const c = memory.correct(b.id, 'Example Person moved away from Sample Street.', 'person');
  const gone = memory.forget(b.id, 'person');
  assert.deepEqual(gone.forgotten.sort(), [a.id, b.id, c.id].sort());
  for (const id of [a.id, b.id, c.id]) assert.throws(() => memory.get(id), /no memory/);
  assert.equal(memory.get(keep.id).content, 'Unrelated thing to keep.');
  const all = everything(db);
  assert.ok(!all.includes('Sample Street'), 'no trace of the content anywhere in the database');
  assert.ok(all.includes('Unrelated thing to keep.'), 'the check can see content when it is there');
  assert.deepEqual(memory.events(a.id).map((e) => e.kind), ['remembered', 'corrected', 'forgotten']);
  assert.throws(() => memory.forget(a.id, 'person'), /no memory/);
});

test('expired records drop out of what is active', () => {
  const { memory, tick } = setup();
  const brief = memory.remember({ kind: 'commitment', content: 'Call back about the parcel.', recorded_by: 'person', expires: '2026-10-02T00:00:00Z' });
  const lasting = memory.remember({ kind: 'commitment', content: 'Water the plants on Sundays.', recorded_by: 'person' });
  assert.deepEqual(memory.active().map((r) => r.id).sort(), [brief.id, lasting.id].sort());
  tick(24 * 3600_000);
  assert.deepEqual(memory.active().map((r) => r.id), [lasting.id]);
  assert.equal(memory.list().find((r) => r.id === brief.id)?.active, false, 'still listed for inspection, marked inactive');
});

test('nothing below confidence 0.5 is presented as fact', () => {
  const { memory } = setup();
  memory.remember({ kind: 'preference', content: 'Might prefer mornings.', recorded_by: 'nova', confidence: 0.3 });
  memory.remember({ kind: 'preference', content: 'Prefers quiet places.', recorded_by: 'nova', confidence: 0.5 });
  memory.remember({ kind: 'preference', content: 'Likes walking.', recorded_by: 'person' });
  const byContent = Object.fromEntries(memory.active().map((r) => [r.content, r.low_confidence]));
  assert.deepEqual(byContent, { 'Might prefer mornings.': true, 'Prefers quiet places.': false, 'Likes walking.': false });
});

test('list filters by kind, scope and state', () => {
  const { memory } = setup();
  memory.remember({ kind: 'fact', content: 'One.', recorded_by: 'person', scope: 'work' });
  memory.remember({ kind: 'fact', content: 'Two.', recorded_by: 'nova' });
  memory.remember({ kind: 'decision', content: 'Three.', recorded_by: 'nova' });
  assert.equal(memory.list({ kind: 'fact' }).length, 2);
  assert.equal(memory.list({ scope: 'work' }).length, 1);
  assert.equal(memory.list({ state: 'unreviewed' }).length, 2);
  assert.throws(() => memory.list({ state: 'maybe' as 'confirmed' }), /state must be one of/);
  assert.deepEqual(memory.counts(), { active: 3, unreviewed: 2, low_confidence: 0 });
});

test('search finds active records by shared words and returns what it retrieved, for receipts', () => {
  const { memory, tick } = setup();
  const bike = memory.remember({ kind: 'fact', content: 'The bike lock code is written in the garage notebook.', recorded_by: 'person' });
  tick(1000);
  memory.remember({ kind: 'fact', content: 'The garage door sticks in winter.', recorded_by: 'person' });
  memory.remember({ kind: 'fact', content: 'Bike tyres were replaced in spring.', recorded_by: 'person', scope: 'errands' });
  const old = memory.remember({ kind: 'fact', content: 'The bike lock code is 1234 notebook.', recorded_by: 'nova' });
  memory.correct(old.id, 'Changed; see the drawer.', 'person');
  assert.deepEqual(terms("What's the bike's lock code?"), ['bike', 'lock', 'code']);
  const r = memory.search('where is the bike lock code notebook', { scope: 'personal' });
  assert.deepEqual(r.records.map((x) => x.id), [bike.id], 'superseded and other-scope records are not found');
  assert.deepEqual(r.retrieved, [{ kind: 'memory', ref: bike.id, sha256: sha256(bike.content) }]);
  assert.equal(memory.search('garage', { limit: 1 }).records.length, 1);
  assert.equal(memory.search('garage').records.length, 2);
  assert.deepEqual(memory.search('the and of').records, []);
});

test('export writes plain files with exactly the active records', () => {
  const { home, memory, tick } = setup();
  const a = memory.remember({ kind: 'fact', content: 'Fact one.', recorded_by: 'person', source: 'session:s1' });
  const b = memory.remember({ kind: 'preference', content: 'Unsure about spicy food.', recorded_by: 'nova', confidence: 0.2 });
  const c = memory.correct(a.id, 'Fact one, corrected.', 'person');
  memory.remember({ kind: 'decision', content: 'Short-lived.', recorded_by: 'person', expires: '2026-10-01T10:00:00Z' });
  tick(2 * 3600_000);
  const out = memory.export();
  assert.equal(out.json, join(home, 'exports', 'memory-2026-10-01T11-00-00-000Z', 'memory.json'));
  assert.ok(existsSync(out.json) && existsSync(out.markdown));
  const doc = JSON.parse(readFileSync(out.json, 'utf8'));
  assert.equal(doc.exported_at, '2026-10-01T11:00:00.000Z');
  assert.deepEqual(doc.records.map((r: { id: string }) => r.id).sort(), [b.id, c.id].sort());
  const rc = doc.records.find((r: { id: string }) => r.id === c.id);
  assert.equal(rc.supersedes, a.id);
  for (const k of ['kind', 'content', 'source', 'observed_at', 'recorded_by', 'confidence', 'scope', 'supersedes', 'superseded_by', 'expires', 'user_state', 'created_at']) assert.ok(k in rc, k);
  const md = readFileSync(out.markdown, 'utf8');
  assert.match(md, /^# Memory/);
  assert.match(md, /## Facts\n\n- Fact one, corrected\./);
  assert.match(md, /## Preferences\n\n- Unsure about spicy food\. \(low confidence/);
  assert.ok(!md.includes('Short-lived') && !md.includes('Fact one.'), 'expired and superseded records are left out');
});

test('importing keeps a record’s own id, time and source, and never imports the same id twice', () => {
  const { memory } = setup();
  const r = memory.importRecord({ id: 'm3f9a1c2', kind: 'preference', content: 'Takes coffee black.', source: 's1/t1', observed_at: '2026-09-21T16:42:00Z', recorded_by: 'nova' });
  assert.ok(r.imported && r.record);
  assert.equal(r.record.id, 'm3f9a1c2');
  assert.equal(r.record.observed_at, '2026-09-21T16:42:00.000Z');
  assert.equal(r.record.source, 's1/t1');
  assert.equal(r.record.user_state, 'unreviewed');
  assert.deepEqual(memory.events('m3f9a1c2').map((e) => e.kind), ['remembered']);
  const again = memory.importRecord({ id: 'm3f9a1c2', kind: 'preference', content: 'Takes coffee black.', recorded_by: 'nova' });
  assert.equal(again.imported, false);
  assert.equal(memory.list().length, 1);
  memory.forget('m3f9a1c2');
  assert.equal(memory.importRecord({ id: 'm3f9a1c2', kind: 'preference', content: 'Takes coffee black.', recorded_by: 'nova' }).imported, false, 'what was forgotten stays forgotten');
  assert.equal(memory.list().length, 0);
  assert.throws(() => memory.importRecord({ id: 'no spaces allowed', kind: 'fact', content: 'x', recorded_by: 'nova' }), /id must be/);
  assert.throws(() => memory.importRecord({ id: 'h1', kind: 'mood', content: 'x', recorded_by: 'nova' } as never), /kind must be/);
});

test('a correction can say where it came from', () => {
  const { memory } = setup();
  const a = memory.remember({ kind: 'fact', content: 'Lives in a sample town.', recorded_by: 'nova' });
  assert.equal(memory.correct(a.id, 'Lives in another sample town.', 'nova', { source: 's2/t4' }).source, 's2/t4');
  const b = memory.remember({ kind: 'fact', content: 'Has a bike.', recorded_by: 'nova' });
  assert.equal(memory.correct(b.id, 'Has two bikes.', 'person').source, 'correction', 'unchanged when not given');
});
