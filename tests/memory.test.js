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

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { Memory } from '../src/memory.js';

const fresh = () => {
  const h = mkdtempSync(join(tmpdir(), 'nova-mm-'));
  copyFileSync(new URL('../templates/home/MEMORY.md', import.meta.url).pathname, join(h, 'MEMORY.md'));
  return { h, m: new Memory(h, 'America/New_York') };
};
const now = new Date('2026-10-21T16:42:00Z');

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
  const { h, m } = fresh();
  const a = m.remember({ kind: 'fact', text: 'Lives in Lisbon.', from: 's/t1' }, now);
  const b = m.remember({ text: 'Lives in Porto; moved from Lisbon in October 2026.', replaces: a.id, from: 's/t2' }, now);
  assert.equal(b.id, a.id);
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
  m.remember({ kind: 'fact', text: 'Has a dog named Biscuit.', from: 's/t0' }, now);
  const a = m.remember({ kind: 'fact', text: 'Allergic to penicillin; carries an EpiPen.', from: 's/t1' }, now);
  m.remember({ kind: 'fact', text: 'Works from home on Fridays.', from: 's/t2' }, now);
  m.note({ text: 'Mentioned the penicillin allergy at the pharmacy.', from: 's/t1' }, now);
  m.note({ text: 'Walked Biscuit by the river.', from: 's/t3' }, now);
  const removed = m.forget(a.id);
  assert.equal(removed.length, 2);
  const all = `${readFileSync(join(h, 'MEMORY.md'), 'utf8')}${readFileSync(join(h, 'memory', '2026-10-21.md'), 'utf8')}`;
  assert.doesNotMatch(all, /penicillin/i);
  assert.match(all, /Biscuit by the river/);
  assert.deepEqual(m.search('penicillin allergy'), []);
  m.restore(removed);
  assert.deepEqual(m.read().sections[0].entries.map((e) => e.text), ['Has a dog named Biscuit.', 'Allergic to penicillin; carries an EpiPen.', 'Works from home on Fridays.']);
  assert.equal(m.read().days[0].entries.length, 2);
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
  assert.equal(m.forget(kids.id).length, 1);
  assert.equal(readFileSync(join(h, 'MEMORY.md'), 'utf8'), `# MEMORY.md\n\n## Facts\n\n- Grew up in Columbus, Ohio. <!-- id=${ohio.id} by=you updated=2026-10-21T16:42:00.000Z -->\n`);
});

import { execFileSync } from 'node:child_process';
import { ensureGit, commitHome } from '../src/home.js';

test('memory stays out of the home folder\'s git history, so forgetting is final', async () => {
  const { h, m } = fresh();
  mkdirSync(join(h, 'memory'), { recursive: true });
  writeFileSync(join(h, 'memory', 'README.md'), '# memory/\n');
  writeFileSync(join(h, 'USER.md'), '# USER.md\n');
  assert.equal(await ensureGit(h), true);
  m.remember({ kind: 'fact', text: 'Allergic to penicillin.', from: 's/t1' }, now);
  m.note({ text: 'Mentioned the penicillin allergy.', from: 's/t1' }, now);
  await commitHome(h, 'Nova: turn');
  const tracked = execFileSync('git', ['-C', h, 'ls-files'], { encoding: 'utf8' });
  assert.match(tracked, /USER\.md/);
  assert.match(tracked, /memory\/README\.md/);
  assert.doesNotMatch(tracked, /MEMORY\.md|2026-10-21/);
  const everything = execFileSync('git', ['-C', h, 'log', '--all', '-p'], { encoding: 'utf8' });
  assert.doesNotMatch(everything, /penicillin/);
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
