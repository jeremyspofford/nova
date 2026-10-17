// Path safety for plugin and skill folders (FR-045, docs/08 §3.1): every path a manifest names
// stays inside its folder, lexically (no absolute paths, no `..`) and after symlinks are
// resolved. Copies refuse links that leave the folder and stop at size limits.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { NovaError } from '@nova/shared';

/** Limits on what one plugin may bring (docs/08 §9: failure isolation starts at install). */
export const PLUGIN_LIMITS = { files: 5000, bytes: 100 * 1024 * 1024, depth: 32 };

/** Folders never copied from a plugin source. */
const SKIPPED = new Set(['.git']);

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve `rel` inside `root` lexically: refuses absolute paths, NUL bytes and anything that
 * climbs out with `..`. `${pluginRoot}/` at the start is accepted and stripped.
 */
export function resolveInside(root: string, rel: string, what = 'path'): string {
  let p = rel.startsWith('${pluginRoot}') ? rel.slice('${pluginRoot}'.length) : rel;
  if (p.startsWith('/') && rel.startsWith('${pluginRoot}')) p = p.slice(1);
  if (p.includes('\0') || isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('\\'))
    throw new NovaError('validation', `${what} must be relative to the plugin folder: ${rel}`);
  const full = resolve(root, normalize(p));
  if (!inside(resolve(root), full))
    throw new NovaError('validation', `${what} leaves the plugin folder: ${rel}`);
  return full;
}

/** Like resolveInside, and the target exists and its real path (symlinks resolved) is inside too. */
export function realInside(root: string, rel: string, what = 'path'): string {
  const full = resolveInside(root, rel, what);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new NovaError('validation', `${what} does not exist: ${rel}`);
  }
  if (!inside(realpathSync(root), real))
    throw new NovaError('validation', `${what} points outside the plugin folder: ${rel}`);
  return full;
}

/** Whether `full` (an existing path) really lives inside `root`, links resolved. */
export function reallyInside(root: string, full: string): boolean {
  try {
    return inside(realpathSync(root), realpathSync(full));
  } catch {
    return false;
  }
}

export interface TreeEntry {
  /** Relative path with `/` separators. */
  path: string;
  /** Absolute path of the bytes (a link inside the tree is followed). */
  source: string;
  size: number;
}

/**
 * Every regular file under `root`, sorted. A symbolic link is followed only when its target is
 * inside `root`; one that leaves it is refused. Limits refuse oversized trees.
 */
export function walkTree(root: string, limits = PLUGIN_LIMITS): TreeEntry[] {
  const realRoot = realpathSync(root);
  const out: TreeEntry[] = [];
  let bytes = 0;
  const visit = (dir: string, depth: number) => {
    if (depth > limits.depth) throw new NovaError('validation', 'the plugin folder is too deep');
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      if (SKIPPED.has(name)) continue;
      const l = lstatSync(full);
      let st = l;
      if (l.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          throw new NovaError('validation', `broken link in the plugin: ${rel}`);
        }
        if (!inside(realRoot, real))
          throw new NovaError('validation', `link points outside the plugin folder: ${rel}`);
        st = statSync(full);
      }
      if (st.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      bytes += st.size;
      out.push({ path: rel, source: full, size: st.size });
      if (out.length > limits.files)
        throw new NovaError('validation', `the plugin has more than ${limits.files} files`);
      if (bytes > limits.bytes)
        throw new NovaError('validation', `the plugin is larger than ${limits.bytes} bytes`);
    }
  };
  visit(root, 0);
  return out;
}

/** SHA-256 over every file's relative path and bytes: what the preview showed is what installs. */
export function treeDigest(entries: readonly TreeEntry[]): string {
  const h = createHash('sha256');
  for (const e of entries) {
    h.update(e.path);
    h.update('\0');
    h.update(readFileSync(e.source));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Copy the walked files into `target` (created 0700), links materialized as plain files. */
export function copyTree(entries: readonly TreeEntry[], target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const e of entries) {
    const to = join(target, ...e.path.split('/'));
    mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(e.source, to);
  }
}

/**
 * Files of a folder relative to it (a skill's file list), sorted and capped. Links that leave the
 * folder and unreadable entries are left out instead of failing the listing.
 */
export function listFiles(root: string, max = 200): string[] {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= max) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= max) return;
      if (SKIPPED.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        if (!inside(realRoot, realpathSync(full))) continue;
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full, depth + 1);
      else if (st.isFile()) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  visit(root, 0);
  return out;
}
