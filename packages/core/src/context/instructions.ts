// Instruction-file discovery (FR-185, docs/09 §11, docs/10 §11). The project root is the nearest
// directory with a root marker (default `.git`), walking up from the working directory; each
// directory from the root down to the working directory contributes at most one file, the first
// that exists of `.nova/instructions.md`, `AGENTS.md`, then the configured fallback names. Files
// are concatenated root first under a heading per directory, within one byte budget (default
// 32 KiB): the file that overflows is truncated, later ones are dropped, and a warning says so.
//
// Safety: fallback names must be plain file names; a file (or a symlink to one) whose real path
// leaves the project root is skipped; each read is capped; markers, names and the budget come
// from user or managed settings only (`instructions.files` is security-relevant, docs/14 §1).
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** `instructions.files` (docs/14 §1). */
export interface InstructionFileSettings {
  rootMarkers: string[];
  fallbackNames: string[];
  budgetBytes: number;
}

export const DEFAULT_INSTRUCTION_FILES: InstructionFileSettings = {
  rootMarkers: ['.git'],
  fallbackNames: [],
  budgetBytes: 32_768,
};

/** The files every directory is checked for, in order, before the fallback names. */
export const INSTRUCTION_FILE_NAMES = ['.nova/instructions.md', 'AGENTS.md'] as const;

/** Directories walked up looking for the project root. */
const MAX_DEPTH = 64;

export interface InstructionFile {
  /** The directory it applies to. */
  dir: string;
  /** The file read. */
  path: string;
  /** Bytes included (after truncation). */
  bytes: number;
  truncated: boolean;
}

export interface DiscoveredInstructions {
  root: string;
  cwd: string;
  files: InstructionFile[];
  /** Files left out because the budget was spent. */
  dropped: string[];
  /** The context section, or null when no file was found. */
  text: string | null;
  /** Set when something was truncated or dropped. */
  warning: string | null;
}

export interface DiscoverOptions extends Partial<InstructionFileSettings> {
  cwd: string;
  /**
   * Directories the walk never goes above (the Hub's own data folder): a working directory inside
   * one of them is its own project root.
   */
  ceilings?: readonly string[];
}

/** A plain file name: no separators, drive letters, network prefixes or dot segments. */
export function isPlainFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    !/[/\\:]/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(name)
  );
}

/** Discover the instruction files for a working directory. Never throws. */
export function discoverInstructions(opts: DiscoverOptions): DiscoveredInstructions {
  const budget = Math.max(0, Math.floor(opts.budgetBytes ?? DEFAULT_INSTRUCTION_FILES.budgetBytes));
  const markers = (opts.rootMarkers ?? DEFAULT_INSTRUCTION_FILES.rootMarkers).filter(
    isPlainFileName,
  );
  const fallbacks = (opts.fallbackNames ?? []).filter(isPlainFileName);
  const empty = (root: string, cwd: string): DiscoveredInstructions => ({
    root,
    cwd,
    files: [],
    dropped: [],
    text: null,
    warning: null,
  });
  let cwd: string;
  try {
    cwd = realpathSync(resolve(opts.cwd));
    if (!statSync(cwd).isDirectory()) return empty(cwd, cwd);
  } catch {
    return empty(opts.cwd, opts.cwd);
  }
  const root = projectRoot(cwd, markers, opts.ceilings ?? []);
  const dirs = chain(root, cwd);
  const names = [...INSTRUCTION_FILE_NAMES, ...fallbacks];
  const found: { dir: string; path: string }[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      if (readableInside(path, root)) {
        found.push({ dir, path });
        break;
      }
    }
  }
  const out = empty(root, cwd);
  if (!found.length) return out;
  let left = budget;
  const sections: string[] = [];
  let truncatedPath: string | null = null;
  for (const f of found) {
    if (left <= 0) {
      out.dropped.push(f.path);
      continue;
    }
    const raw = readCapped(f.path, left + 1);
    if (raw === null) continue;
    let body = raw;
    let truncated = false;
    if (Buffer.byteLength(body, 'utf8') > left) {
      body = cutBytes(body, left);
      truncated = true;
      truncatedPath = f.path;
    }
    const bytes = Buffer.byteLength(body, 'utf8');
    left -= bytes;
    out.files.push({ dir: f.dir, path: f.path, bytes, truncated });
    const label = relative(root, f.dir) || '.';
    const file = relative(f.dir, f.path);
    sections.push(
      `### ${label === '.' ? 'Project root' : label} (${file})\n${body.trim()}${truncated ? '\n[... truncated: the instruction files exceed their budget ...]' : ''}`,
    );
    if (truncated) left = 0;
  }
  if (sections.length) out.text = sections.join('\n\n');
  if (truncatedPath || out.dropped.length) {
    const parts: string[] = [];
    if (truncatedPath) parts.push(`${relative(root, truncatedPath)} was truncated`);
    if (out.dropped.length)
      parts.push(
        `${out.dropped.length} later file${out.dropped.length === 1 ? ' was' : 's were'} left out (${out.dropped.map((d) => relative(root, d)).join(', ')})`,
      );
    out.warning = `Instruction files exceed their ${budget}-byte budget: ${parts.join('; ')}.`;
  }
  return out;
}

/** The nearest directory with a root marker, walking up from `cwd`; `cwd` when none has one. */
function projectRoot(cwd: string, markers: readonly string[], ceilings: readonly string[]): string {
  const stops = ceilings.flatMap((c) => {
    try {
      return [realpathSync(c)];
    } catch {
      return [resolve(c)];
    }
  });
  if (stops.some((s) => within(cwd, s))) return cwd;
  let dir = cwd;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return cwd;
}

/** Directories from `root` down to `cwd`, root first. */
function chain(root: string, cwd: string): string[] {
  const rel = relative(root, cwd);
  if (!rel) return [root];
  const out = [root];
  let dir = root;
  for (const seg of rel.split(sep)) {
    dir = join(dir, seg);
    out.push(dir);
  }
  return out;
}

/** A regular file whose real path is inside `root` (symlinks may not leave it). */
function readableInside(path: string, root: string): boolean {
  try {
    const l = lstatSync(path);
    if (!l.isFile() && !l.isSymbolicLink()) return false;
    const real = realpathSync(path);
    if (!within(real, root)) return false;
    return statSync(real).isFile();
  } catch {
    return false;
  }
}

/** Whether `p` is `dir` or inside it. */
function within(p: string, dir: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** At most `max` bytes of a file as UTF-8; null when it cannot be read. */
function readCapped(path: string, max: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(realpathSync(path), 'r');
    const buf = Buffer.alloc(Math.max(0, max));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The longest prefix of `text` within `max` UTF-8 bytes, never splitting a character. */
function cutBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let end = max;
  // Back up over continuation bytes (10xxxxxx) so a character is never split.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * The user's own instructions (`<dataDir>/instructions.md`, written by import in M4), capped at
 * `maxBytes`; null when there are none. The file must really be inside the data folder.
 */
export function readUserInstructions(
  dataDir: string,
  maxBytes: number,
): { text: string; truncated: boolean } | null {
  const path = join(dataDir, 'instructions.md');
  try {
    const root = realpathSync(dataDir);
    if (!readableInside(path, root)) return null;
  } catch {
    return null;
  }
  const raw = readCapped(path, maxBytes + 1);
  if (!raw?.trim()) return null;
  const truncated = Buffer.byteLength(raw, 'utf8') > maxBytes;
  return { text: (truncated ? cutBytes(raw, maxBytes) : raw).trim(), truncated };
}
