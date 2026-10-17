// Unified diffs of a Code session (FR-064, FR-065): parse Git's patch output into files and
// hunks with stable ids (`<oldStart>-<newStart>`), and build a patch of chosen hunks so Git can
// apply exactly those (accept: to the baseline; reject: reversed, to the work tree). Each file
// keeps its raw header and each hunk its raw text, so a rebuilt patch is byte-identical to what
// Git produced, `\ No newline at end of file` markers included.
import type { CodeChangeView, DiffHunkView } from '@nova/shared';

export interface ParsedDiffHunk extends Omit<DiffHunkView, 'state'> {
  /** The hunk exactly as Git wrote it, header line included, each line ending in `\n`. */
  raw: string;
}

export interface ParsedDiffFile {
  path: string;
  kind: CodeChangeView['kind'];
  oldPath: string | null;
  binary: boolean;
  /** The file's header lines (`diff --git`, modes, `---`/`+++`), without the `index` line. */
  header: string;
  hunks: ParsedDiffHunk[];
  additions: number;
  deletions: number;
}

/** One entry of `git diff-tree -r -z --raw`: modes, blob ids, status and path. */
export interface RawDiffEntry {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  status: string;
  path: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GITLINK = '160000';

/** Parse `git diff-tree -r -z --raw --no-renames` output. */
export function parseRawDiff(out: string): RawDiffEntry[] {
  const parts = out.split('\0');
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1]!;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(meta);
    if (!m) continue;
    entries.push({
      oldMode: m[1]!,
      newMode: m[2]!,
      oldSha: m[3]!,
      newSha: m[4]!,
      status: m[5]!,
      path,
    });
  }
  return entries;
}

/** Split a multi-file patch into its `diff --git` sections, in order. */
export function splitDiffSections(patch: string): string[] {
  const lines = patch.split('\n');
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (l.startsWith('diff --git ')) {
      if (cur) out.push(cur.join('\n'));
      cur = [l];
    } else if (cur) {
      cur.push(l);
    }
  }
  if (cur) out.push(cur.join('\n'));
  return out.map((s) => (s.endsWith('\n') ? s : `${s}\n`));
}

/**
 * Pair the raw entries with the patch sections (Git writes both in the same order) and parse
 * each file. Gitlinks (nested repositories) are left out: their content is not the session's.
 */
export function parseDiff(raw: readonly RawDiffEntry[], patch: string): ParsedDiffFile[] {
  const sections = splitDiffSections(patch);
  const files: ParsedDiffFile[] = [];
  raw.forEach((e, i) => {
    const section = sections[i] ?? '';
    if (e.oldMode === GITLINK || e.newMode === GITLINK) return;
    files.push(parseDiffSection(e, section));
  });
  return files;
}

function kindOf(status: string): CodeChangeView['kind'] {
  if (status === 'A') return 'add';
  if (status === 'D') return 'delete';
  return 'modify';
}

/** Parse one `diff --git` section. */
export function parseDiffSection(e: RawDiffEntry, section: string): ParsedDiffFile {
  const lines = section.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header: string[] = [];
  let i = 0;
  let binary = false;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) binary = true;
    if (l.startsWith('index ')) continue;
    header.push(l);
  }
  const hunks: ParsedDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let cur: ParsedDiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    const m = HUNK.exec(l);
    if (m) {
      const oldStart = Number(m[1]);
      const newStart = Number(m[3]);
      cur = {
        id: `${oldStart}-${newStart}`,
        header: l,
        oldStart,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
        raw: `${l}\n`,
      };
      hunks.push(cur);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (!cur) continue;
    cur.raw += `${l}\n`;
    const c = l[0];
    const text = l.slice(1);
    if (c === '+') {
      cur.lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
      additions++;
    } else if (c === '-') {
      cur.lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null });
      deletions++;
    } else if (c === ' ' || l === '') {
      cur.lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
    }
    // `\ No newline at end of file` stays in `raw` only.
  }
  return {
    path: e.path,
    kind: kindOf(e.status),
    oldPath: null,
    binary,
    header: header.length ? `${header.join('\n')}\n` : '',
    hunks,
    additions,
    deletions,
  };
}

/** A patch of one file with only the chosen hunks, in their original order. */
export function buildHunkPatch(file: ParsedDiffFile, hunkIds: ReadonlySet<string>): string {
  const chosen = file.hunks.filter((h) => hunkIds.has(h.id));
  if (!chosen.length) return '';
  return file.header + chosen.map((h) => h.raw).join('');
}

/** Added line numbers (new side) per file, from a `-U0` patch (the staged diff of a commit). */
export function diffAddedLines(patch: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let path: string | null = null;
  let newNo = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++ ')) {
      const p = l.slice(4);
      path = p === '/dev/null' ? null : unquoteGitPath(p).replace(/^b\//, '');
      if (path && !out.has(path)) out.set(path, new Set());
      continue;
    }
    if (l.startsWith('--- ') || l.startsWith('diff --git ')) continue;
    const m = HUNK.exec(l);
    if (m) {
      newNo = Number(m[3]);
      continue;
    }
    if (!path) continue;
    if (l.startsWith('+')) out.get(path)!.add(newNo++);
    else if (l.startsWith(' ')) newNo++;
  }
  return out;
}

/** Undo Git's C-style quoting of a path (`"a/caf\303\251"`). */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const n = body[++i] ?? '';
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8 };
      bytes.push(map[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
