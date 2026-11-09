// Root CLAUDE.md and AGENTS.md are generated pointers into the builder packet (scripts/agent-pointers.js,
// owner queue A3). They fail when they drift from the generator, point at a file that isn't there, or
// start carrying the packet's content instead of pointing at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, TARGETS, generate } from '../scripts/agent-pointers.js';

const SCRIPT = join(ROOT, 'scripts', 'agent-pointers.js');
const PACKET = join(ROOT, 'docs', 'builder-packet');
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
  const windows = new Set();
  for (const name of readdirSync(PACKET, { recursive: true })) {
    if (!String(name).endsWith('.md')) continue;
    const lines = readFileSync(join(PACKET, String(name)), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i + 3 <= lines.length; i++) windows.add(lines.slice(i, i + 3).join('\n'));
  }
  assert.ok(windows.size > 0, 'the packet was read');
  for (const f of TARGETS) {
    const all = read(f).split('\n');
    for (const l of all) assert.ok(l.length <= 200, `${f}: a line of ${l.length} chars: ${l.slice(0, 60)}…`);
    assert.ok(all.length <= 40, `${f}: ${all.length} lines; it should stay a short list of pointers`);
    const lines = all.map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i + 3 <= lines.length; i++) {
      const w = lines.slice(i, i + 3).join('\n');
      assert.ok(!windows.has(w), `${f}: copies three packet lines verbatim:\n${w}`);
    }
  }
});
