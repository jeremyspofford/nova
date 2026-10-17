// Path containment for tools and the sandbox broker (docs/11 §3 step 1, docs/12 §7, FR-190).
// A path is accepted only if, after resolving `..` and symlinks, it stays inside an allowed root.
import { realpathSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, basename } from 'node:path';

export class PathEscapeError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`path rejected (${reason}): ${path}`);
    this.name = 'PathEscapeError';
    this.path = path;
  }
}

/** True if `child` is `parent` or inside it. Both must be absolute and normalized. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** Real path of `p`, or of its nearest existing ancestor joined with the missing tail. */
export function realpathLenient(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync.native(current) : current;
  return tail.length ? resolve(base, ...tail) : base;
}

/**
 * Resolve `input` against `cwd` and return its real path if it lies within one of `roots`.
 * Rejects NUL bytes, and escapes through `..` or symlinks. Roots are canonicalized too.
 */
export function resolveWithin(
  roots: readonly string[],
  input: string,
  cwd = roots[0] ?? process.cwd(),
): string {
  if (input.includes('\0')) throw new PathEscapeError(input, 'nul byte');
  if (roots.length === 0) throw new PathEscapeError(input, 'no allowed roots');
  const real = realpathLenient(resolve(cwd, input));
  for (const root of roots) {
    if (isWithin(realpathLenient(root), real)) return real;
  }
  throw new PathEscapeError(input, 'outside allowed roots');
}

/**
 * Protected paths stay read-only inside writable roots (FR-190): VCS metadata, Nova's own
 * folders, and credential stores.
 */
export const PROTECTED_SEGMENTS: readonly string[] = ['.git', '.nova', '.agents'];
export const CREDENTIAL_SEGMENTS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
];

export function isProtectedPath(absPath: string, writableRoot: string): boolean {
  const rel = relative(writableRoot, absPath);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  return parts.some((part) => PROTECTED_SEGMENTS.includes(part));
}

export function isCredentialPath(absPath: string, home: string): boolean {
  if (!isWithin(home, absPath)) return false;
  const rel = relative(home, absPath).split(sep).join('/');
  return CREDENTIAL_SEGMENTS.some((seg) => rel === seg || rel.startsWith(`${seg}/`));
}
