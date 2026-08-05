/** Chrome around the canvas: local ⇄ global, hop depth, fit, zoom, hover.
 *
 *  Only ONE ForceGraph is ever mounted — when global takes the centre column
 *  the dock's instance unmounts. One engine, one rAF loop.
 */

import { useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode } from '../api';
import { ForceGraph, type ForceGraphHandle } from './graph/ForceGraph';
import { neighbourhood, type VaultIndex } from './graph/model';

const btn = 'px-1.5 py-0.5 rounded text-[11px] border border-stone-700 text-stone-400 '
  + 'hover:bg-stone-800 hover:text-stone-200 disabled:opacity-40';

export function GraphPane({ index, docId, global, onToggleGlobal, dimmed, paused, onOpen }: {
  index: VaultIndex | null;
  /** The open note, when it is a memory note. Local mode centres on it. */
  docId: string | null;
  global: boolean;
  onToggleGlobal: (next: boolean) => void;
  /** Ids to recede — the tag filter. */
  dimmed: Set<string> | null;
  paused?: boolean;
  onOpen: (docId: string) => void;
}) {
  const [hops, setHops] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const handle = useRef<ForceGraphHandle>(null);

  // Memoised so the engine is not handed a new array identity every render —
  // setData would re-seed the layout on each parent re-render otherwise.
  const view = useMemo<{ nodes: GraphNode[]; links: GraphEdge[] }>(() => {
    if (!index) return { nodes: [], links: [] };
    if (global || !docId) return { nodes: index.nodes, links: index.links };
    return neighbourhood(index, docId, hops);
  }, [index, global, docId, hops]);

  const hovered = hover ? index?.byId.get(hover) : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-stone-800">
        <div className="flex rounded overflow-hidden border border-stone-700 text-[11px]">
          {([false, true] as const).map(g => (
            <button key={String(g)} onClick={() => onToggleGlobal(g)}
              className={`px-2 py-0.5 ${global === g
                ? 'bg-teal-700/50 text-teal-200' : 'text-stone-400 hover:text-stone-200'}`}>
              {g ? 'global' : 'local'}
            </button>
          ))}
        </div>
        {!global && (
          <label className="flex items-center gap-1 text-[11px] text-stone-500">
            hops
            <select
              value={hops}
              onChange={e => setHops(Number(e.target.value))}
              className="bg-stone-900 border border-stone-700 rounded px-1 py-0.5 text-stone-300"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
        )}
        <span className="flex-1" />
        <button className={btn} onClick={() => handle.current?.zoomBy(1.25)} aria-label="Zoom in">+</button>
        <button className={btn} onClick={() => handle.current?.zoomBy(0.8)} aria-label="Zoom out">−</button>
        <button className={btn} onClick={() => handle.current?.fit()} aria-label="Fit">fit</button>
      </div>

      <ForceGraph
        ref={handle}
        className="flex-1"
        nodes={view.nodes}
        links={view.links}
        selected={docId}
        dimmed={dimmed}
        paused={paused}
        onPick={id => { if (id) onOpen(id); }}
        onHover={setHover}
      />

      <div className="shrink-0 px-2 py-1 border-t border-stone-800 text-[10px] text-stone-500 truncate">
        {hovered
          ? `${hovered.label} — ${index?.degree.get(hovered.id) ?? 0} link${
              (index?.degree.get(hovered.id) ?? 0) === 1 ? '' : 's'}`
          : `${view.nodes.length} note${view.nodes.length === 1 ? '' : 's'}, ${
              view.links.length} link${view.links.length === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}
