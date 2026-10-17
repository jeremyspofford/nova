// The Nova patch format used by `fs.edit` (docs/08 §1.3): a plain-text envelope that adds,
// deletes, updates and moves files using context instead of line numbers. A standard unified
// diff is accepted too, with its line numbers treated as hints only. The whole patch is parsed
// and every file computed before anything is written; then it applies all-or-nothing.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { clip, sha256 } from './text.ts';

export const MAX_PATCH_BYTES = 1024 * 1024;

export type PatchErrorCode =
  | 'patch.syntax'
  | 'patch.path_denied'
  | 'patch.file_exists'
  | 'patch.file_missing'
  | 'patch.context_not_found'
  | 'patch.context_ambiguous'
  | 'patch.binary'
  | 'patch.too_large';

export interface PatchErrorDetails {
  /** 1-based line in the patch. */
  line?: number;
  path?: string;
  /** 0-based hunk index within its file section. */
  hunk?: number;
  candidates?: { line: number; preview: string }[];
}

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly details: PatchErrorDetails;
  constructor(code: PatchErrorCode, message: string, details: PatchErrorDetails = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface HunkLine {
  kind: ' ' | '-' | '+';
  text: string;
}

export interface Hunk {
  anchors: string[];
  body: HunkLine[];
  /** The old block must end at the end of the file. */
  eof: boolean;
  line: number;
}

/** Context plus removed lines: what the file must contain. */
export function oldBlock(h: Hunk): string[] {
  return h.body.filter((b) => b.kind !== '+').map((b) => b.text);
}

/** Context plus added lines: what replaces it. */
export function newBlock(h: Hunk): string[] {
  return h.body.filter((b) => b.kind !== '-').map((b) => b.text);
}

export type FileSection =
  | { op: 'add'; path: string; lines: string[]; line: number }
  | { op: 'delete'; path: string; line: number }
  | { op: 'update'; path: string; moveTo: string | null; hunks: Hunk[]; line: number };

// ---- parsing --------------------------------------------------------------------------------

type Marker =
  { kw: 'patch' | 'end' | 'eof' } | { kw: 'add' | 'delete' | 'update' | 'move-to'; path: string };

const BARE = /^%%%[ \t]*(patch|end|eof)$/;
const WITH_PATH = /^%%%[ \t]*(add|delete|update|move-to)[ \t]+(\S(?:.*\S)?)$/;

/** A line whose trimmed text is a complete marker is always a marker (docs/08 §1.3). */
function marker(line: string | undefined): Marker | null {
  if (line === undefined) return null;
  const t = line.trim();
  if (!t.startsWith('%%%')) return null;
  const bare = BARE.exec(t);
  if (bare) return { kw: bare[1] as 'patch' | 'end' | 'eof' };
  const withPath = WITH_PATH.exec(t);
  if (withPath)
    return { kw: withPath[1] as 'add' | 'delete' | 'update' | 'move-to', path: withPath[2]! };
  return null;
}

/** Parse a Nova patch, or a unified diff, into file sections. Throws PatchError. */
export function parsePatch(text: string): FileSection[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_PATCH_BYTES)
    throw new PatchError('patch.too_large', 'the patch is larger than 1 MiB');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  const first = lines[i] ?? '';
  if (/^(---|diff |index |Index: )/.test(first)) return parseUnified(lines, i);
  if (marker(first)?.kw !== 'patch')
    throw new PatchError('patch.syntax', 'a patch starts with the line "%%% patch"', {
      line: i + 1,
    });
  i++;
  const out: FileSection[] = [];
  for (;;) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length)
      throw new PatchError('patch.syntax', 'the patch must end with "%%% end"', { line: i + 1 });
    const m = marker(lines[i]);
    const at = i + 1;
    if (!m) {
      const t = lines[i]!.trim();
      throw new PatchError(
        'patch.syntax',
        t.startsWith('%%%') ? `unknown marker: ${clip(t, 60)}` : 'expected a file section marker',
        { line: at },
      );
    }
    if (m.kw === 'end') {
      i++;
      while (i < lines.length && lines[i]!.trim() === '') i++;
      if (i < lines.length)
        throw new PatchError('patch.syntax', 'text after "%%% end"', { line: i + 1 });
      break;
    }
    if (m.kw === 'add') {
      i++;
      const body: string[] = [];
      while (i < lines.length && !marker(lines[i])) {
        const ln = lines[i]!;
        if (ln.startsWith('+')) body.push(ln.slice(1));
        else if (ln.trim() === '') {
          if (nextIsMarker(lines, i)) break;
          body.push('');
        } else
          throw new PatchError('patch.syntax', 'every line of an added file starts with "+"', {
            line: i + 1,
            path: m.path,
          });
        i++;
      }
      out.push({ op: 'add', path: m.path, lines: body, line: at });
      continue;
    }
    if (m.kw === 'delete') {
      i++;
      out.push({ op: 'delete', path: m.path, line: at });
      continue;
    }
    if (m.kw === 'update') {
      i++;
      let moveTo: string | null = null;
      const mv = marker(lines[i]);
      if (mv?.kw === 'move-to') {
        moveTo = mv.path;
        i++;
      }
      const hunks: Hunk[] = [];
      for (;;) {
        const ln = lines[i];
        if (ln === undefined || marker(ln)) break;
        if (ln.trim() === '') {
          i++;
          continue;
        }
        if (!ln.startsWith('@@'))
          throw new PatchError('patch.syntax', 'expected a hunk starting with "@@"', {
            line: i + 1,
            path: m.path,
          });
        const hunk = parseHunk(lines, i, m.path, hunks.length);
        hunks.push(hunk.hunk);
        i = hunk.next;
      }
      if (!hunks.length && !moveTo)
        throw new PatchError('patch.syntax', 'an update needs at least one hunk', {
          line: at,
          path: m.path,
        });
      out.push({ op: 'update', path: m.path, moveTo, hunks, line: at });
      continue;
    }
    throw new PatchError('patch.syntax', `"%%% ${m.kw}" is not allowed here`, { line: at });
  }
  if (!out.length) throw new PatchError('patch.syntax', 'the patch changes no files', { line: 1 });
  return out;
}

