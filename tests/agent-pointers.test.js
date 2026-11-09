// Root CLAUDE.md and AGENTS.md are generated pointers into the builder packet (scripts/agent-pointers.js,
// owner queue A3). They fail when they drift from the generator, point at a file that isn't there, or
// start carrying the packet's content instead of pointing at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, TARGETS, copiedContent, generate, packetWindows } from '../scripts/agent-pointers.js';

const SCRIPT = join(ROOT, 'scripts', 'agent-pointers.js');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

test('the committed CLAUDE.md and AGENTS.md are what the generator makes (--check passes)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of TARGETS) assert.equal(read(f), generate(), `${f}: run node scripts/agent-pointers.js`);
});

test('every link in them points at a file that exists', () => {
  for (const f of TARGETS) {
    const links = [...read(f).matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(links.length > 0, `${f} has links`);
    for (const link of links) assert.ok(existsSync(join(ROOT, link.split('#')[0])), `${f}: ${link} exists`);
  }
});

test('they point at the packet rather than copying it: no long lines, no three packet lines in a row', () => {
  const windows = packetWindows();
  assert.ok(windows.size > 0, 'the packet was read');
  for (const f of TARGETS) assert.deepEqual(copiedContent(read(f), windows), [], f);
});

test('the copy check catches three packet lines copied verbatim, and lets two through', () => {
  const windows = packetWindows();
  // Three consecutive non-empty lines from a real packet file, as they stand in it.
  const raw = read('docs/builder-packet/OPERATING-RULES.md').split('\n');
  const ok = (l) => l.trim() && l.length <= 200;
  const i = raw.findIndex((_, j) => j + 3 <= raw.length && raw.slice(j, j + 3).every(ok));
  assert.ok(i >= 0, 'OPERATING-RULES.md has three short non-empty lines in a row');
  const copied = raw.slice(i, i + 3);
  const body = (extra) => `${generate()}\n${extra.join('\n')}\n`;

  const three = copiedContent(body(copied), windows);
  assert.equal(three.length, 1, three.join('\n---\n'));
  assert.match(three[0], /^copies three packet lines verbatim:\n/);
  assert.ok(three[0].endsWith(copied.map((l) => l.trim()).join('\n')), three[0]);

  assert.deepEqual(copiedContent(body(copied.slice(0, 2)), windows), []);

  // The other two limits fail too.
  assert.match(copiedContent(`${generate()}\n${'x'.repeat(201)}\n`, windows).join(), /a line of 201 chars/);
  assert.match(copiedContent('- a pointer\n'.repeat(41), windows).join(), /42 lines/);
});
