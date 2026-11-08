// The in-app changelog (src/core/changelog.ts, GET /api/v1/changelog) is CHANGELOG.md read back with
// the generator's own grammar: the same entries, newest first, never a second copy. A malformed
// block is left out and said, never thrown at the owner's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changelogView, parseChangelog, SECTIONS } from '../../src/core/changelog.ts';
import { ROOT, TARGET, generate, releases } from '../../scripts/changelog.js';

type Fragment = { file: string; sections: Record<string, string[]> };
type GenRelease = { version: string; date: string | undefined; fragments: Fragment[] };

// What the generator puts in each version: its fragments' items, section by section, in order.
const expected = (r: GenRelease[]) => r.map(({ version, date, fragments }) => ({
  version, date,
  sections: SECTIONS.map((name) => ({ name, items: fragments.flatMap((f) => f.sections[name] ?? []) })).filter((s) => s.items.length),
}));
const scratch = () => mkdtempSync(join(tmpdir(), 'nova-changelog-view-'));

test('the app’s changelog is CHANGELOG.md, entry for entry: the same as the fragments it is generated from', () => {
  const file = readFileSync(TARGET, 'utf8');
  assert.equal(file, generate(), 'CHANGELOG.md is current (npm run changelog)');
  const parsed = parseChangelog(file);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.versions, expected(releases()));
  const view = changelogView(ROOT, { version: '0.1.0-alpha.1', commit_short: 'aaaaaaaa' });
  assert.deepEqual(view.versions, parsed.versions, 'the endpoint reads the file itself');
  assert.equal(view.newest, parsed.versions[0]!.version);
  assert.ok(view.versions.every((v) => v.sections.every((s) => s.items.every((it) => !/(^|[^\w&/])#\d+\b/.test(it)))), 'no bare pull request numbers');
});

test('newest version first, whatever order the file has them in', () => {
  const block = (v: string, d: string) => `## ${v} - ${d}\n\n### Added\n\n- In ${v}.\n`;
  const text = `# Changelog\n\nAbout this file.\n\n${block('0.1.0-alpha.2', '2026-11-07')}\n${block('0.1.0-alpha.10', '2026-11-09')}\n${block('0.1.0-alpha.1', '2026-11-06')}`;
  const p = parseChangelog(text);
  assert.deepEqual(p.versions.map((v) => v.version), ['0.1.0-alpha.10', '0.1.0-alpha.2', '0.1.0-alpha.1']);
  assert.deepEqual(p.versions[0]!.sections, [{ name: 'Added', items: ['In 0.1.0-alpha.10.'] }]);
  assert.deepEqual(p.problems, []);
});

test('a malformed block is left out and named; the blocks around it still show', () => {
  const good = (v: string) => `## ${v} - 2026-11-06\n\n### Fixed\n\n- Fine in ${v}.\n\n`;
  const text = `# Changelog\n\n${good('0.1.0-alpha.4')}## 0.1.0-alpha.3 - 2026-11-06\n\n### Improved\n\n- Not a section.\n\n## next - soon\n\n### Added\n\n- No version.\n\n## 0.1.0-alpha.2 - 2026-11-06\n\nLoose text, not an item.\n\n## 0.1.0-alpha.9 - 2026-11-06\n\n### Added\n\n\n${good('0.1.0-alpha.4')}${good('0.1.0-alpha.1')}`;
  const p = parseChangelog(text);
  assert.deepEqual(p.versions.map((v) => v.version), ['0.1.0-alpha.4', '0.1.0-alpha.1']);
  assert.equal(p.problems.length, 5, p.problems.join('\n'));
  for (const [i, why] of [/isn't a section/, /isn't "<version> - <YYYY-MM-DD>"/, /isn't a "- " item/, /has no items/, /appears twice/].entries()) assert.match(p.problems[i]!, why);
  assert.doesNotThrow(() => parseChangelog('garbage\n## \n### \n- \n'));
});

test('the view: fragments waiting for a version, newest first; a bad one left out; no file, or a link, is no changelog, never an error', () => {
  const root = scratch();
  mkdirSync(join(root, 'docs', 'changelog', '0.1.0-alpha.1'), { recursive: true });
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0-alpha.1 - 2026-11-06\n\n### Added\n\n- The first thing.\n');
  writeFileSync(join(root, 'docs', 'changelog', 'README.md'), 'not a fragment');
  writeFileSync(join(root, 'docs', 'changelog', '0.1.0-alpha.1', '2026-11-06-first.md'), '### Added\n- The first thing.\n');
  writeFileSync(join(root, 'docs', 'changelog', '2026-11-07-later.md'), '### Fixed\n- A later fix,\n  said on two lines.\n');
  writeFileSync(join(root, 'docs', 'changelog', '2026-11-08-latest.md'), '### Security\n- A safer thing.\n### Added\n- A new thing.\n');
  writeFileSync(join(root, 'docs', 'changelog', '2026-11-08-broken.md'), '### Added\n- Fixed in #352\n');
  const running = { version: '0.1.0-alpha.1', commit_short: 'bbbbbbbb' };
  const v = changelogView(root, running);
  assert.deepEqual(v.running, running);
  assert.equal(v.newest, '0.1.0-alpha.1');
  assert.deepEqual(v.waiting.map((w) => w.file), ['2026-11-08-latest.md', '2026-11-07-later.md']);
  assert.deepEqual(v.waiting[0]!.sections, [{ name: 'Added', items: ['A new thing.'] }, { name: 'Security', items: ['A safer thing.'] }]);
  assert.deepEqual(v.waiting[1]!.sections, [{ name: 'Fixed', items: ['A later fix, said on two lines.'] }]);
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /2026-11-08-broken\.md.*names a pull request.*left out/);

  const empty = changelogView(scratch(), running);
  assert.deepEqual([empty.versions, empty.waiting, empty.newest], [[], [], null]);
  assert.match(empty.problems[0]!, /CHANGELOG\.md isn’t in this build/);

  const linked = scratch();
  symlinkSync(join(root, 'CHANGELOG.md'), join(linked, 'CHANGELOG.md'));
  assert.deepEqual(changelogView(linked, running).versions, [], 'a link is not followed');
  const big = scratch();
  writeFileSync(join(big, 'CHANGELOG.md'), `# Changelog\n${'x'.repeat(1024 * 1024 + 1)}`);
  assert.deepEqual(changelogView(big, running).versions, [], 'an oversized file is not read');
});
