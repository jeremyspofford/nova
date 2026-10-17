// Pure helpers for the Diff pane (FR-064): pairing removed and added lines of a hunk, rows for the
// split view, word-level differences inside a modified line, and totals. Nothing here looks at
// syntax: highlighting is by change kind only, so every language reads the same.
import type { CodeChangeView, DiffHunkView } from '@nova/shared';

export type DiffLine = DiffHunkView['lines'][number];

/** A run of a line's text, marked when it differs from the paired line. */
export interface Segment {
  text: string;
  changed: boolean;
}

/** Words, runs of whitespace and single punctuation marks. */
export function tokenize(text: string): string[] {
  return text.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/** Longer lines are shown without word marks: the table would cost more than it shows. */
const MAX_TOKENS = 400;

/**
 * Word-level difference between a removed line and the added line that replaces it, or null
 * when they share nothing (the whole line is the change) or are too long to compare.
 */
export function wordDiff(before: string, after: string): { old: Segment[]; new: Segment[] } | null {
  const a = tokenize(before);
  const b = tokenize(after);
  if (!a.length || !b.length || a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  // Longest common subsequence over tokens; table[i][j] is the LCS of a[i..] and b[j..].
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]!;
    const below = table[i + 1]!;
    for (let j = b.length - 1; j >= 0; j--)
      row[j] = a[i] === b[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
  }
  const common = table[0]![0]!;
  // Nothing but whitespace in common: marking every word would only add noise.
  if (common === 0) return null;
  const oldSegs: Segment[] = [];
  const newSegs: Segment[] = [];
  const push = (list: Segment[], text: string, changed: boolean) => {
    const last = list.at(-1);
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(oldSegs, a[i]!, false);
      push(newSegs, b[j]!, false);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      push(newSegs, b[j]!, true);
      j++;
    } else {
      push(oldSegs, a[i]!, true);
      i++;
    }
  }
  if (!oldSegs.some((s) => s.changed) && !newSegs.some((s) => s.changed)) return null;
  return { old: oldSegs, new: newSegs };
}

/**
 * Modified lines: in each block of removed lines followed by added lines, the n-th removed line
 * pairs with the n-th added one. Maps line indexes both ways.
 */
export function pairLines(lines: readonly DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(i++);
    const adds: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(i++);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      pairs.set(dels[k]!, adds[k]!);
      pairs.set(adds[k]!, dels[k]!);
    }
  }
  return pairs;
}

/** One row of the split view: the old side and the new side, by line index into the hunk. */
export interface SplitRow {
  old: number | null;
  new: number | null;
}

/** Context lines sit on both sides; a block of removals and additions lines up side by side. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'context') {
      rows.push({ old: i, new: i });
      i++;
      continue;
    }
    const dels: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(i++);
    const adds: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push({ old: dels[k] ?? null, new: adds[k] ?? null });
  }
  return rows;
}

/** Where a comment on a line attaches: removed lines by their old number, others by their new. */
export function lineAnchor(line: DiffLine): { side: 'old' | 'new'; line: number } | null {
  if (line.kind === 'del') return line.oldNo === null ? null : { side: 'old', line: line.oldNo };
  return line.newNo === null ? null : { side: 'new', line: line.newNo };
}

export function anchorKey(changeId: string, side: 'old' | 'new', line: number): string {
  return `${changeId}:${side}:${line}`;
}

export interface DiffTotals {
  files: number;
  additions: number;
  deletions: number;
  /** Hunks still waiting for a decision. */
  pendingHunks: number;
}

export function diffTotals(changes: readonly CodeChangeView[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  let pendingHunks = 0;
  for (const c of changes) {
    additions += c.additions;
    deletions += c.deletions;
    pendingHunks += c.hunks.filter((h) => h.state === 'pending').length;
    // A binary change has no hunks; it waits as a whole.
    if (c.binary && c.state === 'pending') pendingHunks++;
  }
  return { files: changes.length, additions, deletions, pendingHunks };
}

export const CHANGE_KIND_TEXT: Record<CodeChangeView['kind'], string> = {
  add: 'Added',
  modify: 'Modified',
  delete: 'Deleted',
  rename: 'Renamed',
};

export const CHANGE_STATE_TEXT: Record<CodeChangeView['state'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  partial: 'Partly accepted',
};

export const HUNK_STATE_TEXT: Record<DiffHunkView['state'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

/** Replace changes by id with newer versions, keeping the order of the list. */
export function mergeChanges(
  list: readonly CodeChangeView[],
  updated: readonly CodeChangeView[],
): CodeChangeView[] {
  const byId = new Map(updated.map((c) => [c.id, c]));
  const next = list.map((c) => byId.get(c.id) ?? c);
  for (const c of updated) if (!list.some((x) => x.id === c.id)) next.push(c);
  return next;
}
