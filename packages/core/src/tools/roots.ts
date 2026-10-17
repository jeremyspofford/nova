// Path containment for the file and exec tools (FR-190, docs/12 §7.2). Every path resolves to a
// real path inside one of the turn's roots, with no `..` or symlink escape. This is defence in
// depth: the policy engine decides whether a call may run; these checks make sure a call that
// runs cannot reach outside what the permission profile granted, whatever the policy said.
import { relative, sep } from 'node:path';
import { CREDENTIAL_LOCATIONS, READ_ONLY_LOCATIONS, matchesLocation } from '@nova/policy';
import { PathEscapeError, isWithin, realpathLenient, resolveWithin } from '@nova/security';
import type { ToolRoot } from './types.ts';

// The protected and credential locations are the policy package's (docs/12 §7.2), so the
// engine and these checks protect the same paths.

/** A segment as protection compares it: case-insensitive, without Windows variants. */
function fold(seg: string): string {
  const s = seg.toLowerCase().replace(/:.*$/, '');
  const trimmed = s.replace(/[. ]+$/, '');
  return trimmed === '' ? s : trimmed;
}

export interface PathPolicy {
  /** Directories no tool may touch, even inside a root (the Nova data directory). */
  denied?: readonly string[];
  /** Exceptions inside a denied directory (the Hub workspace lives in the data directory). */
  allowed?: readonly string[];
  /** Paths the permission profile denies, without exceptions (FR-190). */
  deny?: readonly string[];
}

export interface ResolvedPath {
  /** Canonical absolute path. */
  path: string;
  root: ToolRoot;
  /** Path relative to its root, with `/` separators ('' for the root itself). */
  rel: string;
}

export class PathDenied extends Error {
  readonly code = 'path_denied';
  readonly input: string;
  constructor(input: string, reason: string) {
    super(`${reason}: ${input}`);
    this.input = input;
  }
}

/**
 * Resolve `input` (relative to the first root, or absolute inside a root) for `need` access.
 * Throws PathDenied when the path escapes, the root grants only reading, or the path is
 * protected.
 */
export function resolveInRoots(
  roots: readonly ToolRoot[],
  input: string,
  need: 'read' | 'write',
  policy: PathPolicy = {},
): ResolvedPath {
  if (!roots.length) throw new PathDenied(input, 'no folders are available to tools');
  if (typeof input !== 'string' || input.length > 4096)
    throw new PathDenied(String(input), 'invalid path');
  const raw = input.trim() === '' ? '.' : input.trim();
  let real: string;
  try {
    real = resolveWithin(
      roots.map((r) => r.path),
      raw,
      roots[0]!.path,
    );
  } catch (err) {
    if (err instanceof PathEscapeError) throw new PathDenied(input, 'outside the allowed folders');
    throw err;
  }
  // The most specific root containing the path decides its access.
  let best: { root: ToolRoot; real: string } | null = null;
  for (const root of roots) {
    const rootReal = realpathLenient(root.path);
    if (!isWithin(rootReal, real)) continue;
    if (!best || rootReal.length > best.real.length) best = { root, real: rootReal };
  }
  if (!best) throw new PathDenied(input, 'outside the allowed folders');
  const rel = relative(best.real, real).split(sep).join('/');
  const denied = policy.denied ?? [];
  const allowed = policy.allowed ?? [];
  for (const d of denied) {
    const dReal = realpathLenient(d);
    if (isWithin(dReal, real) && !allowed.some((a) => isWithin(realpathLenient(a), real)))
      throw new PathDenied(input, 'the Nova data folder is not available to tools');
  }
  for (const d of policy.deny ?? []) {
    if (isWithin(realpathLenient(d), real))
      throw new PathDenied(input, 'the permission profile denies this path');
  }
  const parts = rel ? rel.split('/') : [];
  if (isCredentialPath(real)) throw new PathDenied(input, 'credential files are not available');
  if (need === 'write') {
    if (best.root.access !== 'write')
      throw new PathDenied(input, `the folder "${best.root.label}" is read-only for tools`);
    if (isProtectedRel(parts)) throw new PathDenied(input, 'protected path (read-only)');
  }
  return { path: real, root: best.root, rel };
}

/** Whether an absolute path, or a path relative to a root, names a credential location. */
export function isCredentialPath(path: string): boolean {
  return isCredentialRel(path.split(/[\\/]/).filter(Boolean));
}

export function isCredentialRel(parts: readonly string[]): boolean {
  return matchesLocation(parts.map(fold), CREDENTIAL_LOCATIONS) !== null;
}

/** Whether a path relative to a writable root stays read-only (`.git`, shell startup files). */
export function isProtectedRel(parts: readonly string[]): boolean {
  return matchesLocation(parts.map(fold), READ_ONLY_LOCATIONS) !== null;
}

/** Whether a directory entry should be hidden from listings and searches. */
export function hiddenFromTools(parts: readonly string[]): boolean {
  return isCredentialRel(parts);
}

/**
 * A path as tools report it: relative to the first root (where relative paths resolve), else
 * absolute, so the model can pass it back unchanged.
 */
export function displayPath(roots: readonly ToolRoot[], p: ResolvedPath): string {
  if (p.root === roots[0]) return p.rel || '.';
  return p.path;
}
