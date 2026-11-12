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
    assert.deepEqual(classify('pull_request', ''), { heavy: 'true', computer: 'true', ui: 'false', kind: 'code' });
  });
});

test('CI changes: shallow merge first-parent docs stay docs-only; an unavailable older BEFORE fails closed', () => {
  fixture('docs', ({ git, classify, older, base }) => {
    assert.equal(git('rev-parse', 'HEAD^1'), base);
    assert.deepEqual(classify('pull_request', ''), { heavy: 'false', computer: 'false', ui: 'false', kind: 'docs' });
    assert.throws(() => git('cat-file', '-e', `${older}^{commit}`), 'older push BEFORE is absent at the actual workflow depth');
    assert.deepEqual(classify('push', older), { heavy: 'true', computer: 'false', ui: 'true', kind: 'code' });
  });
});

// The ui= output (owner pipeline ruling, 2026-11-11): a pull request runs the UI gate and shots only
// when it touches a UI surface; the list is in scripts/ci-changes.sh and docs/PIPELINE.md. The two
// fixtures above gained the ui key in their deepEqual: they assert every output, so they still do.
const sort = (files) => Object.fromEntries(execFileSync('sh', ['scripts/ci-changes.sh'], { input: files.map(f => `${f}\n`).join(''), encoding: 'utf8' })
  .trim().split('\n').map(line => line.split('=')));

test('CI changes: every UI surface makes ui=true, alone or among non-UI files', () => {
  const surfaces = [
    'ui/index.html', 'ui/js/app.js', 'ui/styles/stage2.css', 'ui/icons/icon-192.png', 'ui/sw.js', 'ui/manifest.webmanifest',
    'design-systems/nova.json', 'src/core/design.ts', 'src/core/extensions.ts', 'src/core/csp.ts', 'src/sw-version.js', 'src/server.js',
    'tests/ui/fold-postures.test.ts', 'tests/ui/support.ts', 'tests/ui/baselines/fold/chromium-duo-cover-chat.png',
    'scripts/shots.js', 'scripts/ui-shard.js', 'scripts/ui-timings.js', 'scripts/ui-timings.json', 'scripts/ui-test.sh', 'scripts/tripwire.sh',
    'scripts/fake-google.js', 'scripts/form-site.js', 'scripts/make-zip.js', 'scripts/stand-ins/shop-site.js',
    'tests/support/models.ts', 'tests/acceptance/support.ts', 'tests/acceptance/m4c-support.ts', 'tests/core/mesh-support.ts',
    'package.json', 'package-lock.json', 'mise.toml', '.github/workflows/ci.yml',
  ];
  for (const f of surfaces) {
    assert.equal(sort([f]).ui, 'true', `${f} alone is a UI surface`);
    assert.equal(sort(['src/core/memory.ts', f, 'docs/x.md']).ui, 'true', `${f} among non-UI files`);
    assert.equal(sort([f]).heavy, 'true', `${f} is heavy`);
  }
});

test('CI changes: non-UI code is heavy with ui=false; docs only stays docs only', () => {
  const nonUi = [
    'src/core/memory.ts', 'src/agent.js', 'src/core/computer/policy.ts', 'tests/core/memory.test.ts', 'tests/ci-changes.test.js',
    'tests/ui-shard.test.js', 'tests/acceptance/m10a-image.test.ts', 'scripts/ci-changes.sh', 'scripts/ci-gate.sh', 'scripts/merge-on-green.sh',
    'charts/nova/values.yaml', 'system/AGENT.md', 'templates/x.md', 'skills/x/SKILL.md', 'schedules/x.md', 'connectors/x.md',
  ];
  for (const f of nonUi) {
    const out = sort([f]);
    assert.deepEqual([out.heavy, out.ui], ['true', 'false'], f);
  }
  assert.deepEqual(sort(nonUi).ui, 'false', 'all of them together');
  assert.deepEqual(sort(['docs/PIPELINE.md', 'handoffs/x.md', 'README.md']), { heavy: 'false', computer: 'false', ui: 'false', kind: 'docs' });
});

test('CI changes: an unknown file or an empty diff counts as UI (fail safe)', () => {
  for (const f of ['tsconfig.json', 'LICENSE', '.gitignore', 'new-folder/thing.js']) assert.equal(sort([f]).ui, 'true', f);
  assert.deepEqual(sort([]), { heavy: 'true', computer: 'false', ui: 'true', kind: 'code' });
});
