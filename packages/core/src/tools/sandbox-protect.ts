// Protected paths inside a command sandbox (FR-190, docs/12 §7.2). The file tools check them in
// the policy engine; a command sees whole folders, so every substrate also enforces them with
// mounts: inside a writable root `.git`, `.nova`, `.agents` and the shell startup files are bound
// read-only, and in every root the credential locations and the Nova data directory are hidden
// (an empty folder, or /dev/null for a file). The Hub's own Git calls read `.git/config` outside
// any sandbox, so a command that could write it could make the Hub run a program.
//
// Locations are looked for in each root and in every folder from the root down to the command's
// working directory, case-insensitively. A location that does not exist when the command starts
// is not covered: a mount point would have to be created on the host. Mount points cannot be
// renamed or deleted from inside, so a protected folder cannot be swapped out.
//
// Nova's own Git invocation (the commit that runs the repository's hooks, FR-211) asks for
// `gitWrite`: `.git` is then writable except its `config`, `hooks` and `info`.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { CREDENTIAL_LOCATIONS, READ_ONLY_LOCATIONS } from '@nova/policy';

export type SandboxMount =
  | { kind: 'root'; path: string; writable: boolean }
  | { kind: 'read_only'; path: string }
  | { kind: 'hide_dir'; path: string }
  | { kind: 'hide_file'; path: string };

export interface SandboxMountInput {
  /** The roots the substrate mounts (it has already dropped the ones it never mounts). */
  roots: readonly { path: string; access: 'read' | 'write' }[];
  cwd: string;
  /** Nova's own Git invocation: `.git` writable except `config`, `hooks` and `info`. */
  gitWrite?: boolean;
  /** Folders hidden wherever a root contains them (the Nova data directory). */
  deniedPaths?: readonly string[];
}

/** Inside `.git`, these stay read-only even for Nova's own Git invocation (docs/12 §7.2). */
export const GIT_CONTROL_FILES = ['config', 'config.worktree', 'hooks', 'info'];

function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

function depth(p: string): number {
  return p.split(sep).filter(Boolean).length;
}

type Lister = (dir: string) => string[];

/** A directory lister that reads each folder once per command. */
function lister(): Lister {
  const seen = new Map<string, string[]>();
  return (dir) => {
    let names = seen.get(dir);
    if (!names) {
      try {
        names = readdirSync(dir);
      } catch {
        names = [];
      }
      seen.set(dir, names);
    }
    return names;
  };
}

/** Entries of `dir` whose name matches `seg` case-insensitively (`*` at the end is a prefix). */
function matching(dir: string, seg: string, list: Lister): string[] {
  const names = list(dir);
  const want = seg.toLowerCase();
  const prefix = want.endsWith('*') ? want.slice(0, -1) : null;
  return names
    .filter((n) => {
      const l = n.toLowerCase();
      return prefix === null ? l === want : l.startsWith(prefix);
    })
    .map((n) => resolve(dir, n));
}

/** Paths under `dir` that match a location (several on a case-sensitive filesystem). */
function locate(dir: string, loc: readonly string[], list: Lister): string[] {
  let found = [dir];
  for (const seg of loc) found = found.flatMap((d) => matching(d, seg, list));
  return found;
}

/** The folders checked for a root: the root and each folder down to the working directory. */
function chain(root: string, cwd: string): string[] {
  const out = [root];
  if (cwd === root || !within(cwd, root)) return out;
  const rest = cwd.slice(root.length).split(sep).filter(Boolean);
  let cur = root;
  for (const seg of rest) {
    cur = resolve(cur, seg);
    out.push(cur);
  }
  return out;
}

/** The real target of `p` when it is mounted in the sandbox, its kind; null when it is not. */
function target(
  p: string,
  roots: readonly { path: string }[],
): { path: string; dir: boolean } | null {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return null;
  }
  let path = p;
  if (st.isSymbolicLink()) {
    try {
      path = realpathSync(p);
      st = statSync(path);
    } catch {
      return null;
    }
    // A link to somewhere outside every root points at nothing inside the sandbox.
    if (!roots.some((r) => within(path, r.path))) return null;
  }
  return { path, dir: st.isDirectory() };
}

/** The Git directory a `.git` file (a linked worktree or submodule) points to. */
function gitdirOf(file: string): string | null {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(file, 'utf8').slice(0, 4096));
    if (!m?.[1]) return null;
    return isAbsolute(m[1]) ? resolve(m[1]) : resolve(dirname(file), m[1]);
  } catch {
    return null;
  }
}

/**
 * The mounts for one command, parents before children: the roots, then the protected paths in
 * them. Substrates translate each kind to their own mount syntax, in this order.
 */
export function sandboxMounts(input: SandboxMountInput): SandboxMount[] {
  const roots = input.roots.map((r) => ({ path: resolve(r.path), access: r.access }));
  const writable = roots.filter((r) => r.access === 'write');
  const cwd = resolve(input.cwd);
  const hidden = new Map<string, boolean>();
  const readOnly = new Set<string>();
  const list = lister();

  const protectGitDir = (gitDir: string) => {
    if (!writable.some((r) => within(gitDir, r.path))) return;
    if (!input.gitWrite) {
      readOnly.add(gitDir);
      return;
    }
    for (const name of GIT_CONTROL_FILES) {
      const t = target(resolve(gitDir, name), roots);
      if (t) readOnly.add(t.path);
    }
  };

  for (const root of roots) {
    for (const dir of chain(root.path, cwd)) {
      for (const loc of CREDENTIAL_LOCATIONS) {
        for (const p of locate(dir, loc, list)) {
          const t = target(p, roots);
          if (t) hidden.set(t.path, t.dir);
        }
      }
      if (root.access !== 'write') continue;
      for (const loc of READ_ONLY_LOCATIONS) {
        for (const p of locate(dir, loc, list)) {
          const t = target(p, roots);
          if (!t) continue;
          if (loc.length !== 1 || loc[0] !== '.git') {
            readOnly.add(t.path);
            continue;
          }
          if (t.dir) {
            protectGitDir(t.path);
            continue;
          }
          // A `.git` file: the file itself, the Git directory it names and that directory's
          // common directory (where a linked worktree's config and hooks live).
          readOnly.add(t.path);
          const gitDir = gitdirOf(t.path);
          if (!gitDir) continue;
          const real = target(gitDir, roots);
          if (!real?.dir) continue;
          protectGitDir(real.path);
          try {
            const common = readFileSync(resolve(real.path, 'commondir'), 'utf8').trim();
            const c = target(isAbsolute(common) ? common : resolve(real.path, common), roots);
            if (c?.dir) protectGitDir(c.path);
          } catch {
            // Not a linked worktree.
          }
        }
      }
    }
  }
  for (const d of input.deniedPaths ?? []) {
    const p = resolve(d);
    if (!roots.some((r) => within(p, r.path))) continue;
    const t = target(p, roots);
    if (t) hidden.set(t.path, t.dir);
  }

  const mounts: SandboxMount[] = roots.map((r) => ({
    kind: 'root',
    path: r.path,
    writable: r.access === 'write',
  }));
  for (const p of readOnly) if (!hidden.has(p)) mounts.push({ kind: 'read_only', path: p });
  for (const [p, dir] of hidden) mounts.push({ kind: dir ? 'hide_dir' : 'hide_file', path: p });
  // Parents first; at equal depth, roots before the protections on them (the sort is stable).
  return mounts
    .map((m, i) => ({ m, i, d: depth(m.path) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.m);
}
