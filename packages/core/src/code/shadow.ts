// Change capture with a shadow Git repository (FR-064). Each Code session keeps its own GIT_DIR
// under the data folder whose work tree is the session folder; the user's `.git`, its config
// and its hooks are never touched. A snapshot (`add -A` into the shadow index, `write-tree`)
// records the folder's state; the session's changes are the snapshot against a baseline tree,
// so edits made by tools and by commands (exec.run) are captured the same way. Accepting a hunk
// advances the baseline for it; rejecting one reverse-applies it to the work tree.
//
// Captured: tracked and untracked files, honouring the folder's `.gitignore` files. Never
// captured: protected paths (`.git`, `.nova`, `.agents`), credential locations and dependency
// caches, excluded by pathspec magic so an in-tree negation cannot bring them back. The shadow
// ignores the user's global and system config and neutralizes attributes (no filters, no EOL
// conversion), so snapshots are byte-exact and no configured program ever runs.
//
// M7: the shadow works in any environment. Its Git and files come from a `CodeWorkspace`
// (transport.ts): this Hub's own (the default), or another machine's through its transport, where
// the shadow lives in Nova's state folder there, never inside the user's repository.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NovaError, uuidv7 } from '@nova/shared';
import { parseDiff, parseRawDiff, type ParsedDiffFile } from './diff.ts';
import type { GitRunOptions, HookFreeGit } from './git.ts';
import { nodeWorkFs, type WorkFs } from './transport.ts';

/** Never captured, at any depth (docs/12 §7.2) — plus dependency and tool caches. */
export const UNCAPTURED_PATHS: readonly string[] = [
  '.git',
  '.nova',
  '.agents',
  '.ssh',
  '.gnupg',
  '.git-credentials',
  '.netrc',
  '_netrc',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.kube',
  '.npmrc',
  '.pypirc',
  '.cargo/credentials*',
  '.docker/config.json',
  '.password-store',
  'node_modules',
  '.venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.turbo',
];

/** Pathspecs for `git add`: the whole folder minus the uncaptured locations. */
export function capturePathspecs(): string[] {
  const out = ['.'];
  for (const p of UNCAPTURED_PATHS) {
    out.push(`:(exclude,glob,icase)**/${p}`, `:(exclude,glob,icase)**/${p}/**`);
  }
  return out;
}

const ATTRIBUTES = '* -text -filter -ident !eol !working-tree-encoding !diff !merge\n';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Nova',
  GIT_AUTHOR_EMAIL: 'nova@localhost',
  GIT_COMMITTER_NAME: 'Nova',
  GIT_COMMITTER_EMAIL: 'nova@localhost',
};

export interface ShadowTreeEntry {
  mode: string;
  sha: string;
}

export type ShadowTreeUpdate =
  { path: string; entry: ShadowTreeEntry } | { path: string; remove: true };

export interface ShadowDiff {
  /** The snapshot's tree. */
  tree: string;
  files: ParsedDiffFile[];
  /** The unified patch of every file. */
  patch: string;
}

export class ShadowRepo {
  readonly gitDir: string;
  readonly workTree: string;
  readonly #git: HookFreeGit;
  readonly #fs: WorkFs;

  constructor(opts: { git: HookFreeGit; gitDir: string; workTree: string; fs?: WorkFs }) {
    this.#git = opts.git;
    this.gitDir = opts.gitDir;
    this.workTree = opts.workTree;
    this.#fs = opts.fs ?? nodeWorkFs;
  }

