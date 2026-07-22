import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteMemoryItem, getBrainGraph, getMemoryItem, getSettings, GraphEdge, GraphNode, MemoryItem } from '../api';
import { ChatPanel } from '../chat/ChatPanel';
import { Markdown } from '../components/Markdown';
import { MemoryAtlas, TYPE_COLOR } from '../components/MemoryAtlas';
import { SettingsOverlay } from '../components/SettingsOverlay';
import { ObservabilityOverlay } from '../components/ObservabilityOverlay';
import { DEFAULT_THEME, THEMES, RendererHandle } from '../brain/theme';
import { tagColor } from '../brain/systems';
import { displayName } from '../names';

const REFRESH_MS = 20000;

// the Atlas sits `left-4` (16px) from the left edge; its right edge — this
// plus its width — is how far Nova's center must shift to stay centered.
const ATLAS_LEFT = 16;
// the sidebar-style detail card is `w-[26rem]` — used to tuck the legend past
// the whole left-column stack when both it and the Atlas are open.
const DETAIL_W = 416;

const TYPE_BADGE: Record<string, string> = {
  topic: 'bg-teal-900/60 text-teal-300 border-teal-700',
  skill: 'bg-amber-900/40 text-amber-300 border-amber-700',
  journal: 'bg-stone-800 text-stone-400 border-stone-600',
  source: 'bg-blue-900/40 text-blue-300 border-blue-700',
  self: 'bg-yellow-900/40 text-yellow-200 border-yellow-600',
  core: 'bg-yellow-900/40 text-yellow-200 border-yellow-600',
  user: 'bg-sky-900/40 text-sky-200 border-sky-700',
  agent: 'bg-violet-900/40 text-violet-300 border-violet-700',
  tool: 'bg-lime-900/30 text-lime-300 border-lime-800',
  automation: 'bg-blue-900/40 text-blue-300 border-blue-700',
  rule: 'bg-red-950/50 text-red-300 border-red-900',
};

// platform nodes carry their card content in the graph payload — no
// markdown file behind them to fetch
const PLATFORM_TYPES = new Set(['core', 'user', 'agent', 'tool', 'automation', 'rule']);
const PLATFORM_LABELED = new Set(['skill', 'agent', 'tool', 'automation', 'rule']);

interface BrainPrefs {
  view: string;
  detailStyle: string;
  rotationSpeed: number;
  labelMode: string;
  labelScale: number;
  showPlatform: boolean;
}

const DEFAULT_PREFS: BrainPrefs = {
  view: DEFAULT_THEME, detailStyle: 'sidebar',
  rotationSpeed: 2, labelMode: 'auto', labelScale: 1, showPlatform: true,
};

// The inventory chip: each count is the doorway to its Atlas section.
// Memory types always ride in the chip; platform types join on md+ screens
// (they'd crowd a phone toolbar). Topic renders even at 0 so the Atlas
// always has an entry point.
const CHIP_COLOR: Record<string, string> = { ...TYPE_COLOR, topic: '#2dd4bf' };
const MEMORY_CHIPS = ['topic', 'skill', 'journal', 'source'];
const PLATFORM_CHIPS = ['agent', 'tool', 'automation', 'rule'];

