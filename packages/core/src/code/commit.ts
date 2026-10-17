// Committing a session's accepted changes (docs/10 §8, FR-211). The accepted content (the
// shadow baseline) is staged into the user's index path by path, without touching the work
// tree, so hunks still pending stay out of the commit. The staged diff is scanned for secrets
// before anything is committed. The repository's commit hooks run only inside the session
// sandbox; when no sandbox with Git is available the commit runs on the Hub with hooks disabled
// and the result says so. Nothing is ever pushed.
import { access, constants } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { NovaError } from '@nova/shared';
import { scanText, type ScanFinding } from '@nova/security';
import { diffAddedLines } from './diff.ts';
import type { HookFreeGit } from './git.ts';
import type { SandboxClient } from '../tools/types.ts';

/** Hooks a commit runs (githooks(5)). */
export const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'];

export interface StageEntry {
  /** Path relative to the repository root, `/`-separated. */
  path: string;
  /** The content to commit, or null to delete the file. */
  content: { mode: string; data: Buffer } | null;
}

/** Whether the repository has any active commit hook (core.hooksPath or `.git/hooks`). */
export async function hasCommitHooks(git: HookFreeGit, folder: string): Promise<boolean> {
  const dir = await hooksDir(git, folder);
  for (const n of COMMIT_HOOKS) if (await executable(join(dir, n))) return true;
  return false;
}

/** The executable hook `name` of the repository (core.hooksPath or `.git/hooks`), if any. */
export async function hookFile(
  git: HookFreeGit,
  folder: string,
  name: string,
): Promise<string | null> {
  const p = join(await hooksDir(git, folder), name);
  return (await executable(p)) ? p : null;
}

async function executable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the repository's hooks live: the user's own core.hooksPath, else `.git/hooks`. */
export async function hooksDir(git: HookFreeGit, folder: string): Promise<string> {
  // The user's own core.hooksPath: the last value from a config file (ours, from the command
  // line, points at the empty folder).
  const configured = await git.run(['config', '--show-origin', '--get-all', 'core.hooksPath'], {
    cwd: folder,
    allowFail: true,
  });
  const own = configured.stdout
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('command line:'))
    .map((l) => l.slice(l.indexOf('\t') + 1).trim())
    .at(-1);
  const top = await git.text(['rev-parse', '--show-toplevel'], { cwd: folder });
  if (own) return isAbsolute(own) ? own : join(top, own);
  const common = await git.text(['rev-parse', '--git-common-dir'], { cwd: folder });
  return join(isAbsolute(common) ? common : join(folder, common), 'hooks');
}

/** Whether HEAD points at a commit (false on an unborn branch). */
export async function hasHead(git: HookFreeGit, cwd: string): Promise<boolean> {
  return (
    (await git.run(['rev-parse', '-q', '--verify', 'HEAD'], { cwd, allowFail: true })).code === 0
  );
}

/** Whether anything is staged in the user's index. */
export async function hasStaged(git: HookFreeGit, cwd: string): Promise<boolean> {
  const r = await git.run(['diff', '--cached', '--quiet', '--no-ext-diff'], {
    cwd,
    allowFail: true,
  });
  return r.code === 1;
}

/** Stage the entries into the user's index (blobs written to the user's object store). */
export async function stage(git: HookFreeGit, cwd: string, entries: readonly StageEntry[]) {
  for (const e of entries) {
    if (!e.content) {
      await git.run(['update-index', '--force-remove', '--', e.path], { cwd });
      continue;
    }
    const sha = await git.text(['hash-object', '-w', '--no-filters', '--stdin'], {
      cwd,
      input: e.content.data,
    });
    await git.run(['update-index', '--add', '--cacheinfo', `${e.content.mode},${sha},${e.path}`], {
      cwd,
    });
  }
}

/** Put the index entries of `paths` back to HEAD (or remove them on an unborn branch). */
export async function unstage(git: HookFreeGit, cwd: string, paths: readonly string[]) {
  if (!paths.length) return;
  if (await hasHead(git, cwd)) {
    for (let i = 0; i < paths.length; i += 200)
      await git.run(['reset', '-q', 'HEAD', '--', ...paths.slice(i, i + 200)], {
        cwd,
        allowFail: true,
      });
  } else {
    for (let i = 0; i < paths.length; i += 200)
      await git.run(
        ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...paths.slice(i, i + 200)],
        {
          cwd,
          allowFail: true,
        },
      );
  }
}

/** Secrets on lines the staged diff adds (FR-101); previews are masked. */
export async function scanStaged(
  git: HookFreeGit,
  cwd: string,
  entries: readonly StageEntry[],
): Promise<ScanFinding[]> {
  const diff = await git.run(
    [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U0',
    ],
    { cwd },
  );
  const added = diffAddedLines(diff.stdout.toString('utf8'));
  const findings: ScanFinding[] = [];
  for (const e of entries) {
    const lines = added.get(e.path);
    if (!e.content || !lines?.size) continue;
    if (e.content.data.subarray(0, 8192).includes(0)) continue;
    const text = e.content.data.toString('utf8');
    for (const f of scanText(e.path, text)) if (lines.has(f.line)) findings.push(f);
  }
  return findings;
}

/** A new branch name `nova/<slug>`, with a short suffix when it already exists. */
export async function freeBranch(git: HookFreeGit, cwd: string, slug: string): Promise<string> {
  const base = `nova/${slug}`;
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? base : `${base}-${Math.random().toString(16).slice(2, 6)}`;
    const r = await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
      cwd,
      allowFail: true,
    });
    if (r.code !== 0) return name;
  }
  throw new NovaError('conflict', `no free branch name for ${base}`);
}

/** Create `name` at HEAD and switch to it without touching files (no checkout, no hooks). */
export async function switchToNewBranch(git: HookFreeGit, cwd: string, name: string) {
  const check = await git.run(['check-ref-format', '--branch', name], { cwd, allowFail: true });
  if (check.code !== 0) throw new NovaError('validation', `not a valid branch name: ${name}`);
  if (await hasHead(git, cwd)) await git.run(['branch', '--no-track', name, 'HEAD'], { cwd });
  await git.run(['symbolic-ref', 'HEAD', `refs/heads/${name}`], { cwd });
}

/** The Hub user's Git identity for a commit made in the sandbox (no config there). */
export async function identity(git: HookFreeGit, cwd: string): Promise<Record<string, string>> {
  const get = async (key: string) => {
    const r = await git.run(['config', '--get', key], { cwd, allowFail: true });
    return r.code === 0 ? r.stdout.toString('utf8').trim() : '';
  };
  const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
  const env: Record<string, string> = {};
  if (name) {
    env.GIT_AUTHOR_NAME = name;
    env.GIT_COMMITTER_NAME = name;
  }
  if (email) {
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_EMAIL = email;
  }
  return env;
}

/** Whether the sandbox can run Git at all (the default image has none). */
export async function sandboxHasGit(
  sandbox: SandboxClient,
  cwd: string,
  roots: { path: string; access: 'read' | 'write'; label: string }[],
  signal: AbortSignal,
): Promise<boolean> {
  try {
    if (!(await sandbox.available()).ok) return false;
    const r = await sandbox.exec({
      cmd: 'command -v git >/dev/null 2>&1',
      cwd,
      roots,
      network: 'off',
      yieldMs: 60_000,
      signal,
    });
    return r.status === 'exited' && r.exitCode === 0;
  } catch {
    return false;
  }
}
