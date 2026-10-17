// A small Git repository built at runtime for the Code session journey (J6): two source files
// with a bug each, a failing `node --test` suite (no network, no dependencies), an instruction
// file longer than the 32 KiB budget, and Git hooks plus an fsmonitor command that each append
// to a marker file outside the repository, so any hook that runs leaves a trace.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Hooks Git may run on status, index, ref, checkout, worktree and commit operations. */
export const HOOKS = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-checkout',
  'post-merge',
  'post-rewrite',
  'post-index-change',
  'reference-transaction',
  'pre-auto-gc',
  'pre-push',
] as const;

export interface FixtureRepo {
  /** The repository (its work tree). */
  repo: string;
  /** Appended to by every hook and by the fsmonitor command; never inside the repository. */
  marker: string;
  /** Read-only Git queries that never run hooks or fsmonitor themselves. */
  git(...args: string[]): string;
  /** Whether the repository's test suite passes, run with this process's Node. */
  testsPass(): boolean;
}

const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'calc',
      private: true,
      type: 'module',
      scripts: { test: 'node --test test/calc.test.js' },
    },
    null,
    2,
  )}\n`,
  'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n',
  'src/label.js': "export function label(n) {\n  return n + ' item';\n}\n",
  'test/calc.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.js';",
    "import { label } from '../src/label.js';",
    '',
    "test('add', () => assert.equal(add(2, 3), 5));",
    "test('label', () => assert.equal(label(5), '5 items'));",
    '',
  ].join('\n'),
  // Over the default 32 KiB instruction budget: Nova reads it and says it truncated it.
  'AGENTS.md': [
    '# Calc',
    '',
    'Run the tests with npm test. Keep functions small.',
    '',
    ...Array.from(
      { length: 900 },
      (_, i) => `- Style rule ${i + 1}: name things for what they are.`,
    ),
    '',
  ].join('\n'),
};

export function createFixtureRepo(): FixtureRepo {
  const base = mkdtempSync(join(tmpdir(), 'nova-e2e-repo-'));
  const repo = join(base, 'calc');
  const marker = join(base, 'hooks-ran.txt');
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  // Our own Git calls disable hooks and fsmonitor, like Nova's.
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture Author');
  git('config', 'user.email', 'fixture@example.com');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial calc');
  for (const hook of HOOKS) {
    const file = join(repo, '.git', 'hooks', hook);
    writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
    chmodSync(file, 0o755);
  }
  const fsmonitor = join(base, 'fsmonitor.sh');
  writeFileSync(fsmonitor, `#!/bin/sh\necho fsmonitor >> "${marker}"\n`);
  chmodSync(fsmonitor, 0o755);
  git('config', 'core.fsmonitor', fsmonitor);
  return {
    repo,
    marker,
    git,
    testsPass: () => {
      try {
        execFileSync(process.execPath, ['--test', 'test/calc.test.js'], {
          cwd: repo,
          stdio: 'pipe',
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
