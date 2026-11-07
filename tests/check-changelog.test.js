// The CI rule (scripts/check-changelog.sh): a pull request that changes what Nova ships adds a
// changelog fragment and a ledger entry, unless it is labelled no-changelog. Checked against real
// diffs in a scratch repository (never this one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-changelog.sh');
const ENV = { PATH: process.env.PATH ?? '', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.com', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (root, file, text = 'x\n') => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };

// A base branch with code, docs and existing entries; then a branch with `files` written on it.
function branch(files, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nova-check-changelog-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const f of ['src/server.js', 'ui/index.html', 'docs/notes.md', 'docs/changelog/README.md', 'docs/changelog/2026-11-01-old.md', 'docs/ledger/2026-11-01-old.md', 'tests/a.test.js']) put(root, f);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  for (const f of files) put(root, f, 'changed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  // main moves on after the branch left it: only the branch's own changes count.
  git(root, 'checkout', '-q', 'main');
  put(root, 'src/elsewhere.js');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main moves');
  git(root, 'checkout', '-q', 'feature');
  const r = spawnSync('sh', [SCRIPT, 'main'], { cwd: root, env: { ...ENV, ...extra }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const FRAGMENT = 'docs/changelog/2026-11-06-feature.md';
const LEDGER = 'docs/ledger/2026-11-06-feature.md';

test('a change to what Nova ships, with a new fragment and a new ledger entry, passes', () => {
  for (const dir of ['src/core/x.ts', 'ui/js/app.js', 'skills/s/SKILL.md', 'templates/home/a.md', 'system/AGENT.md']) {
    const r = branch([dir, FRAGMENT, LEDGER]);
    assert.equal(r.code, 0, `${dir}: ${r.out}`);
    assert.match(r.out, /Changelog fragment: docs\/changelog\/2026-11-06-feature\.md/);
  }
});

test('a change to what Nova ships without its fragment, or without its ledger entry, fails and says which', () => {
  let r = branch(['src/server.js']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Missing: a new docs\/changelog/);
  assert.match(r.out, /Missing: a new docs\/ledger/);
  r = branch(['ui/index.html', FRAGMENT]);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /Missing: a new docs\/changelog/);
  assert.match(r.out, /Missing: a new docs\/ledger/);
  r = branch(['src/server.js', LEDGER]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Missing: a new docs\/changelog/);
});

test('editing an existing fragment, a README, or a file in a subfolder is not a new fragment', () => {
  for (const f of [['docs/changelog/2026-11-01-old.md', 'docs/ledger/2026-11-01-old.md'], ['docs/changelog/README.md', LEDGER], ['docs/changelog/0.1.0-alpha.2/2026-11-06-feature.md', LEDGER]]) {
    const r = branch(['src/server.js', ...f]);
    assert.equal(r.code, 1, `${f}: ${r.out}`);
  }
});

test('a change that touches nothing Nova ships passes without entries; main moving on is not counted', () => {
  for (const files of [['docs/notes.md'], ['tests/a.test.js'], ['README.md', 'scripts/x.sh']]) {
    const r = branch(files);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Nothing Nova ships changed/);
  }
});

test('the no-changelog label skips the check', () => {
  const r = branch(['src/server.js'], { NO_CHANGELOG: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Labelled no-changelog/);
});

test('a base it can’t compare with fails plainly', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-check-changelog-'));
  git(root, 'init', '-q', '-b', 'main');
  put(root, 'src/a.js');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const r = spawnSync('sh', [SCRIPT, 'origin/nowhere'], { cwd: root, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Couldn't compare with origin\/nowhere/);
});