function nextIsMarker(lines: string[], i: number): boolean {
  let j = i;
  while (j < lines.length && lines[j]!.trim() === '') j++;
  return j >= lines.length || marker(lines[j]) !== null;
}

function parseHunk(
  lines: string[],
  start: number,
  path: string,
  index: number,
): { hunk: Hunk; next: number } {
  const anchors: string[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.startsWith('@@')) {
    const a = lines[i]!.slice(2).trim();
    if (a) anchors.push(a);
    i++;
  }
  const body: { kind: ' ' | '-' | '+'; text: string; blank: boolean; line: number }[] = [];
  let eof = false;
  while (i < lines.length) {
    const ln = lines[i]!;
    const m = marker(ln);
    if (m) {
      if (m.kw === 'eof') {
        eof = true;
        i++;
      }
      break;
    }
    if (ln.startsWith('@@')) break;
    const c = ln[0];
    if (ln === '') body.push({ kind: ' ', text: '', blank: true, line: i + 1 });
    else if (c === ' ' || c === '-' || c === '+')
      body.push({ kind: c, text: ln.slice(1), blank: false, line: i + 1 });
    else
      throw new PatchError('patch.syntax', 'a hunk line starts with " ", "-" or "+"', {
        line: i + 1,
        path,
        hunk: index,
      });
    i++;
  }
  // Blank lines after the last hunk line separate sections; they are not context.
  while (body.length && body.at(-1)!.blank) body.pop();
  if (!body.length)
    throw new PatchError('patch.syntax', 'a hunk needs at least one line', {
      line: start + 1,
      path,
      hunk: index,
    });
  return {
    hunk: {
      anchors,
      body: body.map((b) => ({ kind: b.kind, text: b.text })),
      eof,
      line: start + 1,
    },
    next: i,
  };
}

/** A unified diff (`---`/`+++` headers, `@@ -a,b +c,d @@` hunks) as file sections. */
function parseUnified(lines: string[], start: number): FileSection[] {
  const out: FileSection[] = [];
  let i = start;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (!ln.startsWith('--- ')) {
      i++;
      continue;
    }
    const at = i + 1;
    const oldPath = diffPath(ln.slice(4));
    const plus = lines[i + 1];
    if (!plus?.startsWith('+++ '))
      throw new PatchError('patch.syntax', 'a "---" header must be followed by "+++"', {
        line: i + 2,
      });
    const newPath = diffPath(plus.slice(4));
    i += 2;
    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const hunkLine = i + 1;
      i++;
      const body: (HunkLine & { blank: boolean })[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('@@') || b.startsWith('--- ') || b.startsWith('diff ')) break;
        if (b.startsWith('\\')) {
          i++;
          continue;
        }
        const c = b[0];
        if (b === '') body.push({ kind: ' ', text: '', blank: true });
        else if (c === ' ' || c === '-' || c === '+')
          body.push({ kind: c, text: b.slice(1), blank: false });
        else break;
        i++;
      }
      while (body.length && body.at(-1)!.blank) body.pop();
      hunks.push({
        anchors: [],
        body: body.map((b) => ({ kind: b.kind, text: b.text })),
        eof: false,
        line: hunkLine,
      });
    }
    if (oldPath === null && newPath !== null) {
      out.push({ op: 'add', path: newPath, lines: hunks.flatMap(newBlock), line: at });
    } else if (newPath === null && oldPath !== null) {
      out.push({ op: 'delete', path: oldPath, line: at });
    } else if (oldPath !== null && newPath !== null) {
      if (!hunks.length && oldPath === newPath)
        throw new PatchError('patch.syntax', 'a file in the diff has no hunks', {
          line: at,
          path: oldPath,
        });
      out.push({
        op: 'update',
        path: oldPath,
        moveTo: newPath !== oldPath ? newPath : null,
        hunks,
        line: at,
      });
    }
  }
  if (!out.length) throw new PatchError('patch.syntax', 'the diff changes no files');
  return out;
}

