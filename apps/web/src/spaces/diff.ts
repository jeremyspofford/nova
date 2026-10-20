// A small line diff for pages (FR-036): what an agent's proposal would change, and how the user's
// text differs from a newer version after a conflict. Longest common subsequence over lines,
// after trimming the common start and end (most edits are local, so the table stays small).
import { defineMessages } from '@nova/i18n';

/** A diff's summary and its parts. */
export const DIFF_TEXT = defineMessages('spaces.diff', {
  none: 'No changes',
  added: '{n, plural, one {# line added} other {# lines added}}',
  removed: '{n, plural, one {# line removed} other {# lines removed}}',
  both: '{add, plural, one {# line added} other {# lines added}}, {del, plural, other {# removed}}',
  /** A fold of unchanged lines, after an ellipsis. */
  unchanged: '{n, plural, one {# unchanged line} other {# unchanged lines}}',
  /** Read before a line by screen readers. */
  addedLine: 'Added:',
  removedLine: 'Removed:',
});

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** A diff with long unchanged runs folded away. */
export type DiffItem = DiffLine | { kind: 'skip'; count: number };

/** Above this many table cells the middle is shown as removed then added, not aligned. */
const MAX_CELLS = 2_000_000;

function lines(s: string): string[] {
  return s === '' ? [] : s.split(/\r?\n/);
}

/** The lines of `before` and `after`, marked same, removed (`del`) or added (`add`), in order. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...middle(midA, midB), ...tail];
}

function middle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: 'add', text }));
  if (m === 0) return a.map((text) => ({ kind: 'del', text }));
  if ((n + 1) * (m + 1) > MAX_CELLS)
    return [
      ...a.map((text): DiffLine => ({ kind: 'del', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  // lcs[i][j] = length of the LCS of a[i..] and b[j..], in one flat table.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const x = a[i] ?? '';
    const y = b[j] ?? '';
    if (x === y) {
      out.push({ kind: 'same', text: x });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      out.push({ kind: 'del', text: x });
      i++;
    } else {
      out.push({ kind: 'add', text: y });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', text: a[i] ?? '' });
  for (; j < m; j++) out.push({ kind: 'add', text: b[j] ?? '' });
  return out;
}

/** Keep `context` unchanged lines around each change; longer unchanged runs become a skip. */
export function foldDiff(diff: DiffLine[], context = 2): DiffItem[] {
  const changed = diff.map((d) => d.kind !== 'same');
  const keep = diff.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++)
      if (changed[k]) return true;
    return false;
  });
  const out: DiffItem[] = [];
  let skipped = 0;
  diff.forEach((d, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'skip', count: skipped });
      skipped = 0;
      out.push(d);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'skip', count: skipped });
  return out;
}

/** "2 lines added, 1 removed", or "No changes". */
export function diffSummary(diff: DiffLine[]): string {
  const add = diff.filter((d) => d.kind === 'add').length;
  const del = diff.filter((d) => d.kind === 'del').length;
  if (!add && !del) return DIFF_TEXT.none;
  if (add && del) return DIFF_TEXT.both({ add, del });
  return add ? DIFF_TEXT.added({ n: add }) : DIFF_TEXT.removed({ n: del });
}
