// Hook-free Git (FR-211) and change capture with a shadow repository (FR-064): Nova's own Git
// calls never run a repository hook (a hook that writes a marker proves it) and never change
// the user's config; the shadow captures tracked and untracked files, honours .gitignore,
// leaves protected paths out, and accepts or rejects single hunks.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HookFreeGit,
  ShadowRepo,
  branchSlug,
  buildHunkPatch,
  capturePathspecs,
  gitEnv,
  hasCommitHooks,
  isDefaultBranch,
  repoInfo,
  repoUserExcludes,
} from '../src/index.ts';

let dir: string;
let repo: string;
let git: HookFreeGit;
let marker: string;

/** A plain `git` call for test setup (hooks enabled on purpose where a test says so). */
function sh(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...gitEnv({ cwd }),
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@x',
    },
    encoding: 'utf8',
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-code-git-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  marker = join(dir, 'hook-ran');
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.name', 'Test']);
  sh(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n');
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
  // Every hook Git might run writes the marker.
  for (const hook of [
    'pre-commit',
    'post-checkout',
    'post-index-change',
    'commit-msg',
    'post-commit',
    'reference-transaction',
    'fsmonitor-watchman',
  ]) {
    const p = join(repo, '.git', 'hooks', hook);
    writeFileSync(p, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
    chmodSync(p, 0o755);
  }
  git = new HookFreeGit({ emptyHooksDir: join(dir, 'empty-hooks') });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hook-free git (FR-211)', () => {
  it('runs status, diff, branch listing and commits without running repository hooks', async () => {
    // Sanity: the hook does run for a plain git call.
    sh(['commit', '-q', '--allow-empty', '-m', 'with hooks']);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const configBefore = readFileSync(join(repo, '.git', 'config'), 'utf8');
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    await git.run(['status', '--porcelain'], { cwd: repo });
    await git.run(['diff'], { cwd: repo });
    await git.run(['branch', '--list'], { cwd: repo });
    await git.run(['add', 'a.txt'], { cwd: repo });
    await git.run(['commit', '-q', '-m', 'no hooks'], { cwd: repo });
    await git.run(['checkout', '-q', '-b', 'side'], { cwd: repo });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(configBefore);
  });

  it('reports repository info, the default branch and fails clearly outside a repository', async () => {
    const info = await repoInfo(git, repo);
    expect(info).toMatchObject({ branch: 'main', dirty: false });
    expect(info?.head).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect((await repoInfo(git, repo))?.dirty).toBe(true);
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(await repoInfo(git, plain)).toBeNull();
    expect(await isDefaultBranch(git, repo, 'main')).toBe(true);
    expect(await isDefaultBranch(git, repo, 'feature')).toBe(false);
    await expect(git.run(['rev-parse', 'HEAD'], { cwd: plain })).rejects.toMatchObject({
      code: 'server_error',
    });
    expect(await git.version()).toMatch(/^git version/);
  });

  it('drops inherited GIT_ variables and never prompts', () => {
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = '/elsewhere';
    try {
      const env = gitEnv({ cwd: repo });
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(gitEnv({ cwd: repo, isolated: true }).GIT_CONFIG_NOSYSTEM).toBe('1');
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });

  it("overrides the user's own core.hooksPath for the call, and still sees their hooks", async () => {
    const own = join(dir, 'my-hooks');
    mkdirSync(own);
    const p = join(own, 'pre-commit');
    writeFileSync(p, `#!/bin/sh\necho custom >> "${marker}"\n`);
    chmodSync(p, 0o755);
    sh(['config', 'core.hooksPath', own]);
    expect(await hasCommitHooks(git, repo)).toBe(true);
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    await git.run(['commit', '-q', '-am', 'still no hooks'], { cwd: repo });
    expect(existsSync(marker)).toBe(false);
    expect(sh(['config', '--get', 'core.hooksPath']).trim()).toBe(own);
    sh(['config', '--unset', 'core.hooksPath']);
    rmSync(join(repo, '.git', 'hooks'), { recursive: true, force: true });
    expect(await hasCommitHooks(git, repo)).toBe(false);
  });

  it('refuses a hooks folder that is not empty', () => {
    const d = join(dir, 'full');
    mkdirSync(d);
    writeFileSync(join(d, 'pre-commit'), 'x');
    expect(() => new HookFreeGit({ emptyHooksDir: d })).toThrow(/not empty/);
  });

  it('makes branch slugs', () => {
    expect(branchSlug('Fix the Login bug!')).toBe('fix-the-login-bug');
    expect(branchSlug('nova/already')).toBe('already');
    expect(branchSlug('***')).toBe('change');
  });
});

describe('shadow repository (FR-064)', () => {
  async function shadow(): Promise<ShadowRepo> {
    const s = new ShadowRepo({ git, gitDir: join(dir, 'shadow.git'), workTree: repo });
    await s.init(await repoUserExcludes(git, repo));
    await s.setRef('baseline', await s.snapshot());
    return s;
  }

  it('captures edits, new and deleted files, honours .gitignore and skips protected paths', async () => {
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'private.txt\n');
    const s = await shadow();
    expect((await s.changes()).files).toEqual([]);
    writeFileSync(
      join(repo, 'a.txt'),
      'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
    );
    writeFileSync(join(repo, 'b.txt'), 'new file\n');
    writeFileSync(join(repo, 'ignored.log'), 'noise');
    writeFileSync(join(repo, 'private.txt'), 'kept out');
    mkdirSync(join(repo, '.nova'));
    writeFileSync(join(repo, '.nova', 'x.md'), 'protected');
    mkdirSync(join(repo, 'sub', '.ssh'), { recursive: true });
    writeFileSync(join(repo, 'sub', '.ssh', 'id'), 'key');
    // An in-tree negation cannot bring a protected path back.
    writeFileSync(join(repo, 'sub', '.gitignore'), '!.ssh\n');
    rmSync(join(repo, '.gitignore'));
    const { files } = await s.changes();
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual([
      '.gitignore',
      'a.txt',
      'b.txt',
      'ignored.log',
      'sub/.gitignore',
    ]);
    expect(byPath.get('a.txt')).toMatchObject({ kind: 'modify', additions: 1, deletions: 1 });
    expect(byPath.get('b.txt')).toMatchObject({ kind: 'add', additions: 1 });
    expect(byPath.get('.gitignore')).toMatchObject({ kind: 'delete' });
    expect(byPath.get('a.txt')!.hunks[0]).toMatchObject({ id: '1-1', oldStart: 1, newStart: 1 });
    expect(capturePathspecs()).toContain(':(exclude,glob,icase)**/.git/**');
    // The user's repository is untouched by the shadow.
    expect(sh(['status', '--porcelain'])).toContain('a.txt');
    expect(existsSync(marker)).toBe(false);
  });

  it('accepts one hunk into the baseline and rejects another from the work tree', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repo, 'a.txt'), `${lines.join('\n')}\n`);
    const s = await shadow();
    const edited = [...lines];
    edited[1] = 'CHANGED 2';
    edited[25] = 'CHANGED 26';
    writeFileSync(join(repo, 'a.txt'), `${edited.join('\n')}\n`);
    const file = (await s.changes()).files[0]!;
    expect(file.hunks.map((h) => h.id)).toEqual(['1-1', '23-23']);
    const base = (await s.ref('baseline'))!;
    const next = await s.applyToTree(base, buildHunkPatch(file, new Set(['1-1'])));
    await s.setRef('baseline', next);
    await s.reverseInWorkTree(buildHunkPatch(file, new Set(['23-23'])));
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('CHANGED 2');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).not.toContain('CHANGED 26');
    expect((await s.changes()).files).toEqual([]);
    // A stale patch is refused.
    await expect(
      s.reverseInWorkTree(buildHunkPatch(file, new Set(['23-23']))),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('restores whole files and removes added ones', async () => {
    const s = await shadow();
    writeFileSync(join(repo, 'a.txt'), 'gone\n');
    writeFileSync(join(repo, 'added.bin'), Buffer.from([0, 1, 2, 3]));
    const { files } = await s.changes();
    expect(files.find((f) => f.path === 'added.bin')).toMatchObject({ binary: true, hunks: [] });
    await s.restore('baseline', ['a.txt', 'added.bin']);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toMatch(/^one\n/);
    expect(existsSync(join(repo, 'added.bin'))).toBe(false);
    expect((await s.changes()).files).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it('fails clearly when the folder disappears', async () => {
    const s = await shadow();
    rmSync(repo, { recursive: true, force: true });
    await expect(s.snapshot()).rejects.toMatchObject({ code: 'conflict' });
  });
});
