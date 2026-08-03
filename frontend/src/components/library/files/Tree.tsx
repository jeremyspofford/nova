/** The tree itself — folders expand IN PLACE, they are never entered.
 *
 *  That is the whole difference from a Windows-Explorer pane, and it is why
 *  the rows are a flat array rather than nested markup: with one flat list
 *  the arrow keys are an index ±1, and a folder's children are just rows
 *  that appear underneath it at depth+1. Nesting the DOM would have made
 *  keyboard navigation a tree walk for no visual gain.
 */

import { Entry } from './api';

export type Row = {
  root: string;
  /** '' for a root node */
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  entry?: Entry;
};

/** One key for a node in any root. The separator is a plain space because
 *  root keys are a fixed set of single lowercase words — none of them can
 *  contain one — so the boundary is unambiguous, and unlike a control
 *  character it survives being put in a `data-key` attribute and read back
 *  out through CSS.escape (which turns NUL into U+FFFD). */
export const nodeKey = (root: string, path: string) => `${root} ${path}`;

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const FileGlyph = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    className="shrink-0 opacity-60" aria-hidden>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

export function Tree({
  rows, expanded, selected, busy, tapToOpen, onToggle, onSelect, onOpen, onKeyDown, treeRef,
}: {
  rows: Row[];
  expanded: Set<string>;
  selected: string | null;
  busy: Set<string>;
  /** Narrow/touch layouts have no double-click, so a single tap opens. */
  tapToOpen: boolean;
  onToggle: (r: Row) => void;
  onSelect: (r: Row) => void;
  onOpen: (r: Row) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  treeRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={treeRef}
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Files"
      className="h-full overflow-auto nice-scroll py-1 outline-none
                 focus-visible:ring-1 focus-visible:ring-teal-700/60 rounded"
    >
      {rows.map(r => {
        const k = nodeKey(r.root, r.path);
        const isSel = selected === k;
        const isOpen = expanded.has(k);
        const isRoot = r.path === '';
        // A memory file outside <type-dir>/*.md is on disk but invisible to
        // her search and catalogue. Saying so here is cheaper than letting
        // it be discovered by a note that never comes back.
        const unseen = r.entry && !r.dir && r.entry.indexed === false;
        return (
          <div
            key={k}
            data-key={k}
            role="treeitem"
            aria-selected={isSel}
            aria-expanded={r.dir ? isOpen : undefined}
            title={unseen ? 'On disk, but outside the folders she indexes' : r.name}
            onClick={() => (r.dir ? onToggle(r) : tapToOpen ? onOpen(r) : onSelect(r))}
            onDoubleClick={() => (r.dir ? undefined : onOpen(r))}
            style={{ paddingLeft: 4 + r.depth * 12 }}
            className={`flex items-center gap-1.5 pr-2 py-[3px] cursor-pointer select-none
                        text-[13px] leading-tight rounded-sm
                        ${isSel ? 'bg-teal-700/40 text-teal-100'
                                : 'text-stone-300 hover:bg-stone-800/60'}`}
          >
            {r.dir
              ? <Chevron open={isOpen} />
              : <span className="w-3 shrink-0" />}
            {r.dir ? null : <FileGlyph />}
            <span className={`truncate ${isRoot ? 'font-medium text-stone-200' : ''}
                              ${unseen ? 'italic text-stone-500' : ''}`}>
              {r.name}
            </span>
            {busy.has(k) && <span className="text-[10px] text-stone-500 shrink-0">…</span>}
          </div>
        );
      })}
    </div>
  );
}
