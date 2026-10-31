// Folders as Nova reads them for a coding run (M10c): a walk that never follows a link, the plain
// copy the coding agent works in, the comparison with the base, and applying a change to the
// worktree. A coding agent runs as the person, so what it leaves is read as data: links are kept as
// links (their target as written), and anything that isn't a plain file, a folder or a link is
// refused, never opened.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, posix } from 'node:path';
import { CoreError } from '../errors.ts';
import { safePath } from '../providers/taskspace.ts';

export interface Entry { kind: 'file' | 'link'; exec: boolean; size: number; hash: string; target?: string }
export type Snapshot = Map<string, Entry>;
export interface Walk { entries: Snapshot; refused: { path: string; why: string }[]; bytes: number }
export interface Change { path: string; kind: 'added' | 'modified' | 'deleted'; entry: Entry | null }

// What one run takes from an agent at most (the provider registry's caps).
export const MAX_CHANGES = 200;
export const MAX_CHANGE_BYTES = 50 * 1024 * 1024;
// A tree Nova walks at most: more, and it stops and says so.
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const isGit = (rel: string) => rel.split('/').some((p) => p === '.git');

// Reads a regular file without following a link, and only if it is still the file that was listed.
function readPlain(abs: string, listed: { dev: number; ino: number }): Buffer {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== listed.dev || st.ino !== listed.ino) throw new CoreError('conflict', `${abs} changed while Nova read it.`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Every file and link under `root`, by forward-slash path. `top`: whether the root's own `.git`
// (a worktree's pointer file) is left out; any other `.git` is refused, as are hard links (a file
// that is also somewhere else), FIFOs, sockets and devices.
export function walk(root: string, o: { skipTopGit?: boolean } = {}): Walk {
  const entries: Snapshot = new Map();
  const refused: Walk['refused'] = [];
  let bytes = 0;
  let count = 0;
  const go = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new CoreError('validation', `The folder is nested more than ${MAX_DEPTH} levels deep at ${rel}; Nova stopped there.`);
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const abs = join(dir, name);
      if (++count > MAX_ENTRIES) throw new CoreError('validation', `The folder holds more than ${MAX_ENTRIES} entries; Nova stopped there.`);
      if (!rel && name === '.git' && o.skipTopGit) continue;
      if (name === '.git') { refused.push({ path: r, why: 'it is git’s own folder or file, which an agent never changes' }); continue; }
      const st = lstatSync(abs);
      if (st.isDirectory()) { go(abs, r, depth + 1); continue; }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(abs);
        entries.set(r, { kind: 'link', exec: false, size: target.length, hash: sha(`link:${target}`), target });
        continue;
      }
      if (!st.isFile()) { refused.push({ path: r, why: 'it is not a plain file (a FIFO, socket or device)' }); continue; }
      if (st.nlink > 1) { refused.push({ path: r, why: 'it is a hard link to a file somewhere else' }); continue; }
      const data = readPlain(abs, st);
      bytes += data.length;
      entries.set(r, { kind: 'file', exec: (st.mode & 0o111) !== 0, size: data.length, hash: sha(data) });
    }
  };
  go(root, '', 0);
  return { entries, refused, bytes };
}

// One hash for a whole walk: each path, kind, mode and content.
export function digest(s: Snapshot): string {
  return sha([...s.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, e]) => `${p}\0${e.kind}\0${e.exec ? 'x' : '-'}\0${e.hash}`).join('\n'));
}

// What differs between two walks.
export function changes(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = [];
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(p);
    const b = after.get(p);
    if (!a && b) out.push({ path: p, kind: 'added', entry: b });
    else if (a && !b) out.push({ path: p, kind: 'deleted', entry: null });
    else if (a && b && (a.kind !== b.kind || a.hash !== b.hash || a.exec !== b.exec)) out.push({ path: p, kind: 'modified', entry: b });
  }
  return out;
}

// Whether a link's target, as written, stays inside the folder it is in.
export function linkStaysInside(path: string, target: string): boolean {
  if (!target || isAbsolute(target) || target.includes('\0') || target.includes('\\')) return false;
  const joined = posix.normalize(posix.join(posix.dirname(path), target));
  return joined !== '..' && !joined.startsWith('../') && joined !== '.' && !joined.startsWith('/') && !isGit(joined);
}

