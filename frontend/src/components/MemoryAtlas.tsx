import { useEffect, useMemo, useRef, useState } from 'react';
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

// drag bounds for the panel width — MIN keeps the search box usable, MAX
// gives long titles room without swallowing the view (matches the chat's feel)
const MIN_W = 240;
const MAX_W = 560;
const DEFAULT_W = 304;   // 19rem — the original fixed width

export function MemoryAtlas({ nodes, edges, width, onWidthChange, focus, onOpen, onClose }: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Panel width in px — drag-resizable, persisted by the parent. */
  width: number;
  onWidthChange: (w: number) => void;
  /** Jump target from the inventory chip — nonce re-fires on every click. */
  focus?: { type: string; nonce: number } | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const resizing = useRef(false);

  // drag the right edge to resize; the panel is anchored `left-4` (16px), so
  // the width is the pointer's x minus that offset
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!resizing.current) return;
      onWidthChange(Math.min(MAX_W, Math.max(MIN_W, e.clientX - 16)));
    };
    const onUp = () => { resizing.current = false; document.body.style.cursor = ''; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onWidthChange]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement>(null);
  // the section a chip last opened, so re-clicking that chip collapses it
  // (the Atlas itself stays open — only the × button closes the panel)
  const chipSection = useRef<string | null>(null);
  // each chip click carries a fresh nonce; record the one we've handled so a
  // replayed effect (StrictMode's double-invoked mount) can't double-toggle
  const handledNonce = useRef<number | null>(null);

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

  // chip click → toggle its section, keeping the Atlas open. Clicking the
  // same chip that opened a section collapses it; a different chip expands
  // and scrolls to its own. Topics/sources live inside the tag systems, so
  // they aim at the first system (or the drifters when nothing links yet).
  useEffect(() => {
    if (!focus || handledNonce.current === focus.nonce) return;
    handledNonce.current = focus.nonce;
    const id =
      focus.type === 'topic' || focus.type === 'source'
        ? (sections.find(s => s.id.startsWith('sys:'))?.id
           ?? (sections.some(s => s.id === 'rogues') ? 'rogues' : undefined))
        : focus.type === 'journal' ? 'journals'
        : sections.some(s => s.id === focus.type) ? focus.type : undefined;
    if (!id) return;
    if (chipSection.current === id) {
      setOpen(prev => ({ ...prev, [id]: false }));   // second click → collapse
      chipSection.current = null;
      return;
    }
    setOpen(prev => ({ ...prev, [id]: true }));
    chipSection.current = id;
    // scroll after the newly-expanded section is in the DOM
    requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-section="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    // sections deliberately not a dep: jumps fire on chip clicks (nonce), not data refreshes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

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

  // collapse every section — explicit false overrides the default-open ones
  const collapseAll = () => {
    setOpen(Object.fromEntries(sections.map(s => [s.id, false])));
    chipSection.current = null;
  };
  const anyOpen = sections.some(isOpen);

  return (
    <aside
      className="absolute top-16 left-4 bottom-4 z-20 max-w-[calc(100vw-2rem)] flex flex-col rounded-xl bg-stone-900/90 backdrop-blur border border-stone-700 shadow-2xl"
      style={{ width }}
    >
      {/* drag handle — widen the Atlas to read longer titles (double-click resets) */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-700/50 transition-colors z-10"
        onPointerDown={() => { resizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onDoubleClick={() => onWidthChange(DEFAULT_W)}
        title="Drag to resize (double-click to reset)"
      />
      <header className="px-3 py-2.5 border-b border-stone-700 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="uppercase tracking-wide text-xs text-stone-500">Atlas</span>
          <div className="flex items-center gap-1">
            <button
              onClick={collapseAll}
              disabled={ql !== '' || !anyOpen}
              className="text-stone-500 hover:text-stone-200 disabled:opacity-30 disabled:hover:text-stone-500 text-sm leading-none px-1"
              title="Collapse all sections"
              aria-label="Collapse all sections"
            >
              ⊟
            </button>
            <button
              onClick={onClose}
              className="text-stone-500 hover:text-stone-200 text-lg leading-none px-1"
              aria-label="Close atlas"
            >
              ×
            </button>
          </div>
        </div>
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search everything…"
          className="min-w-0 bg-stone-800/80 border border-stone-700 rounded-md px-2.5 py-1.5 text-sm text-stone-200 placeholder-stone-500 outline-none focus:border-teal-600"
        />
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto nice-scroll py-1.5">
        {visible.map(s => (
          <div key={s.id} data-section={s.id}>
            <button
              onClick={() => {
                const next = !isOpen(s);
                setOpen(prev => ({ ...prev, [s.id]: next }));
                // keep the chip tracker honest: a manual toggle of this
                // section becomes the reference for the next chip click
                chipSection.current = next ? s.id
                  : chipSection.current === s.id ? null : chipSection.current;
              }}
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