export function Brain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RendererHandle | null>(null);
  const [detail, setDetail] = useState<MemoryItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [observabilityOpen, setObservabilityOpen] = useState(false);
  const [prefs, setPrefs] = useState<BrainPrefs>(DEFAULT_PREFS);
  // latest graph as state — the Atlas, the chip, and the legend render from it
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>(
    { nodes: [], edges: [] });
  const [atlasOpen, setAtlasOpen] = useState(false);
  // nonce so re-clicking the same count re-scrolls an already-open Atlas
  const [atlasFocus, setAtlasFocus] = useState<{ type: string; nonce: number } | null>(null);
  const [legendOpen, setLegendOpen] = useState(() =>
    window.innerWidth >= 768 && localStorage.getItem('nova.brain.legend') !== '0');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // small screens: chat IS the app, full-width, brain one tap away
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [mobileChat, setMobileChat] = useState(true);
  const mobileRef = useRef(isMobile);

  const [chatWidth, setChatWidth] = useState(() =>
    parseInt(localStorage.getItem('nova.chat.width') ?? '384'));
  const chatWidthRef = useRef(chatWidth);

  const changeChatWidth = useCallback((w: number) => {
    setChatWidth(w);
    chatWidthRef.current = w;
    localStorage.setItem('nova.chat.width', String(w));
    rendererRef.current?.resize(window.innerWidth - w, window.innerHeight);
  }, []);

  // the Atlas is drag-resizable like the chat (longer titles fit when wider);
  // `left-4` places it 16px from the left edge — that offset feeds leftInset
  const [atlasWidth, setAtlasWidth] = useState(() =>
    parseInt(localStorage.getItem('nova.atlas.width') ?? '304'));
  const atlasWidthRef = useRef(atlasWidth);
  atlasWidthRef.current = atlasWidth;
  const atlasOpenRef = useRef(atlasOpen);
  atlasOpenRef.current = atlasOpen;

  const changeAtlasWidth = useCallback((w: number) => {
    setAtlasWidth(w);
    localStorage.setItem('nova.atlas.width', String(w));
  }, []);

  // Nova centers in the clear band between the Atlas (left) and the chat
  // (right). The chat is already baked into the canvas width; leftInset tells
  // the renderer how much the Atlas covers so she re-centers when it opens,
  // closes, or is dragged wider. Desktop only — on mobile the Atlas is a
  // full-width overlay and there's no band to center in.
  const atlasInset = atlasOpen && !isMobile ? ATLAS_LEFT + atlasWidth : 0;
  useEffect(() => {
    rendererRef.current?.configure?.({ leftInset: atlasInset });
  }, [atlasInset]);

  // The legend shares the left column with the Atlas (and the sidebar-style
  // detail card), so it must dock to the *right* of whatever's open there
  // rather than sit buried behind it. Nothing open → it stays at the left
  // edge, under its button. (Modal detail is a centered overlay — it doesn't
  // claim the column, so it doesn't move the legend.)
  const legendLeft = (() => {
    if (isMobile) return ATLAS_LEFT;
    let right = atlasOpen ? ATLAS_LEFT + atlasWidth : 0;
    if (detail && prefs.detailStyle === 'sidebar') {
      const detailLeft = atlasOpen ? ATLAS_LEFT + atlasWidth + 16 : ATLAS_LEFT;
      right = detailLeft + DETAIL_W;
    }
    return right ? right + 16 : ATLAS_LEFT;
  })();

  // Appearance lives in the settings platform (Settings -> Appearance);
  // load on mount, then react live to overlay changes via the change event.
  useEffect(() => {
    getSettings().then(defs => {
      const v = (k: string) => defs.find(d => d.key === k)?.value;
      setPrefs({
        view: String(v('brain.view') ?? DEFAULT_THEME),
        detailStyle: String(v('brain.detail_style') ?? 'sidebar'),
        rotationSpeed: Number(v('brain.rotation_speed') ?? 2),
        labelMode: String(v('brain.label_mode') ?? 'auto'),
        labelScale: Number(v('brain.label_scale') ?? 1),
        showPlatform: v('brain.show_platform') !== false,
      });
      const nm = v('nova.assistant_name');
      if (typeof nm === 'string' && nm.trim()) {
        nameRef.current = nm.trim();
        reloadRef.current?.();   // relabel the core orb once the name resolves
      }
    }).catch(() => {});

    const onChange = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      if (key === 'nova.assistant_name' && typeof value === 'string' && value.trim()) {
        nameRef.current = value.trim();
        reloadRef.current?.();   // live rename → re-fetch + relabel the orb now
        return;
      }
      if (!key.startsWith('brain.')) return;
      setPrefs(prev => {
        const next = { ...prev };
        if (key === 'brain.view') next.view = String(value);
        if (key === 'brain.detail_style') next.detailStyle = String(value);
        if (key === 'brain.rotation_speed') next.rotationSpeed = Number(value);
        if (key === 'brain.label_mode') next.labelMode = String(value);
        if (key === 'brain.label_scale') next.labelScale = Number(value);
        if (key === 'brain.show_platform') next.showPlatform = Boolean(value);
        return next;
      });
      const patch: Record<string, unknown> = {};
      if (key === 'brain.rotation_speed') patch.rotationSpeed = Number(value);
      if (key === 'brain.label_mode') patch.labelMode = value;
      if (key === 'brain.label_scale') patch.labelScale = Number(value);
      if (Object.keys(patch).length) rendererRef.current?.configure?.(patch);
    };
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);

  // latest graph nodes — platform node cards are built from these
  const nodesRef = useRef<Map<string, GraphNode>>(new Map());
  // the assistant's name (nova.assistant_name) labels the core orb; reloadRef
  // lets a live rename re-fetch + relabel without waiting for the poll tick
  const nameRef = useRef('Nova');
  const reloadRef = useRef<(() => void) | null>(null);

  const openDetail = useCallback(async (id: string | null) => {
    if (id === null) {
      setDetail(null);
      return;
    }
    const node = nodesRef.current.get(id);
    if (node && PLATFORM_TYPES.has(node.type)) {
      // description goes in the body only — filling both slots rendered the
      // same text twice (italic summary + markdown content)
      setDetail({
        id,
        frontmatter: { type: node.type, title: node.label },
        content: node.description ?? '*(no description)*',
      });
      return;
    }
    try {
      setDetail(await getMemoryItem(id));
    } catch (err) {
      console.error('detail load failed:', err);
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const themeKey = prefs.view in THEMES ? prefs.view : DEFAULT_THEME;

    // a theme that can't start (no WebGL context on this machine) falls back
    // to the 2D graph instead of white-screening the app with no way back
    let renderer: RendererHandle;
    try {
      renderer = THEMES[themeKey].create(canvas, { onNodeClick: openDetail });
    } catch (err) {
      console.error(`brain view "${themeKey}" failed to start:`, err);
      renderer = THEMES[DEFAULT_THEME].create(canvas, { onNodeClick: openDetail });
    }
    rendererRef.current = renderer;
    renderer.configure?.({
      rotationSpeed: prefsRef.current.rotationSpeed,
      labelMode: prefsRef.current.labelMode,
      labelScale: prefsRef.current.labelScale,
      // a freshly-created renderer doesn't know the Atlas state — seed it so
      // Nova opens already centered in the current band
      leftInset: atlasOpenRef.current && !mobileRef.current
        ? ATLAS_LEFT + atlasWidthRef.current : 0,
    });

    const size = () => {
      mobileRef.current = window.innerWidth < 768;
      setIsMobile(mobileRef.current);
      renderer.resize(
        window.innerWidth - (mobileRef.current ? 0 : chatWidthRef.current),
        window.innerHeight);
    };
    size();
    window.addEventListener('resize', size);

    // live-activity bridge (the brain-activity item's contract): anything
    // dispatching nova:chat-activity reaches the active renderer here
    const onActivity = (e: Event) => {
      renderer.setActivity?.((e as CustomEvent).detail as {
        active: boolean; kind?: 'thinking' | 'dispatch' | 'tool' | 'listening';
      });
    };
    window.addEventListener('nova:chat-activity', onActivity);

    let cancelled = false;
    const load = async () => {
      try {
        const graph = await getBrainGraph(prefsRef.current.showPlatform);
        if (!cancelled) {
          // the core orb is labelled with the assistant's name (nova.assistant_name);
          // skills/platform names are feature names — Title Case them;
          // topic/journal labels are document titles and pass through
          const nodes = graph.nodes.map(n =>
            n.type === 'core' ? { ...n, label: nameRef.current }
            : PLATFORM_LABELED.has(n.type) ? { ...n, label: displayName(n.label) } : n);
          nodesRef.current = new Map(nodes.map(n => [n.id, n]));
          renderer.setData(nodes, graph.edges);
          setGraphData({ nodes, edges: graph.edges });
        }
      } catch (err) {
        console.error('brain refresh failed:', err);
      }
    };
    load();
    reloadRef.current = load;   // let a live rename trigger an immediate relabel
    const interval = setInterval(load, REFRESH_MS);

    return () => {
      cancelled = true;
      reloadRef.current = null;
      clearInterval(interval);
      window.removeEventListener('resize', size);
      window.removeEventListener('nova:chat-activity', onActivity);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [prefs.view, prefs.showPlatform, openDetail]);

  // the Settings → Observability link (and anything else) can open the board
  // without threading props through overlays
  useEffect(() => {
    const open = () => { setSettingsOpen(false); setObservabilityOpen(true); };
    window.addEventListener('nova:open-observability', open);
    return () => window.removeEventListener('nova:open-observability', open);
  }, []);

  const fm = detail?.frontmatter ?? {};
  const badge = TYPE_BADGE[fm.type] ?? TYPE_BADGE.topic;

  // two-step delete resets whenever the card changes
  useEffect(() => { setConfirmingDelete(false); setDeleteErr(null); }, [detail?.id]);

  const legend = (THEMES[prefs.view] ?? THEMES[DEFAULT_THEME]).legend;
  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of graphData.nodes) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [graphData.nodes]);

  const toggleLegend = () => setLegendOpen(o => {
    localStorage.setItem('nova.brain.legend', o ? '0' : '1');
    return !o;
  });

  // chip counts open the Atlas and aim it at their section; the section
  // toggle (same count again collapses that section, Atlas stays open until
  // the × button) lives in MemoryAtlas — the chip only signals intent, and
  // the nonce re-fires the jump even when the same count is clicked twice.
  const openAtlasSection = (t: string) => {
    setAtlasOpen(true);
    setAtlasFocus({ type: t, nonce: Date.now() });
  };

  // clickable relations for the open card — real edges only (tag chains are
  // clustering artifacts, and tags already show as chips in the header)
  const TYPE_ORDER = ['core', 'user', 'topic', 'source', 'journal',
                      'agent', 'tool', 'skill', 'automation', 'rule'];
  const connections = useMemo(() => {
    if (!detail) return [];
    const byId = new Map(graphData.nodes.map(n => [n.id, n]));
    // the Nova star card opens as soul.md; its graph node is the core
    const id = detail.id === 'soul.md'
      ? graphData.nodes.find(n => n.type === 'core')?.id ?? detail.id
      : detail.id;
    const seen = new Set<string>();
    const out: GraphNode[] = [];
    for (const e of graphData.edges) {
      if (e.kind === 'tag') continue;
      const other = e.source === id ? e.target : e.target === id ? e.source : null;
      if (!other || seen.has(other)) continue;
      seen.add(other);
      const node = byId.get(other);
      if (node) out.push(node);
    }
    return out.sort((a, b) =>
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, graphData]);

  const openConnection = (node: GraphNode) => {
    const target = node.type === 'core' ? 'soul.md' : node.id;
    openDetail(target);
    rendererRef.current?.focusNode?.(target);
  };

  // file-backed memories only — platform entities delete from Settings, the
  // soul is not deletable at all (the API enforces both)
  const deletable = !!detail && !PLATFORM_TYPES.has(fm.type ?? 'topic') && detail.id !== 'soul.md';
  const doDelete = async () => {
    if (!detail) return;
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    try {
      await deleteMemoryItem(detail.id);
      setDetail(null);
      reloadRef.current?.();   // immediate refetch — the body falls into the black hole
    } catch (err) {
      setDeleteErr(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // roomy = the centered modal; the sidebar keeps its tighter density
  const renderDetail = (roomy: boolean) => detail && (
    <>
      <header className={`${roomy ? 'px-6 py-4' : 'px-4 py-3'} border-b border-stone-700 flex items-start justify-between gap-2`}>
        <div>
          <h2 className="text-stone-100 font-semibold leading-snug">
            {fm.title ?? detail.id}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className={`px-1.5 py-0.5 rounded border ${badge}`}>{fm.type ?? 'topic'}</span>
            {fm.timestamp && (
              <span className="text-stone-500">learned {String(fm.timestamp).slice(0, 10)}</span>
            )}
            {(fm.tags ?? '').replace(/[[\]]/g, '').split(',').filter(t => t.trim()).map(t => (
              <span key={t} className="px-1.5 py-0.5 rounded bg-stone-800 text-stone-400">
                #{t.trim()}
              </span>
            ))}
          </div>
        </div>
        <button
          onClick={() => setDetail(null)}
          className="text-stone-500 hover:text-stone-200 text-lg leading-none px-1"
          aria-label="Close details"
        >
          ×
        </button>
      </header>

      <div className={`flex-1 overflow-y-auto nice-scroll ${roomy ? 'px-6 py-4' : 'px-4 py-3'} text-sm text-stone-300`}>
        {fm.description && (
          <p className="text-stone-400 italic mb-3">{fm.description}</p>
        )}
        <Markdown>{detail.content}</Markdown>
        {connections.length > 0 && (
          <div className="mt-4 pt-3 border-t border-stone-800">
            <div className="text-[10px] uppercase tracking-wide text-stone-500 mb-1.5">
              Connections
            </div>
            <div className="flex flex-wrap gap-1.5">
              {connections.map(node => (
                <button
                  key={node.id}
                  onClick={() => openConnection(node)}
                  title={node.type}
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-stone-700 bg-stone-800/60 text-xs text-stone-300 hover:border-teal-600 hover:text-teal-200"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: node.type === 'topic' ? tagColor(node) : TYPE_COLOR[node.type] ?? '#a8a29e' }}
                  />
                  <span className="truncate max-w-[14rem]">{node.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className={`${roomy ? 'px-6 py-3' : 'px-4 py-2.5'} border-t border-stone-700 flex items-center justify-between gap-2 text-xs`}>
        <span className="font-mono text-stone-600 truncate">{detail.id}</span>
        <div className="shrink-0 flex items-center gap-3">
          {deleteErr && <span className="text-red-400">{deleteErr}</span>}
          {deletable && (
            <button
              onClick={doDelete}
              className={confirmingDelete
                ? 'px-2 py-0.5 rounded border border-red-800 bg-red-950/60 text-red-300'
                : 'text-stone-500 hover:text-red-300'}
            >
              {confirmingDelete ? 'Really delete?' : 'Delete'}
            </button>
          )}
          {fm.source_url && (
            <a
              href={fm.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-400 hover:text-teal-300"
            >
              View source ↗
            </a>
          )}
        </div>
      </footer>
    </>
  );

  return (
    <div className="relative w-full h-screen overflow-hidden bg-stone-950">
      {/* keyed per renderer-recreate: a canvas that ever held a WebGL context
          can never hand out a 2d context again (and a force-lost WebGL context
          can't be revived) — every setup-effect run needs a fresh element */}
      <canvas
        key={`${prefs.view}:${prefs.showPlatform}`}
        ref={canvasRef}
        className="absolute top-0 left-0"
      />

      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <div className={`px-1 py-1 rounded-lg bg-stone-900/80 backdrop-blur border text-xs font-mono flex items-center ${atlasOpen ? 'border-teal-700' : 'border-stone-700'}`}>
          {MEMORY_CHIPS
            .filter(t => t === 'topic' || (typeCounts[t] ?? 0) > 0)
            .map(t => (
              <button
                key={t}
                onClick={() => openAtlasSection(t)}
                className="px-1.5 py-1 rounded hover:bg-stone-800 hover:underline underline-offset-2 decoration-stone-500"
                style={{ color: CHIP_COLOR[t] }}
                title={`Browse ${t}s in the Atlas`}
                aria-label={`Browse ${t}s in the Atlas`}
              >
                {typeCounts[t] ?? 0} {t}{(typeCounts[t] ?? 0) === 1 ? '' : 's'}
              </button>
            ))}
          {PLATFORM_CHIPS.some(t => (typeCounts[t] ?? 0) > 0) && (
            <span className="hidden md:inline-flex items-center">
              <span className="mx-1 h-3 w-px bg-stone-700" />
              {PLATFORM_CHIPS
                .filter(t => (typeCounts[t] ?? 0) > 0)
                .map(t => (
                  <button
                    key={t}
                    onClick={() => openAtlasSection(t)}
                    className="px-1.5 py-1 rounded hover:bg-stone-800 hover:underline underline-offset-2 decoration-stone-500"
                    style={{ color: CHIP_COLOR[t] }}
                    title={`Browse ${t}s in the Atlas`}
                    aria-label={`Browse ${t}s in the Atlas`}
                  >
                    {typeCounts[t]} {t}{typeCounts[t] === 1 ? '' : 's'}
                  </button>
                ))}
            </span>
          )}
        </div>
        <button
          onClick={toggleLegend}
          className={`px-2.5 py-2 rounded-lg bg-stone-900/80 backdrop-blur border text-xs leading-none ${legendOpen ? 'border-teal-700 text-teal-300' : 'border-stone-700 text-stone-400 hover:text-teal-300'}`}
          title="What each shape means"
          aria-label="Legend"
        >
          Legend
        </button>
        <button
          onClick={() => rendererRef.current?.recenter?.()}
          className="px-2.5 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-stone-400 hover:text-teal-300 text-sm leading-none"
          title="Recenter the view"
          aria-label="Recenter"
        >
          ⌖
        </button>
        <button
          onClick={() => setObservabilityOpen(true)}
          className="px-2.5 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-stone-400 hover:text-teal-300 leading-none"
          title="Observability — health, resources & cost"
          aria-label="Observability"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12h4l2 6 4-14 2 8h6" />
          </svg>
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="px-2.5 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-stone-400 hover:text-teal-300 text-sm leading-none"
          title="Settings, Automations, Rules & Agents"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>

      {legendOpen && (
        <div
          className="absolute bottom-4 z-10 w-64 max-h-[45vh] overflow-y-auto nice-scroll rounded-xl bg-stone-900/85 backdrop-blur border border-stone-700 px-3 py-2.5 text-xs transition-[left] duration-200"
          style={{ left: legendLeft }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="uppercase tracking-wide text-stone-500">Legend</span>
            <button
              onClick={toggleLegend}
              className="text-stone-500 hover:text-stone-200 leading-none"
              aria-label="Close legend"
            >
              ×
            </button>
          </div>
          {/* pure decoder — counts live in the inventory chip, browsing in the Atlas */}
          {legend
            .filter(e => !e.key || (typeCounts[e.key] ?? 0) > 0)
            .map(e => (
              <div key={e.label} className="flex items-start gap-2 py-0.5">
                <span className="mt-1 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: e.color }} />
                <span className="text-stone-300 leading-snug">
                  {e.label}
                  {e.note && <span className="block text-stone-500">{e.note}</span>}
                </span>
              </div>
            ))}
        </div>
      )}

      {atlasOpen && (
        <MemoryAtlas
          nodes={graphData.nodes}
          edges={graphData.edges}
          width={atlasWidth}
          onWidthChange={changeAtlasWidth}
          focus={atlasFocus}
          onOpen={id => { openDetail(id); rendererRef.current?.focusNode?.(id); }}
          onClose={() => setAtlasOpen(false)}
        />
      )}

      {detail && prefs.detailStyle === 'modal' ? (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/50"
          onClick={() => setDetail(null)}
        >
          <div
            className="w-[42rem] max-w-[calc(100vw-1rem)] md:max-w-[calc(100vw-26rem)] max-h-[85vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {renderDetail(true)}
          </div>
        </div>
      ) : detail && (
        <aside
          className="absolute top-16 left-4 bottom-4 z-20 w-[26rem] max-w-[calc(100vw-2rem)] md:max-w-[calc(100vw-27rem)] flex flex-col rounded-xl bg-stone-900/90 backdrop-blur border border-stone-700 shadow-2xl"
          style={atlasOpen && !isMobile ? { left: ATLAS_LEFT + atlasWidth + 16 } : undefined}
        >
          {renderDetail(false)}
        </aside>
      )}

      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}

      {observabilityOpen && <ObservabilityOverlay onClose={() => setObservabilityOpen(false)} />}

      {(!isMobile || mobileChat) && (
        <ChatPanel
          width={isMobile ? window.innerWidth : chatWidth}
          onWidthChange={changeChatWidth}
          mobile={isMobile}
          onShowBrain={() => setMobileChat(false)}
          settingsOpen={settingsOpen}
        />
      )}
      {isMobile && !mobileChat && (
        <button
          onClick={() => setMobileChat(true)}
          className="absolute bottom-6 right-5 z-30 w-12 h-12 rounded-full bg-teal-700 hover:bg-teal-600 text-white text-xl shadow-2xl"
          aria-label="Open chat"
        >
          💬
        </button>
      )}
    </div>
  );
}