// The changes Nova won't take, in plain words (null when there are none), before anything is
// written: git's own files, links that leave the folder, the caps.
export function refusals(cs: Change[], walked: Walk): string | null {
  const bad: string[] = walked.refused.map((r) => `${r.path} (${r.why})`);
  for (const c of cs) {
    if (isGit(c.path)) bad.push(`${c.path} (it is git’s own, which an agent never changes)`);
    if (c.entry?.kind === 'link' && !linkStaysInside(c.path, c.entry.target ?? '')) bad.push(`${c.path} (a link to ${JSON.stringify(c.entry.target ?? '').slice(0, 80)}, outside the repository)`);
  }
  if (bad.length) return `Nova refused the work: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? `; and ${bad.length - 5} more` : ''}. Nothing was committed.`;
  const bytes = cs.reduce((n, c) => n + (c.entry?.kind === 'file' ? c.entry.size : 0), 0);
  if (cs.length > MAX_CHANGES || bytes > MAX_CHANGE_BYTES) return `The agent changed ${cs.length} file${cs.length === 1 ? '' : 's'} (${Math.ceil(bytes / 1024 / 1024)} MB). Nova takes at most ${MAX_CHANGES} files and ${MAX_CHANGE_BYTES / 1024 / 1024} MB from one run. Nothing was committed.`;
  return null;
}

// Copies the walk of `from` into the empty folder `to`: files with their mode, links as links.
export function copyWalk(from: string, s: Snapshot, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const [rel, e] of s) {
    const dest = join(to, ...rel.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    if (e.kind === 'link') { symlinkSync(e.target!, dest); continue; }
    const src = join(from, ...rel.split('/'));
    const data = readPlain(src, lstatSync(src));
    if (sha(data) !== e.hash) throw new CoreError('conflict', `${rel} changed while Nova copied it.`);
    writeFileSync(dest, data, { mode: e.exec ? 0o755 : 0o644, flag: 'wx' });
  }
}

// Takes the agent's changes (read from `work`) into the worktree, through no link: every path is
// checked first (safePath refuses one that runs through a link), then deletions, then writes.
export function applyChanges(work: string, tree: string, cs: Change[]): void {
  const planned = cs.map((c) => {
    const at = safePath(tree, c.path);
    let data: Buffer | null = null;
    if (c.entry?.kind === 'file') {
      const src = join(work, ...c.path.split('/'));
      data = readPlain(src, lstatSync(src));
      if (sha(data) !== c.entry.hash) throw new CoreError('conflict', `${c.path} changed in the agent’s folder after Nova read it. Nothing was committed.`);
    }
    return { c, abs: at.abs, data };
  });
  const there = (abs: string) => { try { return lstatSync(abs); } catch { return null; } };
  // What goes or is replaced is removed first (a file that becomes a folder, or the other way, works).
  for (const p of planned) {
    const st = there(p.abs);
    if (st && !st.isDirectory()) unlinkSync(p.abs);
    if (p.c.kind === 'deleted') {
      // Folders left empty go too, as git would leave them.
      let d = dirname(p.abs);
      while (normalize(d) !== normalize(tree)) { try { rmdirSync(d); } catch { break; } d = dirname(d); }
    }
  }
  for (const p of planned) {
    if (p.c.kind === 'deleted') continue;
    if (there(p.abs)?.isDirectory()) throw new CoreError('conflict', `${p.c.path} is still a folder in the worktree; Nova doesn’t replace a folder that has files with a file.`);
    mkdirSync(dirname(p.abs), { recursive: true });
    // The parent folders were just made by Nova, or were checked by safePath: none is a link.
    if (p.c.entry!.kind === 'link') symlinkSync(p.c.entry!.target!, p.abs);
    else { writeFileSync(p.abs, p.data!, { flag: 'wx', mode: p.c.entry!.exec ? 0o755 : 0o644 }); chmodSync(p.abs, p.c.entry!.exec ? 0o755 : 0o644); }
  }
}
