// A line diff as text (FR-036): + and - prefixes carry the meaning (with words for screen
// readers); color only reinforces them. Long unchanged runs are folded.
import { useMemo } from 'react';
import { DIFF_TEXT, diffSummary, foldDiff, lineDiff } from './diff.ts';

export function DiffView({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label: string;
}) {
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  const items = useMemo(() => foldDiff(diff), [diff]);
  return (
    <div className="spaces-diff-wrap">
      <p className="muted ws-flush">{diffSummary(diff)}</p>
      <pre role="group" className="spaces-diff" aria-label={label} tabIndex={0}>
        {items.map((d, i) =>
          d.kind === 'skip' ? (
            <span key={i} className="spaces-diff-line" data-kind="skip">
              … {DIFF_TEXT.unchanged({ n: d.count })}
            </span>
          ) : (
            <span key={i} className="spaces-diff-line" data-kind={d.kind}>
              <span aria-hidden="true">
                {d.kind === 'add' ? '+ ' : d.kind === 'del' ? '- ' : '  '}
              </span>
              {d.kind === 'same' ? null : (
                <span className="nv-vh">
                  {d.kind === 'add' ? DIFF_TEXT.addedLine : DIFF_TEXT.removedLine}{' '}
                </span>
              )}
              {d.text}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