  #opts(extra: Partial<GitRunOptions> = {}): GitRunOptions {
    return {
      cwd: this.workTree,
      gitDir: this.gitDir,
      workTree: this.workTree,
      isolated: true,
      ...extra,
      env: { ...IDENTITY, ...extra.env },
    };
  }

  #run(args: string[], extra: Partial<GitRunOptions> = {}) {
    return this.#git.run(['-c', 'core.quotePath=false', ...args], this.#opts(extra));
  }

  async #text(args: string[], extra: Partial<GitRunOptions> = {}): Promise<string> {
    return (await this.#run(args, extra)).stdout.toString('utf8').trim();
  }

  /** Whether the shadow exists (this Hub's files only; `initialized` works everywhere). */
  get exists(): boolean {
    return existsSync(join(this.gitDir, 'HEAD'));
  }

  async initialized(): Promise<boolean> {
    return (await this.#fs.stat(join(this.gitDir, 'HEAD')))?.kind === 'file';
  }

  /**
   * Create the shadow repository (idempotent). `userExclude` is the folder repository's own
   * `info/exclude`, so files the user keeps out of Git stay out of the session's changes.
   * `alternates` lends it a repository's objects (a short-lived handoff shadow reads HEAD's tree).
   */
  async init(userExclude = '', opts: { alternates?: string } = {}): Promise<void> {
    await this.#assertFolder();
    if (!(await this.initialized())) {
      await this.#fs.mkdir(this.gitDir);
      await this.#run(['init', '--quiet']);
      for (const [k, v] of [
        ['core.autocrlf', 'false'],
        ['core.safecrlf', 'false'],
        ['core.symlinks', 'true'],
        ['gc.auto', '0'],
        ['user.name', 'Nova'],
        ['user.email', 'nova@localhost'],
      ] as const)
        await this.#run(['config', k, v]);
    }
    await this.#fs.writeFile(join(this.gitDir, 'info', 'attributes'), ATTRIBUTES);
    await this.#fs.writeFile(
      join(this.gitDir, 'info', 'exclude'),
      `${UNCAPTURED_PATHS.map((p) => `${p}\n`).join('')}${userExclude ? `${userExclude.trim()}\n` : ''}`,
    );
    if (opts.alternates)
      await this.#fs.writeFile(
        join(this.gitDir, 'objects', 'info', 'alternates'),
        `${opts.alternates}\n`,
      );
  }

  async #assertFolder(): Promise<void> {
    if ((await this.#fs.stat(this.workTree))?.kind !== 'dir')
      throw new NovaError('conflict', `the session folder is missing: ${this.workTree}`, {
        details: { reason: 'folder_missing' },
      });
  }

  /** Record the folder's state; returns the tree id. */
  async snapshot(): Promise<string> {
    await this.#assertFolder();
    await this.#run(['add', '-A', '--ignore-errors', '--', ...capturePathspecs()], {
      allowFail: true,
    }).then((r) => {
      // `--ignore-errors` keeps going past unreadable files; anything else is a real failure.
      if (r.code !== 0 && !/unable to (index|stat)|cannot (open|read)/i.test(r.stderr))
        throw new NovaError('server_error', `capturing changes failed: ${r.stderr.slice(0, 500)}`);
    });
    return this.#text(['write-tree']);
  }

  /** Run Git in the shadow's context: its GIT_DIR, the folder as the work tree (M7). */
  git(args: string[], extra: Partial<GitRunOptions> = {}) {
    return this.#run(args, extra);
  }

  /** Load a tree or commit into the shadow's index (its objects must be reachable). */
  async readTree(treeish: string): Promise<void> {
    await this.#run(['read-tree', treeish]);
  }

  /** A binary-safe patch between two trees (`--binary --full-index`, FR-213). */
  async binaryPatch(from: string, to: string): Promise<Buffer> {
    const r = await this.#run([
      'diff-tree',
      '-r',
      '-p',
      '--binary',
      '--full-index',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      from,
      to,
    ]);
    return r.stdout;
  }

  /** The paths that differ between two trees. */
  async changedPaths(from: string, to: string): Promise<string[]> {
    const r = await this.#run(['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to]);
    return r.stdout
      .toString('utf8')
      .split('\0')
      .filter((p) => p.length > 0);
  }

  /** Apply a patch to the work tree with neutral attributes; false (and why) when it does not. */
  async applyToWorkTree(patch: Buffer | string): Promise<{ ok: boolean; stderr: string }> {
    const r = await this.#run(['apply', '--binary', '--whitespace=nowarn', '-'], {
      input: patch,
      allowFail: true,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /**
   * Put paths of the work tree back to a commit's content (its objects reachable through the
   * shadow's alternates); paths absent there are removed. Writes never follow a symlink out.
   */
  async restoreFrom(commit: string, paths: readonly string[]): Promise<void> {
    const present: string[] = [];
    for (const p of paths) {
      if (await this.entry(commit, p)) present.push(p);
      else await this.#removeFile(p);
    }
    for (let i = 0; i < present.length; i += 200)
      await this.#run(['checkout', commit, '--', ...present.slice(i, i + 200)]);
  }

  /** The tree a named ref (`baseline`, `start`) points at, or null. */
  async ref(name: string): Promise<string | null> {
    const r = await this.#run(['rev-parse', '-q', '--verify', `refs/nova/${name}^{tree}`], {
      allowFail: true,
    });
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  }

  /** The commit a named ref points at (for `checkout <commit> -- path`). */
  async #commitOf(name: string): Promise<string> {
    return this.#text(['rev-parse', '--verify', `refs/nova/${name}^{commit}`]);
  }

  /** Point a named ref at a tree (wrapped in a commit, so Git keeps it). */
  async setRef(name: string, tree: string): Promise<void> {
    const commit = await this.#text(['commit-tree', tree, '-m', `nova ${name}`]);
    await this.#run(['update-ref', `refs/nova/${name}`, commit]);
  }

  /** The files that differ between two trees, parsed into hunks. */
  async diff(from: string, to: string): Promise<ParsedDiffFile[]> {
    return (await this.diffWithPatch(from, to)).files;
  }

  async diffWithPatch(
    from: string,
    to: string,
  ): Promise<{ files: ParsedDiffFile[]; patch: string }> {
    const raw = await this.#run(['diff-tree', '-r', '-z', '--raw', '--no-renames', from, to]);
    const entries = parseRawDiff(raw.stdout.toString('utf8'));
    if (!entries.length) return { files: [], patch: '' };
    const patch = (
      await this.#run([
        'diff-tree',
        '-r',
        '-p',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '-U3',
        from,
        to,
      ])
    ).stdout.toString('utf8');
    return { files: parseDiff(entries, patch), patch };
  }

  /** The baseline against a fresh snapshot of the work tree. */
  async changes(baseline = 'baseline'): Promise<ShadowDiff> {
    const tree = await this.snapshot();
    const base = (await this.ref(baseline)) ?? tree;
    const { files, patch } = await this.diffWithPatch(base, tree);
    return { tree, files, patch };
  }

  /** One path's entry in a tree, or null when absent. */
  async entry(tree: string, path: string): Promise<ShadowTreeEntry | null> {
    const out = await this.#run(['ls-tree', '-z', '--full-tree', tree, '--', path]);
    const line = out.stdout.toString('utf8').split('\0')[0];
    const m = line ? /^(\d{6}) \w+ ([0-9a-f]+)\t/.exec(line) : null;
    return m ? { mode: m[1]!, sha: m[2]! } : null;
  }

  async blob(sha: string): Promise<Buffer> {
    return (await this.#run(['cat-file', 'blob', sha])).stdout;
  }

  /** A tree with some entries replaced or removed (a temporary index; nothing else changes). */
  async updateTree(base: string, updates: readonly ShadowTreeUpdate[]): Promise<string> {
    return this.#withIndex(base, async (opts) => {
      for (const u of updates) {
        if ('remove' in u) await this.#run(['update-index', '--force-remove', '--', u.path], opts);
        else
          await this.#run(
            ['update-index', '--add', '--cacheinfo', `${u.entry.mode},${u.entry.sha},${u.path}`],
            opts,
          );
      }
    });
  }

  /** Apply a patch to a tree (accepting hunks into the baseline); returns the new tree. */
  async applyToTree(base: string, patch: string): Promise<string> {
    return this.#withIndex(base, async (opts) => {
      const r = await this.#run(['apply', '--cached', '--whitespace=nowarn', '-'], {
        ...opts,
        input: patch,
        allowFail: true,
      });
      if (r.code !== 0)
        throw new NovaError('conflict', 'the hunks no longer apply; reload the changes', {
          details: { reason: 'stale_hunk', stderr: r.stderr.slice(0, 1000) },
        });
    });
  }

  async #withIndex(
    base: string,
    fn: (opts: Partial<GitRunOptions>) => Promise<void>,
  ): Promise<string> {
    const indexFile = join(this.gitDir, `tmp-index-${uuidv7()}`);
    const opts = { indexFile };
    try {
      await this.#run(['read-tree', base], opts);
      await fn(opts);
      return await this.#text(['write-tree'], opts);
    } finally {
      await this.#fs.remove(indexFile);
    }
  }

  /** Reverse-apply a patch to the work tree (rejecting hunks). */
  async reverseInWorkTree(patch: string): Promise<void> {
    const r = await this.#run(['apply', '-R', '--whitespace=nowarn', '-'], {
      input: patch,
      allowFail: true,
    });
    if (r.code !== 0)
      throw new NovaError('conflict', 'the file changed since the diff was shown; reload it', {
        details: { reason: 'stale_hunk', stderr: r.stderr.slice(0, 1000) },
      });
  }

  /**
   * Put paths of the work tree back to a named ref's content; paths absent there are removed.
   * Writes never follow a symlink out of the folder.
   */
  async restore(name: string, paths: readonly string[]): Promise<void> {
    const tree = await this.ref(name);
    if (!tree) throw new NovaError('conflict', 'the session has no baseline');
    const commit = await this.#commitOf(name);
    const present: string[] = [];
    for (const p of paths) {
      if (await this.entry(tree, p)) present.push(p);
      else await this.#removeFile(p);
    }
    for (let i = 0; i < present.length; i += 200) {
      await this.#run(['checkout', commit, '--', ...present.slice(i, i + 200)]);
    }
  }

  async #removeFile(rel: string): Promise<void> {
    await this.#fs.removeWithin(this.workTree, rel);
  }

  /** Files Git sees in the folder (tracked and untracked, ignores honoured), for the index. */
  async listFiles(): Promise<string[]> {
    const tree = await this.snapshot();
    const out = await this.#run(['ls-tree', '-r', '-z', '--name-only', '--full-tree', tree]);
    return out.stdout
      .toString('utf8')
      .split('\0')
      .filter((p) => p.length > 0);
  }

  async remove(): Promise<void> {
    await this.#fs.remove(this.gitDir, true);
  }
}

/** The user's `info/exclude` of the repository a folder is in, if any (best effort). */
export async function repoUserExcludes(
  git: HookFreeGit,
  folder: string,
  fs: WorkFs = nodeWorkFs,
): Promise<string> {
  const r = await git.run(['rev-parse', '--git-path', 'info/exclude'], {
    cwd: folder,
    allowFail: true,
  });
  if (r.code !== 0) return '';
  const p = r.stdout.toString('utf8').trim();
  const path = p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : join(folder, p);
  try {
    if (fs === nodeWorkFs) return await readFile(path, 'utf8');
    return (await fs.readFile(path, 1024 * 1024)).toString('utf8');
  } catch {
    return '';
  }
}
