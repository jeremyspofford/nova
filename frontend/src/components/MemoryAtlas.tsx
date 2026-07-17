import { useMemo, useState } from 'react';
import type { GraphNode, GraphEdge } from '../api';
import { computeSystems, tagColor } from '../brain/systems';

/** Atlas — the browsable index of everything in the brain.
 *
 * Grouped the way the Universe lays it out (systems.ts is shared with the
 * renderer): memory star systems by dominant tag, unlinked drifters,
 * journals newest-first, then the platform sections. Clicking an entry
 * opens its card and flies the camera there (when the theme supports it).
 */

export const TYPE_COLOR: Record<string, string> = {
  core: '#ffd27a', user: '#cfe0ff', journal: '#a8a29e', source: '#818cf8',
  agent: '#a78bfa', tool: '#84a98c', automation: '#bfe3ff', rule: '#f87171',
  skill: '#fbbf24',
};

interface AtlasItem {
  node: GraphNode;
  color: string;
  /** Id to open when it differs from the node id (Nova opens the soul). */
  openId?: string;
  sub?: string;
}

interface Section {
  id: string;
  title: string;
  titleColor?: string;
  items: AtlasItem[];
}

const byLabel = (a: GraphNode, b: GraphNode) => a.label.localeCompare(b.label);

export function MemoryAtlas({ nodes, edges, onOpen, onClose }: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];

    const core = nodes.find(n => n.type === 'core');
    const user = nodes.find(n => n.type === 'user');
    if (core || user) {
      const items: AtlasItem[] = [];
      if (core) items.push({ node: core, color: TYPE_COLOR.core, openId: 'soul.md' });
      if (user) items.push({ node: user, color: TYPE_COLOR.user });
      out.push({ id: 'home', title: 'Home', items });
    }

    const { systems, rogues } = computeSystems(nodes, edges);
    for (const sys of systems) {
      out.push({
        id: `sys:${sys.key}`,
        title: sys.name,
        titleColor: sys.color,
        items: [...sys.members].sort(byLabel).map(n => ({ node: n, color: tagColor(n) })),
      });
    }
    if (rogues.length) {
      out.push({
        id: 'rogues',
        title: 'Drifting (unlinked)',
        items: [...rogues].sort(byLabel).map(n => ({ node: n, color: tagColor(n) })),
      });
    }

    const journals = nodes.filter(n => n.type === 'journal')
      .sort((a, b) => b.mtime - a.mtime);
    if (journals.length) {
      out.push({
        id: 'journals',
        title: 'Journals',
        items: journals.map(n => ({
          node: n, color: TYPE_COLOR.journal,
          sub: new Date(n.mtime * 1000).toISOString().slice(0, 10),
        })),
      });
    }

    for (const [type, title] of [
      ['agent', 'Agents'], ['tool', 'Tools'], ['skill', 'Skills'],
      ['automation', 'Automations'], ['rule', 'Rules'],
    ] as const) {
      const items = nodes.filter(n => n.type === type).sort(byLabel);
      if (items.length) {
        out.push({
          id: type,
          title,
          items: items.map(n => ({
            node: n, color: TYPE_COLOR[type],
            sub: n.enabled === false ? 'off' : undefined,
          })),
        });
      }
    }
    return out;
  }, [nodes, edges]);

  const ql = q.trim().toLowerCase();
  const visible = sections
    .map(s => ({
      ...s,
      items: ql
        ? s.items.filter(({ node }) =>
            node.label.toLowerCase().includes(ql) ||
            node.id.toLowerCase().includes(ql) ||
            (node.tags ?? []).some(t => t.toLowerCase().includes(ql)))
        : s.items,
    }))
    .filter(s => s.items.length > 0);

  // memory sections start expanded; the (long) platform lists start folded
  const isOpen = (s: Section) => ql !== ''
    ? true
    : open[s.id] ?? (s.id === 'home' || s.id.startsWith('sys:') || s.id === 'rogues');

  return (
    <aside className="absolute top-16 left-4 bottom-4 z-20 w-[19rem] max-w-[calc(100vw-2rem)] flex flex-col rounded-xl bg-stone-900/90 backdrop-blur border border-stone-700 shadow-2xl">
      <header className="px-3 py-2.5 border-b border-stone-700 flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search everything…"
          className="flex-1 min-w-0 bg-stone-800/80 border border-stone-700 rounded-md px-2.5 py-1.5 text-sm text-stone-200 placeholder-stone-500 outline-none focus:border-teal-600"
        />
        <button
          onClick={onClose}
          className="text-stone-500 hover:text-stone-200 text-lg leading-none px-1"
          aria-label="Close atlas"
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto nice-scroll py-1.5">
        {visible.map(s => (
          <div key={s.id}>
            <button
              onClick={() => setOpen(prev => ({ ...prev, [s.id]: !isOpen(s) }))}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs uppercase tracking-wide text-stone-400 hover:text-stone-200"
            >
              <span className={`transition-transform ${isOpen(s) ? 'rotate-90' : ''}`}>▸</span>
              <span className="truncate" style={s.titleColor ? { color: s.titleColor } : undefined}>
                {s.title}
              </span>
              <span className="ml-auto font-mono text-stone-600">{s.items.length}</span>
            </button>
            {isOpen(s) && s.items.map(({ node, color, openId, sub }) => (
              <button
                key={node.id}
                onClick={() => onOpen(openId ?? node.id)}
                className="w-full flex items-center gap-2 pl-7 pr-3 py-1 text-sm text-stone-300 hover:bg-stone-800/70 hover:text-stone-100 text-left"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                <span className="truncate">{node.label}</span>
                {sub && <span className="ml-auto text-[10px] text-stone-500 shrink-0">{sub}</span>}
              </button>
            ))}
          </div>
        ))}
        {visible.length === 0 && (
          <p className="px-3 py-4 text-sm text-stone-500">Nothing matches “{q}”.</p>
        )}
      </div>
    </aside>
  );
}