/** A diff header path without its timestamp and a/ b/ prefix; null for /dev/null. */
function diffPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

// ---- applying -------------------------------------------------------------------------------

export interface PatchFileResult {
  op: 'add' | 'delete' | 'update' | 'move';
  path: string;
  movedTo?: string;
  added: number;
  removed: number;
  sha256Before: string | null;
  sha256After: string | null;
}

/** Resolves a patch path to an absolute path the tool may write; throws to refuse it. */
export type PatchResolver = (path: string) => string;

interface PlannedWrite {
  abs: string;
  content: string | null;
}

/**
 * Apply parsed sections to the filesystem, all-or-nothing: every file's new content is computed
 * first, then written through temporary files and renamed into place.
 */
export function applyPatch(sections: FileSection[], resolve: PatchResolver): PatchFileResult[] {
  const results: PatchFileResult[] = [];
  const writes: PlannedWrite[] = [];
  const touched = new Set<string>();
  const resolveOrDeny = (p: string, line: number): string => {
    let abs: string;
    try {
      abs = resolve(p);
    } catch (err) {
      throw new PatchError(
        'patch.path_denied',
        err instanceof Error ? err.message : 'path not allowed',
        { line, path: p },
      );
    }
    if (touched.has(abs))
      throw new PatchError('patch.syntax', 'a file appears twice in the patch', { line, path: p });
    touched.add(abs);
    return abs;
  };

  for (const s of sections) {
    const abs = resolveOrDeny(s.path, s.line);
    if (s.op === 'add') {
      if (existsSync(abs))
        throw new PatchError('patch.file_exists', `${s.path} already exists`, {
          line: s.line,
          path: s.path,
        });
      const content = s.lines.length ? `${s.lines.join('\n')}\n` : '';
      writes.push({ abs, content });
      results.push({
        op: 'add',
        path: s.path,
        added: s.lines.length,
        removed: 0,
        sha256Before: null,
        sha256After: sha256(content),
      });
      continue;
    }
    const before = readTarget(abs, s.path, s.line);
    if (s.op === 'delete') {
      writes.push({ abs, content: null });
      results.push({
        op: 'delete',
        path: s.path,
        added: 0,
        removed: before.lines.length,
        sha256Before: sha256(before.raw),
        sha256After: null,
      });
      continue;
    }
    const after = applyHunks(before.lines, s);
    const content = after.lines.join(before.eol) + (before.finalNewline ? before.eol : '');
    let target = abs;
    if (s.moveTo !== null) {
      target = resolveOrDeny(s.moveTo, s.line);
      if (existsSync(target))
        throw new PatchError('patch.file_exists', `${s.moveTo} already exists`, {
          line: s.line,
          path: s.moveTo,
        });
      writes.push({ abs, content: null });
    }
    writes.push({ abs: target, content });
    const r: PatchFileResult = {
      op: s.moveTo !== null ? 'move' : 'update',
      path: s.path,
      added: after.added,
      removed: after.removed,
      sha256Before: sha256(before.raw),
      sha256After: sha256(content),
    };
    if (s.moveTo !== null) r.movedTo = s.moveTo;
    results.push(r);
  }

  commit(writes);
  return results;
}

function readTarget(
  abs: string,
  path: string,
  line: number,
): { raw: Buffer; lines: string[]; eol: string; finalNewline: boolean } {
  if (!existsSync(abs) || !statSync(abs).isFile())
    throw new PatchError('patch.file_missing', `${path} does not exist`, { line, path });
  const raw = readFileSync(abs);
  if (raw.includes(0))
    throw new PatchError('patch.binary', `${path} is a binary file`, { line, path });
  const text = raw.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (finalNewline) lines.pop();
  return { raw, lines, eol, finalNewline };
}

