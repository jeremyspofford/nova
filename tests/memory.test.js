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

import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { Memory } from '../src/memory.js';
import { createCore } from '../src/core/index.ts';

const now = new Date('2026-10-21T16:42:00Z');
// MEMORY.md is a view of the core's memory records, so each test gets a core of its own.
const fresh = ({ file = true } = {}) => {
  const h = mkdtempSync(join(tmpdir(), 'nova-mm-'));
  if (file) copyFileSync(new URL('../templates/home/MEMORY.md', import.meta.url).pathname, join(h, 'MEMORY.md'));
  const core = createCore({ home: h, version: 'test', trustedOrigin: () => true, now: () => now });
  return { h, core, records: core.memory, m: new Memory(h, 'America/New_York', { records: core.memory }) };
};
const minute = (n) => new Date(now.getTime() + n * 60_000);

test('remember files each kind under its heading, with an id and where it came from', () => {
  const { h, m } = fresh();
  const a = m.remember({ kind: 'preference', text: 'Takes coffee  black.\n', from: 's/t1' }, now);
  m.remember({ kind: 'commitment', text: 'Call mom on Sunday.', from: 's/t1' }, now);
  const file = readFileSync(join(h, 'MEMORY.md'), 'utf8');
  assert.match(file, new RegExp(`## Preferences\\n\\n- Takes coffee black\\. <!-- id=${a.id} from=s/t1 at=2026-10-21T16:42:00.000Z -->\\n\\n## Decisions`));
  assert.match(file, /## Commitments\n\n- Call mom on Sunday\./);
  const { sections } = m.read();
  assert.deepEqual(sections.map((s) => s.entries.length), [0, 1, 0, 1]);
  assert.equal(m.remember({ kind: 'fact', text: 'takes coffee black.' }, now).existing, true, 'no duplicates');
});

test('a correction replaces the superseded entry instead of adding a second one', () => {
  const { h, m, records } = fresh();
  const a = m.remember({ kind: 'fact', text: 'Lives in Lisbon.', from: 's/t1' }, now);
  const b = m.remember({ text: 'Lives in Porto; moved from Lisbon in October 2026.', replaces: a.id, from: 's/t2' }, now);
  // The core keeps history: the correction is a new record that supersedes the old one.
  assert.notEqual(b.id, a.id);
  assert.equal(records.get(b.id).supersedes, a.id);
  assert.equal(records.get(b.id).source, 's/t2');
  assert.equal(b.replaced, true);
  const file = readFileSync(join(h, 'MEMORY.md'), 'utf8');
  assert.doesNotMatch(file, /Lives in Lisbon\./);
  assert.equal(m.read().sections[0].entries.length, 1);
  assert.match(m.read().sections[0].entries[0].updated, /2026-10-21/);
});

test('notes go to the dated file in the person\'s timezone', () => {
  const { h, m } = fresh();
  const n = m.note({ text: 'Bought a new kettle.', from: 's/t1' }, new Date('2026-10-22T02:00:00Z'));
  assert.equal(n.day, '2026-10-21'); // still the 21st in New York
  assert.match(readFileSync(join(h, 'memory', '2026-10-21.md'), 'utf8'), /^# Wednesday, 21 October 2026\n\n- 22:00 · Bought a new kettle\. <!-- id=n/);
  assert.equal(m.search('kettle')[0].id, n.id);
});

test('forgetting a memory forgets the day notes that say the same thing, and undo restores both in place', () => {
  const { h, m } = fresh();
  // Entries are listed oldest first, so each is noted a minute apart.
  m.remember({ kind: 'fact', text: 'Has a dog named Biscuit.', from: 's/t0' }, minute(0));
  const a = m.remember({ kind: 'fact', text: 'Allergic to penicillin; carries an EpiPen.', from: 's/t1' }, minute(1));
  m.remember({ kind: 'fact', text: 'Works from home on Fridays.', from: 's/t2' }, minute(2));
  m.note({ text: 'Mentioned the penicillin allergy at the pharmacy.', from: 's/t1' }, now);
  m.note({ text: 'Walked Biscuit by the river.', from: 's/t3' }, now);
  const removed = m.forget(a.id);
  assert.equal(removed.length, 2);
  const all = `${readFileSync(join(h, 'MEMORY.md'), 'utf8')}${readFileSync(join(h, 'memory', '2026-10-21.md'), 'utf8')}`;
  assert.doesNotMatch(all, /penicillin/i);
  assert.match(all, /Biscuit by the river/);
  assert.deepEqual(m.search('penicillin allergy'), []);
  m.restore(removed);
  const facts = m.read().sections[0].entries;
  assert.deepEqual(facts.map((e) => e.text), ['Has a dog named Biscuit.', 'Allergic to penicillin; carries an EpiPen.', 'Works from home on Fridays.']);
  // Forgetting deleted the record for real, so undo re-creates it: same words, source and time, new id.
  assert.notEqual(facts[1].id, a.id);
  assert.equal(facts[1].from, 's/t1');
  assert.equal(facts[1].at, minute(1).toISOString());
  assert.equal(m.read().days[0].entries.length, 2);
  m.restore(removed);
  assert.equal(m.read().sections[0].entries.length, 3, 'undoing twice doesn’t make a copy');
});

test('entries written by hand can be read, edited and forgotten', () => {
  const { h, m } = fresh();
  writeFileSync(join(h, 'MEMORY.md'), '# MEMORY.md\n\n## Facts\n\n- Grew up in Ohio.\n- Two kids,\n  Maverick and June.\n');
  const [ohio, kids] = m.read().sections[0].entries;
  assert.equal(kids.text, 'Two kids, Maverick and June.');
  assert.equal(kids.by, 'hand');
  assert.match(m.forContext(readFileSync(join(h, 'MEMORY.md'), 'utf8')), new RegExp(`- Grew up in Ohio\\. \\[id:${ohio.id}\\]`));
  const edited = m.edit(ohio.id, 'Grew up in Columbus, Ohio.', now);
  assert.equal(edited.by, 'you');
  assert.notEqual(edited.id, ohio.id, 'an edit is a correction: a new record that supersedes the old');
  assert.equal(m.forget(kids.id).length, 1);
  // The file is re-rendered from the core, with every Era 2 heading.
  assert.equal(readFileSync(join(h, 'MEMORY.md'), 'utf8'), `# MEMORY.md\n\n## Facts\n\n- Grew up in Columbus, Ohio. <!-- id=${edited.id} at=2026-10-21T16:42:00.000Z by=you updated=2026-10-21T16:42:00.000Z -->\n\n## Preferences\n\n## Decisions\n\n## Commitments\n`);
});

// ---- one memory: the core is the source of truth, MEMORY.md a view of it ----

const ERA2 = `# MEMORY.md

<!-- A note to self at the top. -->

## Facts

- Has a sample bicycle. <!-- id=m0000aaa1 from=s1/t1 at=2026-09-01T10:00:00.000Z -->
- Written here by hand.

## Preferences

- Likes quiet mornings. <!-- id=m0000aaa2 from=s1/t2 at=2026-09-02T10:00:00.000Z by=you updated=2026-09-03T10:00:00.000Z -->

## Commitments

- Return the sample book on Friday. <!-- id=m0000aaa3 from=s2/t1 at=2026-09-04T10:00:00.000Z -->

## Odds and ends

- A bullet under a heading of the person's own.
`;

test('at start, MEMORY.md entries are imported once, keeping their ids, sources, times and kinds', () => {
  const { h, m, records, core } = fresh({ file: false });
  writeFileSync(join(h, 'MEMORY.md'), ERA2);
  const imported = m.sync();
  assert.equal(imported.imported, 5);
  const bike = records.get('m0000aaa1');
  assert.deepEqual([bike.kind, bike.content, bike.source, bike.observed_at, bike.recorded_by], ['fact', 'Has a sample bicycle.', 's1/t1', '2026-09-01T10:00:00.000Z', 'nova']);
  assert.equal(records.get('m0000aaa3').kind, 'commitment');
  assert.equal(records.get('m0000aaa2').recorded_by, 'person', 'an entry the person edited is theirs');
  const hand = records.active().find((r) => r.content === 'Written here by hand.');
  assert.match(hand.id, /^h[0-9a-f]{8}$/, 'a hand-written entry keeps the id Era 2 gave it');
  assert.equal(hand.recorded_by, 'person');
  assert.equal(hand.user_state, 'confirmed');
  assert.equal(records.active().find((r) => r.content.startsWith('A bullet under')).kind, 'fact', 'a heading of the person\'s own is read as facts');

  // The file is now rendered from the core: same headings and format, the preamble kept.
  const file = readFileSync(join(h, 'MEMORY.md'), 'utf8');
  assert.match(file, /^# MEMORY\.md\n\n<!-- A note to self at the top\. -->\n\n## Facts\n\n- Has a sample bicycle\. <!-- id=m0000aaa1 from=s1\/t1 at=2026-09-01T10:00:00\.000Z -->\n/);
  assert.match(file, new RegExp(`- Written here by hand\\. <!-- id=${hand.id} at=\\S+ by=you -->`));
  assert.match(file, /## Commitments\n\n- Return the sample book on Friday\. <!-- id=m0000aaa3/);
  assert.doesNotMatch(file, /Odds and ends/);

  // Importing again, or after the record of the last render is lost, adds nothing.
  assert.equal(new Memory(h, 'UTC', { records: core.memory }).sync().imported, 0);
  rmSync(join(h, 'memory', '.rendered.json'));
  assert.equal(new Memory(h, 'UTC', { records: core.memory }).sync().imported, 0);
  assert.equal(records.list().length, 5);
});

test('every change goes to the core, and MEMORY.md is rendered from it', () => {
  const { h, m, records } = fresh();
  const a = m.remember({ kind: 'decision', text: 'Use the sample tent this year.', from: 's/t1' }, now);
  assert.equal(records.get(a.id).recorded_by, 'nova');
  assert.equal(records.get(a.id).user_state, 'unreviewed');
  // A change made through the core directly shows up in the file at the next sync.
  const b = records.remember({ kind: 'preference', content: 'Prefers window seats.', recorded_by: 'person' });
  m.sync();
  assert.match(readFileSync(join(h, 'MEMORY.md'), 'utf8'), new RegExp(`## Preferences\\n\\n- Prefers window seats\\. <!-- id=${b.id} at=\\S+ by=you -->`));
  m.forget(a.id);
  assert.throws(() => records.get(a.id), /no memory/);
  assert.doesNotMatch(readFileSync(join(h, 'MEMORY.md'), 'utf8'), /sample tent/);
  // The model's corrections and forgets can use either kind of id.
  assert.equal(m.remember({ text: 'Prefers aisle seats.', replaces: b.id, from: 's/t2' }, now).replaced, true);
  assert.match(readFileSync(join(h, 'MEMORY.md'), 'utf8'), /- Prefers aisle seats\. <!-- id=\S+ from=s\/t2 at=/);
});

test('records the Era 2 file had no place for are shown truthfully', () => {
  const { h, m, records } = fresh();
  records.remember({ kind: 'fact', content: 'Might like sample jazz.', recorded_by: 'nova', confidence: 0.3 });
  records.remember({ kind: 'entity', content: 'Sample Neighbor lives next door.', recorded_by: 'person' });
  records.remember({ kind: 'timeline', content: 'Went to a sample fair.', recorded_by: 'nova' });
  const { sections } = m.read();
  assert.deepEqual(sections.map((s) => s.title), ['Facts', 'Preferences', 'Decisions', 'Commitments', 'People, places and things']);
  const file = readFileSync(join(h, 'MEMORY.md'), 'utf8');
  assert.match(m.forContext(file), /- Might like sample jazz\. \[id:\S+; low confidence\]/, 'not presented as fact');
  assert.match(file, /## People, places and things\n\n- Sample Neighbor lives next door\./);
  assert.doesNotMatch(file, /sample fair/, 'timeline records are day notes, not MEMORY.md');
  m.sync();
  assert.equal(records.list().length, 3, 'rendering them is not mistaken for a hand edit');
});

const handEdit = (h, change) => writeFileSync(join(h, 'MEMORY.md'), change(readFileSync(join(h, 'MEMORY.md'), 'utf8')));

test('a hand edit to an entry\'s words is a correction by the person', () => {
  const { h, m, records } = fresh();
  const a = m.remember({ kind: 'fact', text: 'Has one sample cat.', from: 's/t1' }, now);
  handEdit(h, (t) => t.replace('Has one sample cat.', 'Has two sample cats.'));
  m.sync();
  const now2 = records.active().find((r) => r.content === 'Has two sample cats.');
  assert.equal(now2.supersedes, a.id);
  assert.equal(now2.recorded_by, 'person');
  assert.equal(records.get(a.id).user_state, 'corrected', 'history is kept');
  assert.match(readFileSync(join(h, 'MEMORY.md'), 'utf8'), new RegExp(`- Has two sample cats\\. <!-- id=${now2.id} from=s/t1 at=\\S+ by=you updated=`));
});

test('a bullet added by hand is remembered as the person\'s, confirmed', () => {
  const { h, m, records } = fresh();
  m.remember({ kind: 'fact', text: 'Has one sample cat.', from: 's/t1' }, now);
  handEdit(h, (t) => t.replace('## Commitments\n', '## Commitments\n\n- Water the sample plants on Sundays.\n'));
  const entries = m.read().sections.find((s) => s.title === 'Commitments').entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].by, 'hand');
  const r = records.get(entries[0].id);
  assert.deepEqual([r.kind, r.recorded_by, r.user_state], ['commitment', 'person', 'confirmed']);
  assert.match(readFileSync(join(h, 'MEMORY.md'), 'utf8'), new RegExp(`- Water the sample plants on Sundays\\. <!-- id=${r.id} `), 'the new bullet gets its id');
  assert.equal(records.active().length, 2);
});

test('a bullet removed by hand is forgotten', () => {
  const { h, m, records } = fresh();
  const a = m.remember({ kind: 'fact', text: 'Has one sample cat.', from: 's/t1' }, minute(0));
  const b = m.remember({ kind: 'fact', text: 'Keeps a sample diary.', from: 's/t2' }, minute(1));
  handEdit(h, (t) => t.replace(/- Has one sample cat\..*\n/, ''));
  m.sync();
  assert.throws(() => records.get(a.id), /no memory/);
  assert.deepEqual(records.events(a.id).map((e) => [e.kind, e.by]).at(-1), ['forgotten', 'person']);
  assert.equal(records.get(b.id).content, 'Keeps a sample diary.');
});

test('a hand edit is noticed before the next change, so the change doesn\'t overwrite it', () => {
  const { h, m, records } = fresh();
  m.remember({ kind: 'fact', text: 'Has one sample cat.', from: 's/t1' }, now);
  handEdit(h, (t) => t.replace('## Decisions\n', '## Decisions\n\n- Moving to a sample town.\n'));
  m.remember({ kind: 'fact', text: 'Likes long walks.', from: 's/t2' }, now);
  const file = readFileSync(join(h, 'MEMORY.md'), 'utf8');
  assert.match(file, /Moving to a sample town\./);
  assert.match(file, /Likes long walks\./);
  assert.equal(records.active().length, 3);
});

test('a change made without a hand edit is not mistaken for one', () => {
  const { h, m, records } = fresh();
  const a = m.remember({ kind: 'fact', text: 'Has one sample cat.', from: 's/t1' }, now);
  // Forgotten through the core directly: the file still shows it until the next sync, which
  // must not bring it back.
  records.forget(a.id);
  m.sync();
  assert.doesNotMatch(readFileSync(join(h, 'MEMORY.md'), 'utf8'), /sample cat/);
  assert.equal(records.list().length, 0);
});

import { execFileSync } from 'node:child_process';
import { ensureGit, commitHome } from '../src/home.js';

test('memory, skills and secrets stay out of the home folder\'s git history', async () => {
  const { h, m } = fresh();
  mkdirSync(join(h, 'memory'), { recursive: true });
  writeFileSync(join(h, 'memory', 'README.md'), '# memory/\n');
  writeFileSync(join(h, 'USER.md'), '# USER.md\n');
  assert.equal(await ensureGit(h), true);
  mkdirSync(join(h, 'skills', 'shopping'), { recursive: true });
  writeFileSync(join(h, 'skills', 'shopping', 'SKILL.md'), '# Shopping\n');
  mkdirSync(join(h, 'connectors', 'gmail'), { recursive: true });
  writeFileSync(join(h, 'connectors', 'gmail', 'token.json'), '{"refresh_token":"secret-token"}');
  m.remember({ kind: 'fact', text: 'Allergic to penicillin.', from: 's/t1' }, now);
  m.note({ text: 'Mentioned the penicillin allergy.', from: 's/t1' }, now);
  await commitHome(h, 'Nova: turn');
  const tracked = execFileSync('git', ['-C', h, 'ls-files'], { encoding: 'utf8' });
  assert.match(tracked, /USER\.md/);
  assert.match(tracked, /memory\/README\.md/);
  assert.doesNotMatch(tracked, /MEMORY\.md|2026-10-21|\.rendered\.json|skills\/|connectors\//);
  const everything = execFileSync('git', ['-C', h, 'log', '--all', '-p'], { encoding: 'utf8' });
  assert.doesNotMatch(everything, /penicillin|secret-token|# Shopping/);
});

test('an older home that tracked memory stops tracking it', async () => {
  const { h } = fresh();
  execFileSync('git', ['-C', h, 'init', '-q']);
  execFileSync('git', ['-C', h, 'add', '-A']);
  execFileSync('git', ['-C', h, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old']);
  await ensureGit(h);
  assert.doesNotMatch(execFileSync('git', ['-C', h, 'ls-files'], { encoding: 'utf8' }), /MEMORY\.md/);
  assert.match(readFileSync(join(h, '.gitignore'), 'utf8'), /^MEMORY\.md$/m);
  assert.ok(existsSync(join(h, 'MEMORY.md')), 'the file itself stays');
});
