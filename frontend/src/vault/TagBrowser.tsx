/** Every tag in the corpus, most-used first, with its notes.
 *
 *  Counts come from the graph payload's per-node `tags`, so this needs no
 *  endpoint. What it CANNOT say yet is which tags actually bridge: the backend
 *  derives three tiers in `memory/tagtiers.py` and a STRUCTURAL tag (one that
 *  labels a note's KIND rather than its subject) earns no graph edge at all.
 *  With 465 distinct tags over 238 tagged notes — `transcript` and `media` are
 *  on 216 each — that distinction is what turns this list from a wall into an
 *  index. Until `/api/v1/memory/tags` exists, the count is the only signal and
 *  the header says so rather than implying every tag means the same thing.
 */

import { useMemo, useState } from 'react';
import type { VaultIndex } from './graph/model';

export function TagBrowser({ index, active, onPick, onOpen }: {
  index: VaultIndex | null;
  active: string | null;
  onPick: (tag: string | null) => void;
  onOpen: (docId: string) => void;
}) {
  const [q, setQ] = useState('');

  const tags = useMemo(() => {
    if (!index) return [];
    const needle = q.trim().toLowerCase();
    return needle ? index.tags.filter(t => t.tag.includes(needle)) : index.tags;
  }, [index, q]);

  const members = useMemo(() => {
    if (!index || !active) return [];
    return (index.tags.find(t => t.tag === active)?.docs ?? [])
      .map(id => index.byId.get(id))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [index, active]);

  if (!index) {
    return <div className="p-3 space-y-2">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-4 rounded bg-stone-800/60 animate-pulse" />
      ))}
    </div>;
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 p-2 space-y-1.5">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Filter tags"
          className="w-full bg-stone-950/60 border border-stone-800 rounded px-2 py-1
                     text-xs text-stone-200 placeholder:text-stone-600
                     focus:outline-none focus:border-stone-600"
        />
        <div className="text-[10px] text-stone-600 leading-snug">
          {index.tags.length} tags. Ordered by how many notes carry them —
          the biggest are format labels, not subjects.
        </div>
        {active && (
          <button onClick={() => onPick(null)}
            className="text-[11px] text-teal-400 hover:text-teal-300">
            Clear filter
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto nice-scroll px-1 pb-2">
        {tags.map(t => {
          const on = t.tag === active;
          return (
            <div key={t.tag}>
              <button
                onClick={() => onPick(on ? null : t.tag)}
                className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-left ${
                  on ? 'bg-teal-700/40 text-teal-100' : 'text-stone-300 hover:bg-stone-800/60'}`}
              >
                <span className="flex-1 truncate text-[12px]">{t.tag}</span>
                <span className="shrink-0 text-[10px] text-stone-500 tabular-nums">
                  {t.docs.length}
                </span>
              </button>
              {on && (
                <div className="ml-3 mb-1 border-l border-stone-800 pl-2 space-y-0.5">
                  {members.map(n => (
                    <button key={n.id} onClick={() => onOpen(n.id)}
                      className="w-full text-left px-1 py-0.5 rounded text-[11px]
                                 text-stone-400 hover:text-teal-200 hover:bg-stone-800/60 truncate">
                      {n.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!tags.length && (
          <div className="px-2 py-3 text-[11px] text-stone-600">No tag matches that.</div>
        )}
      </div>
    </div>
  );
}