type Normalize = (s: string) => string;
const LEVELS: Normalize[] = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()];

function applyHunks(
  original: string[],
  s: Extract<FileSection, { op: 'update' }>,
): { lines: string[]; added: number; removed: number } {
  const lines = [...original];
  let cursor = 0;
  let added = 0;
  let removed = 0;
  s.hunks.forEach((h, index) => {
    for (const anchor of h.anchors) {
      const found = findAnchor(lines, anchor, cursor);
      if (found < 0)
        throw new PatchError('patch.context_not_found', `anchor not found: ${clip(anchor, 80)}`, {
          line: h.line,
          path: s.path,
          hunk: index,
          candidates: candidates(lines, [anchor], cursor),
        });
      cursor = found + 1;
    }
    const old = oldBlock(h);
    let at: number;
    if (!old.length) {
      at = h.eof ? lines.length : cursor;
    } else {
      const m = findBlock(lines, old, cursor, h.eof);
      if (m === null)
        throw new PatchError(
          'patch.context_not_found',
          `the lines to change were not found in ${s.path}`,
          { line: h.line, path: s.path, hunk: index, candidates: candidates(lines, old, cursor) },
        );
      if (Array.isArray(m))
        throw new PatchError(
          'patch.context_ambiguous',
          `the lines to change match ${m.length} places in ${s.path}; add context or an anchor`,
          {
            line: h.line,
            path: s.path,
            hunk: index,
            candidates: m.slice(0, 3).map((p) => ({ line: p + 1, preview: clip(lines[p]!, 120) })),
          },
        );
      at = m;
    }
    // Context lines keep the file's own text (a match may have ignored whitespace).
    const replacement: string[] = [];
    let k = at;
    for (const b of h.body) {
      if (b.kind === '+') {
        replacement.push(b.text);
        added++;
      } else if (b.kind === '-') {
        k++;
        removed++;
      } else replacement.push(lines[k++]!);
    }
    lines.splice(at, old.length, ...replacement);
    cursor = at + replacement.length;
  });
  return { lines, added, removed };
}

function findAnchor(lines: string[], anchor: string, from: number): number {
  const a = anchor.trim();
  const tests: ((l: string) => boolean)[] = [
    (l) => l === anchor,
    (l) => l.trim() === a,
    (l) => l.trim().startsWith(a),
    (l) => l.includes(a),
  ];
  for (const t of tests) {
    for (let i = from; i < lines.length; i++) if (t(lines[i]!)) return i;
  }
  return -1;
}

/** The match position, a list of positions when ambiguous, or null (docs/08 §1.3 step 3). */
function findBlock(
  lines: string[],
  block: string[],
  from: number,
  eof: boolean,
): number | number[] | null {
  for (const norm of LEVELS) {
    const want = block.map(norm);
    const hits: number[] = [];
    const last = lines.length - block.length;
    const starts = eof ? (last >= from ? [last] : []) : range(from, last);
    for (const p of starts) {
      let ok = true;
      for (let k = 0; k < want.length; k++) {
        if (norm(lines[p + k]!) !== want[k]) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(p);
      if (hits.length > 3) break;
    }
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return hits;
  }
  return null;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** Up to 3 lines resembling the first meaningful line of `block`, nearest to `near`. */
function candidates(
  lines: string[],
  block: string[],
  near: number,
): { line: number; preview: string }[] {
  const probe = block.find((l) => l.trim() !== '')?.trim();
  if (!probe) return [];
  const hits: number[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && (t === probe || t.includes(probe) || probe.includes(t))) hits.push(i);
  });
  return hits
    .sort((a, b) => Math.abs(a - near) - Math.abs(b - near))
    .slice(0, 3)
    .sort((a, b) => a - b)
    .map((i) => ({ line: i + 1, preview: clip(lines[i]!, 120) }));
}

/** Write through temporary files, then rename; deletes go last. Rolls back what it can. */
function commit(writes: PlannedWrite[]): void {
  const staged: { tmp: string; abs: string }[] = [];
  try {
    for (const w of writes) {
      if (w.content === null) continue;
      mkdirSync(dirname(w.abs), { recursive: true });
      const tmp = `${w.abs}.nova-${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, w.content);
      staged.push({ tmp, abs: w.abs });
    }
  } catch (err) {
    for (const s of staged) rmSync(s.tmp, { force: true });
    throw err;
  }
  for (const s of staged) renameSync(s.tmp, s.abs);
  const written = new Set(staged.map((s) => s.abs));
  for (const w of writes) {
    if (w.content === null && !written.has(w.abs)) rmSync(w.abs, { force: true });
  }
}
