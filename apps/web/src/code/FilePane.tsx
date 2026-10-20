// A file of the session opened at a line (FR-074, FR-039): the workspace's editor, or its preview
// for files the editor cannot show. Once the editor has the text, the line is selected and
// scrolled into view.
import { defineMessages } from '@nova/i18n';
import { useEffect, useRef, useState } from 'react';
import { EditorPane } from '../files/EditorPane.tsx';
import { PreviewPane } from '../files/PreviewPane.tsx';
import type { FileRef } from '../layout/model.ts';

export const FILE_PANE_TEXT = defineMessages('code.filePane', {
  empty: 'Find a symbol with Go to symbol above to open its file here.',
});

export interface FileTarget {
  path: string;
  line: number;
  /** Bumped on every jump, so picking the same symbol again jumps again. */
  n: number;
}

/** Offsets of the start and end of a 1-based line in `text` (the last line when past the end). */
export function lineRange(text: string, line: number): { start: number; end: number } {
  let start = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) break;
    start = nl + 1;
  }
  const nl = text.indexOf('\n', start);
  return { start, end: nl < 0 ? text.length : nl };
}

export function FilePane({
  root,
  target,
  threadId,
  mac,
}: {
  /** The session's folder: symbol paths are relative to it. */
  root: string;
  target: FileTarget | null;
  threadId: string;
  mac: boolean;
}) {
  const [where, setWhere] = useState<{ n: number; kind: 'editor' | 'preview' } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const kind = where && target && where.n === target.n ? where.kind : 'editor';

  // Jump to the line once the editor shows the file's text (it loads asynchronously).
  useEffect(() => {
    const el = wrap.current;
    if (!el || !target || kind !== 'editor') return;
    let done = false;
    const jump = (): boolean => {
      const area = el.querySelector('textarea');
      if (!area || done) return done;
      done = true;
      const { start, end } = lineRange(area.value, target.line);
      area.focus();
      area.setSelectionRange(start, end);
      const lh = Number.parseFloat(getComputedStyle(area).lineHeight);
      area.scrollTop = Math.max(0, (target.line - 3) * (Number.isFinite(lh) ? lh : 20));
      return true;
    };
    if (jump()) return;
    const observer = new MutationObserver(() => {
      if (jump()) observer.disconnect();
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [kind, target]);

  if (!target) return <p className="muted pane-note">{FILE_PANE_TEXT.empty}</p>;
  const file: FileRef = { root, path: target.path };
  return (
    <div ref={wrap} className="code-file-pane">
      {kind === 'editor' ? (
        <EditorPane
          file={file}
          mac={mac}
          onPreview={() => setWhere({ n: target.n, kind: 'preview' })}
        />
      ) : (
        <PreviewPane
          file={file}
          threadId={threadId}
          onEdit={() => setWhere({ n: target.n, kind: 'editor' })}
        />
      )}
    </div>
  );
}
