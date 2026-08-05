/** The left column: one body, three ways in.
 *
 *  Files is the filesystem as it is — folders and filenames, because this is a
 *  file tree and labelling it with titles would be a lie about what is on
 *  disk. Tags and Search label by TITLE, because those are questions about
 *  notes rather than about files, and a link resolves by title.
 */

import type { Root } from '../files/api';
import { Tree, type Row } from '../files/Tree';
import type { FileTree } from '../files/useFileTree';
import type { VaultIndex } from './graph/model';
import { TagBrowser } from './TagBrowser';
import { SearchPanel } from './SearchPanel';

export type SidebarMode = 'files' | 'tags' | 'search';
export const SIDEBAR_MODES: SidebarMode[] = ['files', 'tags', 'search'];

export function VaultSidebar({
  mode, onMode, tree, index, tag, onTag, onOpenDoc, onOpenRow, narrow, selRoot,
}: {
  mode: SidebarMode;
  onMode: (m: SidebarMode) => void;
  tree: FileTree;
  index: VaultIndex | null;
  tag: string | null;
  onTag: (t: string | null) => void;
  onOpenDoc: (docId: string) => void;
  onOpenRow: (r: Row) => void;
  /** Touch has no double-click. */
  narrow: boolean;
  selRoot: Root | null;
}) {
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex gap-1 p-1.5 border-b border-stone-800">
        {SIDEBAR_MODES.map(m => (
          <button
            key={m}
            onClick={() => onMode(m)}
            className={`flex-1 px-2 py-1 rounded text-[11px] capitalize ${
              mode === m ? 'bg-teal-700/50 text-teal-200' : 'text-stone-400 hover:text-stone-200'}`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {mode === 'files' && (
          <Tree
            rows={tree.rows}
            expanded={tree.expanded}
            selected={tree.selected}
            busy={tree.busy}
            tapToOpen={narrow}
            onToggle={r => void tree.toggle(r)}
            onSelect={r => tree.setSelected(`${r.root} ${r.path}`)}
            onOpen={onOpenRow}
            onKeyDown={tree.onKeyDown}
            treeRef={tree.treeRef}
          />
        )}
        {mode === 'tags' && (
          <TagBrowser index={index} active={tag} onPick={onTag} onOpen={onOpenDoc} />
        )}
        {mode === 'search' && <SearchPanel index={index} onOpen={onOpenDoc} />}
      </div>

      {mode === 'files' && selRoot && (
        <div className="shrink-0 px-2 py-1.5 border-t border-stone-800 text-[10px] text-stone-600 leading-snug">
          {selRoot.note}
        </div>
      )}
    </div>
  );
}
