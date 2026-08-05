/** Search over what the client holds: titles, paths, descriptions and tags.
 *
 *  NOT bodies, and the placeholder says so. There is no HTTP search route —
 *  `BM25Index.search` has exactly two callers and both are internal to the
 *  agent's retrieval path — and fetching 262 bodies to grep them in the
 *  browser is not a search, it is a download. Saying "titles, paths and tags"
 *  is the honest version of the box; the alternative is a search that silently
 *  misses the thing you know you wrote.
 */

import { useMemo, useState } from 'react';
import type { VaultIndex } from './graph/model';
import type { GraphNode } from '../api';

const TYPE_ORDER = ['topic', 'source', 'skill', 'journal'];

function score(n: GraphNode, q: string): number {
  const label = n.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 60;
  if (label.includes(q)) return 40;
  if ((n.tags ?? []).some(t => t.includes(q))) return 25;
  if (n.id.toLowerCase().includes(q)) return 15;
  if ((n.description ?? '').toLowerCase().includes(q)) return 10;
  return 0;
}

export function SearchPanel({ index, onOpen }: {
  index: VaultIndex | null;
  onOpen: (docId: string) => void;
}) {
  const [q, setQ] = useState('');

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!index || needle.length < 2) return [];
    return index.nodes
      .map(n => ({ n, s: score(n, needle) }))
      .filter(x => x.s > 0)
      .sort((a, b) =>
        b.s - a.s ||
        TYPE_ORDER.indexOf(a.n.type) - TYPE_ORDER.indexOf(b.n.type) ||
        a.n.label.localeCompare(b.n.label))
      .slice(0, 80);
  }, [index, q]);

  const short = q.trim().length > 0 && q.trim().length < 2;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 p-2 space-y-1.5">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search titles, paths and tags"
          autoFocus
          className="w-full bg-stone-950/60 border border-stone-800 rounded px-2 py-1
                     text-xs text-stone-200 placeholder:text-stone-600
                     focus:outline-none focus:border-stone-600"
        />
        <div className="text-[10px] text-stone-600 leading-snug">
          Note bodies are not searched here — that lives in her index, which the
          browser cannot reach.
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto nice-scroll px-1 pb-2">
        {short && <div className="px-2 py-3 text-[11px] text-stone-600">Keep typing…</div>}
        {!short && q.trim() && !hits.length && (
          <div className="px-2 py-3 text-[11px] text-stone-600">Nothing matches that.</div>
        )}
        {hits.map(({ n }) => (
          <button key={n.id} onClick={() => onOpen(n.id)}
            className="w-full text-left px-1.5 py-1 rounded hover:bg-stone-800/60 group">
            <div className="text-[12px] text-stone-300 group-hover:text-teal-200 truncate">
              {n.label}
            </div>
            <div className="text-[10px] font-mono text-stone-600 truncate">{n.id}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
