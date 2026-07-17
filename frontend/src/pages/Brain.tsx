import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrainGraph, getMemoryItem, getMemoryStats, getSettings, GraphNode, MemoryItem } from '../api';
import { ChatPanel } from '../chat/ChatPanel';
import { Markdown } from '../components/Markdown';
import { SettingsOverlay } from '../components/SettingsOverlay';
import { DEFAULT_THEME, THEMES, RendererHandle } from '../brain/theme';
import { displayName } from '../names';

const REFRESH_MS = 20000;

const TYPE_BADGE: Record<string, string> = {
  topic: 'bg-teal-900/60 text-teal-300 border-teal-700',
  skill: 'bg-amber-900/40 text-amber-300 border-amber-700',
  journal: 'bg-stone-800 text-stone-400 border-stone-600',
  source: 'bg-blue-900/40 text-blue-300 border-blue-700',
  self: 'bg-yellow-900/40 text-yellow-200 border-yellow-600',
  core: 'bg-yellow-900/40 text-yellow-200 border-yellow-600',
  agent: 'bg-violet-900/40 text-violet-300 border-violet-700',
  tool: 'bg-lime-900/30 text-lime-300 border-lime-800',
  automation: 'bg-blue-900/40 text-blue-300 border-blue-700',
  rule: 'bg-red-950/50 text-red-300 border-red-900',
};

// platform nodes carry their card content in the graph payload — no
// markdown file behind them to fetch
const PLATFORM_TYPES = new Set(['core', 'agent', 'tool', 'automation', 'rule']);
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

export function Brain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RendererHandle | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [detail, setDetail] = useState<MemoryItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<BrainPrefs>(DEFAULT_PREFS);
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
      setDetail({
        id,
        frontmatter: { type: node.type, title: node.label,
                       description: node.description ?? '' },
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

    const renderer = THEMES[themeKey].create(canvas, { onNodeClick: openDetail });
    rendererRef.current = renderer;
    renderer.configure?.({
      rotationSpeed: prefsRef.current.rotationSpeed,
      labelMode: prefsRef.current.labelMode,
      labelScale: prefsRef.current.labelScale,
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

    let cancelled = false;
    const load = async () => {
      try {
        const [graph, s] = await Promise.all([
          getBrainGraph(prefsRef.current.showPlatform), getMemoryStats()]);
        if (!cancelled) {
          // the core orb is labelled with the assistant's name (nova.assistant_name);
          // skills/platform names are feature names — Title Case them;
          // topic/journal labels are document titles and pass through
          const nodes = graph.nodes.map(n =>
            n.type === 'core' ? { ...n, label: nameRef.current }
            : PLATFORM_LABELED.has(n.type) ? { ...n, label: displayName(n.label) } : n);
          nodesRef.current = new Map(nodes.map(n => [n.id, n]));
          renderer.setData(nodes, graph.edges);
          setStats(s);
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
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [prefs.view, prefs.showPlatform, openDetail]);

  const fm = detail?.frontmatter ?? {};
  const badge = TYPE_BADGE[fm.type] ?? TYPE_BADGE.topic;

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
      </div>

      <footer className={`${roomy ? 'px-6 py-3' : 'px-4 py-2.5'} border-t border-stone-700 flex items-center justify-between gap-2 text-xs`}>
        <span className="font-mono text-stone-600 truncate">{detail.id}</span>
        {fm.source_url && (
          <a
            href={fm.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-teal-400 hover:text-teal-300"
          >
            View source ↗
          </a>
        )}
      </footer>
    </>
  );

  return (
    <div className="relative w-full h-screen overflow-hidden bg-stone-950">
      <canvas ref={canvasRef} className="absolute top-0 left-0" />

      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        {stats && (
          <div className="px-3 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-xs font-mono text-stone-400 space-x-3">
            <span className="text-teal-400">{stats.topic ?? 0} topics</span>
            <span className="text-amber-400">{stats.skill ?? 0} skills</span>
            <span>{stats.journal ?? 0} journals</span>
          </div>
        )}
        <button
          onClick={() => rendererRef.current?.recenter?.()}
          className="px-2.5 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-stone-400 hover:text-teal-300 text-sm leading-none"
          title="Recenter the view"
          aria-label="Recenter"
        >
          ⌖
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
        <aside className="absolute top-16 left-4 bottom-4 z-20 w-[26rem] max-w-[calc(100vw-2rem)] md:max-w-[calc(100vw-27rem)] flex flex-col rounded-xl bg-stone-900/90 backdrop-blur border border-stone-700 shadow-2xl">
          {renderDetail(false)}
        </aside>
      )}

      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}

      {(!isMobile || mobileChat) && (
        <ChatPanel
          width={isMobile ? window.innerWidth : chatWidth}
          onWidthChange={changeChatWidth}
          mobile={isMobile}
          onShowBrain={() => setMobileChat(false)}
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
