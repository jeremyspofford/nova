// Hook-free Git for Nova's own bookkeeping (FR-211, docs/10 §8). Every invocation disables the
// repository's hooks and fsmonitor for that one call (`-c core.hooksPath=<empty dir>`,
// `-c core.fsmonitor=false`), never pages, never prompts, never runs external diff or textconv
// drivers, and never writes the user's Git config. Inherited `GIT_*` variables are dropped so a
// Hub started from inside a Git hook cannot redirect these calls to another repository.
//
// Shadow repositories (change capture, FR-064) are `isolated`: they also ignore the system and
// global config, so no user-defined filter, attribute or alias can run a program.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname } from 'node:path';
import { NovaError } from '@nova/shared';

export interface GitRunOptions {
  cwd: string;
  /** `GIT_DIR` and `GIT_WORK_TREE` (shadow repositories). */
  gitDir?: string;
  workTree?: string;
  /** `GIT_INDEX_FILE` (a temporary index). */
  indexFile?: string;
  /** Ignore the system and global config (shadow repositories). */
  isolated?: boolean;
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Resolve with the exit code instead of throwing on a non-zero exit. */
  allowFail?: boolean;
  /** Bytes of output kept (default 64 MB); more fails the call. */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Per-invocation config that keeps bookkeeping calls inert (FR-211). */
export function hookFreeArgs(emptyHooksDir: string): string[] {
  return [
    '--no-pager',
    '-c',
    `core.hooksPath=${emptyHooksDir}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'advice.detachedHead=false',
  ];
}

/** The environment for a call: the Hub's own, without any `GIT_*` variable it inherited. */
export function gitEnv(opts: GitRunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && k !== 'PAGER' && k !== 'EDITOR' && k !== 'VISUAL') env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_EDITOR = 'true';
  env.GIT_ASKPASS = 'true';
  env.SSH_ASKPASS = 'true';
  // Reads never take the index lock the user's own tools may hold.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  if (opts.isolated) {
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = devNull;
    env.GIT_ATTR_NOSYSTEM = '1';
  }
  if (opts.gitDir) env.GIT_DIR = opts.gitDir;
  if (opts.workTree) env.GIT_WORK_TREE = opts.workTree;
  if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
  return { ...env, ...opts.env };
}

/**
 * Runs Git with hooks disabled. Construct one per Hub with a directory that stays empty; it is
 * created read-only so nothing writes a hook into it.
 */
export class HookFreeGit {
  readonly emptyHooksDir: string;
  readonly bin: string;

  constructor(opts: { emptyHooksDir: string; bin?: string }) {
    this.emptyHooksDir = opts.emptyHooksDir;
    this.bin = opts.bin ?? 'git';
    mkdirSync(dirname(this.emptyHooksDir), { recursive: true, mode: 0o700 });
    mkdirSync(this.emptyHooksDir, { recursive: true, mode: 0o500 });
    if (readdirSync(this.emptyHooksDir).length > 0)
      throw new NovaError(
        'server_error',
        `the empty hooks folder is not empty: ${this.emptyHooksDir}`,
      );
    try {
      chmodSync(this.emptyHooksDir, 0o500);
    } catch {
      // A filesystem without modes still gets an empty directory.
    }
  }

  /** Whether Git can run at all. */
  async version(): Promise<string | null> {
    try {
      const r = await this.run(['--version'], { cwd: process.cwd(), allowFail: true });
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
    } catch {
      return null;
    }
  }

  run(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
    const max = opts.maxBytes ?? 64 * 1024 * 1024;
    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.bin, [...hookFreeArgs(this.emptyHooksDir), ...args], {
        cwd: opts.cwd,
        env: gitEnv(opts),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = '';
      let over = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
      child.stdout.on('data', (b: Buffer) => {
        outBytes += b.length;
        if (outBytes > max) {
          over = true;
          child.kill('SIGKILL');
          return;
        }
        out.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        if (err.length < 64_000) err += b.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(
          new NovaError('capability_missing', `Git could not run: ${e.message}`, {
            action: 'Install Git on the Hub',
          }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (over) {
          reject(new NovaError('validation', 'the Git output is too large'));
          return;
        }
        const res: GitResult = { code: code ?? -1, stdout: Buffer.concat(out), stderr: err };
        if (res.code !== 0 && !opts.allowFail) {
          reject(
            new NovaError('server_error', `git ${args[0] ?? ''} failed: ${firstLine(err)}`, {
              details: { reason: 'git_failed', command: args[0] ?? '', stderr: err.slice(0, 2000) },
            }),
          );
          return;
        }
        resolve(res);
      });
      child.stdin.on('error', () => undefined);
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }

  /** Run and return trimmed stdout as text. */
  async text(args: readonly string[], opts: GitRunOptions): Promise<string> {
    return (await this.run(args, opts)).stdout.toString('utf8').trim();
  }
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? 'unknown error'
  );
}

// ---- the user's repository (read-only bookkeeping) --------------------------------------------

export interface RepoInfo {
  root: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  /** The repository's default branch, when it can be told (defaultBranchOf). */
  defaultBranch: string | null;
}

/** The repository a folder belongs to, or null when it is not in one (CodeSessionView.repo). */
export async function repoInfo(git: HookFreeGit, folder: string): Promise<RepoInfo | null> {
  const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: folder, allowFail: true });
  if (top.code !== 0) return null;
  const root = top.stdout.toString('utf8').trim();
  const [branch, head, status, defaultBranch] = await Promise.all([
    git.run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: folder, allowFail: true }),
    git.run(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: folder, allowFail: true }),
    git.run(['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules'], {
      cwd: folder,
      allowFail: true,
    }),
    defaultBranchOf(git, folder),
  ]);
  return {
    root,
    branch: branch.code === 0 ? branch.stdout.toString('utf8').trim() || null : null,
    head: head.code === 0 ? head.stdout.toString('utf8').trim() || null : null,
    dirty: status.code === 0 && status.stdout.toString('utf8').trim().length > 0,
    defaultBranch,
  };
}

/**
 * The repository's default branch: origin's HEAD when known, else `init.defaultBranch` when
 * that branch exists, else `main` or `master` when one exists; null otherwise.
 */
export async function defaultBranchOf(git: HookFreeGit, folder: string): Promise<string | null> {
  const origin = await git.run(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: folder,
    allowFail: true,
  });
  const fromOrigin = origin.code === 0 ? origin.stdout.toString('utf8').trim() : '';
  if (fromOrigin) return fromOrigin.replace(/^origin\//, '');
  const init = await git.run(['config', '--get', 'init.defaultBranch'], {
    cwd: folder,
    allowFail: true,
  });
  const configured = init.code === 0 ? init.stdout.toString('utf8').trim() : '';
  for (const name of [configured, 'main', 'master']) {
    if (!name) continue;
    const r = await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
      cwd: folder,
      allowFail: true,
    });
    if (r.code === 0) return name;
  }
  return null;
}

/**
 * Whether `branch` is the repository's default: origin's HEAD when known, else
 * `init.defaultBranch`, else `main` or `master`.
 */
export async function isDefaultBranch(
  git: HookFreeGit,
  folder: string,
  branch: string,
): Promise<boolean> {
  const origin = await git.run(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: folder,
    allowFail: true,
  });
  if (origin.code === 0) {
    const name = origin.stdout
      .toString('utf8')
      .trim()
      .replace(/^origin\//, '');
    if (name) return name === branch;
  }
  const init = await git.run(['config', '--get', 'init.defaultBranch'], {
    cwd: folder,
    allowFail: true,
  });
  const configured = init.code === 0 ? init.stdout.toString('utf8').trim() : '';
  if (configured && configured === branch) return true;
  return branch === 'main' || branch === 'master';
}

/** A branch slug for `nova/<slug>` (docs/10 §8). */
export function branchSlug(input: string): string {
  const s = input
    .replace(/^nova\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.lock$/, '')
    .slice(0, 60)
    .replace(/[-.]+$/, '');
  return s || 'change';
}
