// The line diff behind proposals and conflicts (FR-036).
import { describe, expect, it } from 'vitest';
import { diffSummary, foldDiff, lineDiff, type DiffLine } from '../src/spaces/diff.ts';

const show = (d: DiffLine[]) =>
  d.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines in order', () => {
    expect(show(lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne'))).toEqual([
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
      '+e',
    ]);
  });

  it('aligns moved and repeated lines on the longest common subsequence', () => {
    const d = lineDiff('x\ny\nx\ny', 'y\nx\ny\nz');
    // Three of the four lines stay; only one goes and one comes.
    expect(d.filter((l) => l.kind === 'same')).toHaveLength(3);
    expect(diffSummary(d)).toBe('1 line added, 1 removed');
  });

  it('handles empty texts, identical texts and Windows line ends', () => {
    expect(lineDiff('', '')).toEqual([]);
    expect(show(lineDiff('', 'one\ntwo'))).toEqual(['+one', '+two']);
    expect(show(lineDiff('one\r\ntwo', ''))).toEqual(['-one', '-two']);
    expect(diffSummary(lineDiff('same\ntext', 'same\ntext'))).toBe('No changes');
    expect(diffSummary(lineDiff('a', 'b\nc'))).toBe('2 lines added, 1 removed');
    expect(diffSummary(lineDiff('a\nb', ''))).toBe('2 lines removed');
  });

  it('falls back to remove-then-add when the changed middle is too large to align', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join('\n');
    const d = lineDiff(`head\n${before}\ntail`, `head\n${after}\ntail`);
    expect(d[0]).toEqual({ kind: 'same', text: 'head' });
    expect(d.at(-1)).toEqual({ kind: 'same', text: 'tail' });
    expect(d.filter((l) => l.kind === 'del')).toHaveLength(2000);
    expect(d[1]?.kind).toBe('del');
    expect(d[2001]?.kind).toBe('add');
  });
});

describe('foldDiff', () => {
  it('keeps two lines of context around changes and folds the rest', () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l6', 'L6');
    const folded = foldDiff(lineDiff(before, after));
    expect(folded[0]).toEqual({ kind: 'skip', count: 4 });
    expect(folded.filter((x) => x.kind !== 'skip').map((x) => ('text' in x ? x.text : ''))).toEqual(
      ['l4', 'l5', 'l6', 'L6', 'l7', 'l8'],
    );
    expect(folded.at(-1)).toEqual({ kind: 'skip', count: 3 });
  });

  it('folds an unchanged text into one skip', () => {
    expect(foldDiff(lineDiff('a\nb', 'a\nb'))).toEqual([{ kind: 'skip', count: 2 }]);
  });
});
