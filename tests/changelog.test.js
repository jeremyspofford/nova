// CHANGELOG.md is generated from fragments (scripts/changelog.js, docs/changelog/README.md). It fails
// when a fragment changes without CHANGELOG.md being regenerated (npm run changelog), or a fragment
// breaks the shape, the same way the fit-engine copy fails when fit.ts changes alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIR, TARGET, compareVersions, generate, parseFragment, release, releases } from '../scripts/changelog.js';

test('the committed CHANGELOG.md is what docs/changelog/ makes', () => {
  assert.equal(readFileSync(TARGET, 'utf8'), generate(), 'run: npm run changelog');
});

test('the generator is deterministic: the same fragments make the same file, wherever they are', () => {
  const copy = mkdtempSync(join(tmpdir(), 'nova-changelog-'));
  cpSync(DIR, copy, { recursive: true });
  assert.equal(generate(copy), generate(DIR));
  assert.equal(generate(DIR), generate(DIR));
});

test('the first version is 0.1.0-alpha.1, one opening entry, in Keep a Changelog form', () => {
  const r = releases();
  assert.equal(r.at(-1).version, '0.1.0-alpha.1');
  assert.equal(r.at(-1).fragments.length >= 1, true);
  const text = generate();
  assert.match(text, /^# Changelog\n/);
  assert.match(text, /\n## 0\.1\.0-alpha\.1 - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- /);
  assert.doesNotMatch(text, /(^|[^\w&/])#\d+\b/, 'no bare pull request numbers');
});

test('versions sort by SemVer precedence, newest first, prereleases below their release', () => {
  const v = ['0.1.0-alpha.2', '0.2.0-alpha.1', '0.1.0', '0.1.0-alpha.10', '0.1.0-alpha.1', '0.1.0-beta.1', '1.0.0'];
  assert.deepEqual([...v].sort((a, b) => compareVersions(b, a)), ['1.0.0', '0.2.0-alpha.1', '0.1.0', '0.1.0-beta.1', '0.1.0-alpha.10', '0.1.0-alpha.2', '0.1.0-alpha.1']);
});

test('a fragment keeps the shape: known sections, items only, no pull request numbers', () => {
  assert.deepEqual(parseFragment('### Added\n\n- One thing\n  continued.\n- Another\n\n### Fixed\n- A fix\n'), { Added: ['One thing continued.', 'Another'], Fixed: ['A fix'] });
  assert.throws(() => parseFragment('### Improved\n- x\n'), /isn't a section/);
  assert.throws(() => parseFragment('- x\n'), /starts with a ### section heading/);
  assert.throws(() => parseFragment('### Added\nloose text\n'), /only "- " items/);
  assert.throws(() => parseFragment('### Added\n'), /has no items/);
  assert.throws(() => parseFragment(''), /empty/);
  assert.throws(() => parseFragment('### Added\n- Fixed in #352\n'), /names a pull request/);
  assert.throws(() => parseFragment('### Added\n- See PR 352\n'), /names a pull request/);
});

test('a release moves the waiting fragments into the version, newest first, sections merged in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-changelog-'));
  mkdirSync(join(dir, '0.1.0-alpha.1'));
  writeFileSync(join(dir, 'README.md'), 'not a fragment');
  writeFileSync(join(dir, '0.1.0-alpha.1', '2026-11-01-first.md'), '### Added\n- The first thing.\n');
  writeFileSync(join(dir, '2026-11-07-later.md'), '### Fixed\n- A later fix.\n### Added\n- A later thing.\n');
  writeFileSync(join(dir, '2026-11-08-latest.md'), '### Security\n- A safer thing.\n');
  const before = generate(dir);
  assert.doesNotMatch(before, /later/, 'a waiting fragment is not in a version yet');
  assert.throws(() => release('next', dir), /Not a version/);
  assert.deepEqual(release('0.1.0-alpha.2', dir), ['2026-11-07-later.md', '2026-11-08-latest.md']);
  assert.deepEqual(readdirSync(dir).sort(), ['0.1.0-alpha.1', '0.1.0-alpha.2', 'README.md']);
  const after = generate(dir);
  assert.ok(after.endsWith('\n## 0.1.0-alpha.2 - 2026-11-08\n\n### Added\n\n- A later thing.\n\n### Fixed\n\n- A later fix.\n\n### Security\n\n- A safer thing.\n\n## 0.1.0-alpha.1 - 2026-11-01\n\n### Added\n\n- The first thing.\n'), after);
  assert.throws(() => release('0.1.0-alpha.3', dir), /No fragments are waiting/);
  writeFileSync(join(dir, 'notes.md'), '### Added\n- x\n');
  assert.throws(() => generate(dir), /named <YYYY-MM-DD>-<branch>\.md/);
  assert.ok(existsSync(join(dir, 'notes.md')));
});
