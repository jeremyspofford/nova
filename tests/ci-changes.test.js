// The real changes-job shell must classify a depth-limited PR merge from its first parent.
// Private local Git fixtures only: no external repository, owner configuration or new dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const changes = /^  changes:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m.exec(workflow)?.[1];
assert.ok(changes, 'actual changes job exists');
const depth = Number(/fetch-depth: (\d+)/.exec(changes)?.[1]);
assert.ok(Number.isInteger(depth), 'actual changes checkout has explicit depth');
const shell = /^        run: \|\n((?:          [^\n]*\n)+)/m.exec(changes)?.[1].split('\n').filter(Boolean).map(line => line.slice(10)).join('\n');
assert.ok(shell, 'run the actual changes-job classifier shell');
const classifier = readFileSync(new URL('../scripts/ci-changes.sh', import.meta.url), 'utf8');

function fixture(kind, check) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-ci-depth-'));
  const origin = join(dir, 'origin'); const checkout = join(dir, 'checkout');
  mkdirSync(origin); mkdirSync(join(dir, 'home'));
  const env = { PATH: process.env.PATH, HOME: join(dir, 'home'), TMPDIR: dir, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Synthetic CI fixture', '-c', 'user.email=ci-fixture@example.invalid', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = message => { git(origin, 'add', '.'); git(origin, 'commit', '-qm', message); return git(origin, 'rev-parse', 'HEAD'); };
  try {
    git(origin, 'init', '-q', '--initial-branch=main');
    mkdirSync(join(origin, 'scripts')); mkdirSync(join(origin, 'docs')); mkdirSync(join(origin, 'src/core/computer'), { recursive: true });
    writeFileSync(join(origin, 'scripts/ci-changes.sh'), classifier);
    writeFileSync(join(origin, 'docs/readme.md'), 'Synthetic initial document.\n');
    const older = commit('initial');
    writeFileSync(join(origin, 'docs/readme.md'), 'Synthetic intermediate document.\n'); commit('intermediate');
    writeFileSync(join(origin, 'docs/readme.md'), 'Synthetic base document.\n'); const base = commit('base');
    git(origin, 'checkout', '-qb', 'feature');
    const changed = kind === 'code' ? 'src/core/computer/example.js' : 'docs/feature.md';
    writeFileSync(join(origin, changed), kind === 'code' ? 'export const synthetic = true;\n' : 'Synthetic documentation change.\n'); commit('feature');
    git(origin, 'checkout', '-q', 'main'); git(origin, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge fixture');
    const merge = git(origin, 'rev-parse', 'HEAD');
    git(dir, 'clone', '-q', '--no-local', ...(depth ? ['--depth', String(depth)] : []), '--branch', 'main', pathToFileURL(origin).href, checkout);
    const classify = (event, before) => {
      const output = join(dir, `output-${event}`);
      execFileSync('sh', ['-eu', '-c', shell], { cwd: checkout, env: { ...env, EVENT: event, BEFORE: before, SHA: merge, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
    };
    check({ git: (...args) => git(checkout, ...args), classify, older, base, merge, changed });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('CI changes: actual checkout depth makes a real shallow PR merge classify code from its first parent', () => {
  fixture('code', ({ git, classify, base }) => {
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'true', 'changes checkout is genuinely shallow');
    assert.equal(git('rev-parse', 'HEAD^1'), base);
    assert.deepEqual(classify('pull_request', ''), { heavy: 'true', computer: 'true', kind: 'code' });
  });
});

test('CI changes: shallow merge first-parent docs stay docs-only; an unavailable older BEFORE fails closed', () => {
  fixture('docs', ({ git, classify, older, base }) => {
    assert.equal(git('rev-parse', 'HEAD^1'), base);
    assert.deepEqual(classify('pull_request', ''), { heavy: 'false', computer: 'false', kind: 'docs' });
    assert.throws(() => git('cat-file', '-e', `${older}^{commit}`), 'older push BEFORE is absent at the actual workflow depth');
    assert.deepEqual(classify('push', older), { heavy: 'true', computer: 'false', kind: 'code' });
  });
});
