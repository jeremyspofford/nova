import { useCallback, useEffect, useRef, useState } from 'react';
import { getMemoryGraph, getMemoryItem, getMemoryStats, MemoryItem } from '../api';
import { ChatPanel } from '../chat/ChatPanel';
import { Markdown } from '../components/Markdown';
import { SettingsOverlay } from '../components/SettingsOverlay';
import { DEFAULT_THEME, THEMES, RendererHandle } from '../brain/theme';

const CHAT_WIDTH = 384; // w-96
const REFRESH_MS = 20000;

const TYPE_BADGE: Record<string, string> = {
  topic: 'bg-teal-900/60 text-teal-300 border-teal-700',
  skill: 'bg-amber-900/40 text-amber-300 border-amber-700',
  journal: 'bg-stone-800 text-stone-400 border-stone-600',
  source: 'bg-blue-900/40 text-blue-300 border-blue-700',
  self: 'bg-yellow-900/40 text-yellow-200 border-yellow-600',
};

export function Brain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RendererHandle | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [detail, setDetail] = useState<MemoryItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('nova.brain.theme');
    return saved && saved in THEMES ? saved : DEFAULT_THEME;
  });
  const [rotation, setRotation] = useState(() =>
    parseFloat(localStorage.getItem('nova.brain.rotation') ?? '2'));
  const [labelMode, setLabelMode] = useState(() =>
    localStorage.getItem('nova.brain.labels') ?? 'auto');

  const pickTheme = (key: string) => {
    setTheme(key);
    localStorage.setItem('nova.brain.theme', key);
  };

  const changeRotation = (v: number) => {
    setRotation(v);
    localStorage.setItem('nova.brain.rotation', String(v));
    rendererRef.current?.configure?.({ rotationSpeed: v });
  };

  const cycleLabels = () => {
    const next = labelMode === 'auto' ? 'on' : labelMode === 'on' ? 'off' : 'auto';
    setLabelMode(next);
    localStorage.setItem('nova.brain.labels', next);
    rendererRef.current?.configure?.({ labelMode: next });
  };

  const openDetail = useCallback(async (id: string | null) => {
    if (id === null) {
      setDetail(null); // click-away on empty space closes the pane
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

    const renderer = THEMES[theme].create(canvas, { onNodeClick: openDetail });
    rendererRef.current = renderer;
    renderer.configure?.({
      rotationSpeed: parseFloat(localStorage.getItem('nova.brain.rotation') ?? '2'),
      labelMode: localStorage.getItem('nova.brain.labels') ?? 'auto',
    });

    const size = () =>
      renderer.resize(window.innerWidth - CHAT_WIDTH, window.innerHeight);
    size();
    window.addEventListener('resize', size);

    let cancelled = false;
    const load = async () => {
      try {
        const [graph, s] = await Promise.all([getMemoryGraph(), getMemoryStats()]);
        if (!cancelled) {
          renderer.setData(graph.nodes, graph.edges);
          setStats(s);
        }
      } catch (err) {
        console.error('brain refresh failed:', err);
      }
    };
    load();
    const interval = setInterval(load, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('resize', size);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [theme, openDetail]);

  const fm = detail?.frontmatter ?? {};
  const badge = TYPE_BADGE[fm.type] ?? TYPE_BADGE.topic;

  return (
    <div className="relative w-full h-screen overflow-hidden bg-stone-950">
      <canvas ref={canvasRef} className="absolute top-0 left-0" />

      <div className="absolute top-4 left-4 z-10 flex items-center gap-3">
        {stats && (
          <div className="px-3 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-xs font-mono text-stone-400 space-x-3">
            <span className="text-teal-400">{stats.topic ?? 0} topics</span>
            <span className="text-amber-400">{stats.skill ?? 0} skills</span>
            <span>{stats.journal ?? 0} journals</span>
          </div>
        )}
        <div className="flex rounded-lg overflow-hidden border border-stone-700 bg-stone-900/80 backdrop-blur text-xs">
          {Object.entries(THEMES).map(([key, t]) => (
            <button
              key={key}
              onClick={() => pickTheme(key)}
              className={`px-3 py-2 transition ${
                theme === key
                  ? 'bg-teal-700/60 text-teal-200'
                  : 'text-stone-400 hover:text-stone-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="px-3 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-stone-400 hover:text-teal-300 text-sm"
          title="Settings & Automations"
          aria-label="Settings"
        >
          ⚙
        </button>
        {theme === 'galaxy' && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-xs text-stone-400">
            <span title="Rotation speed">spin</span>
            <input
              type="range"
              min={0}
              max={6}
              step={0.25}
              value={rotation}
              onChange={e => changeRotation(parseFloat(e.target.value))}
              className="w-24 accent-teal-500"
            />
            <button
              onClick={cycleLabels}
              className="px-2 py-0.5 rounded border border-stone-700 text-stone-300 hover:text-white capitalize"
              title="Label visibility: auto = titles up close, categories zoomed out"
            >
              labels: {labelMode}
            </button>
          </div>
        )}
      </div>

      {/* Node detail — the graph is a metadata index; full content on demand */}
      {detail && (
        <aside className="absolute top-16 left-4 bottom-4 z-20 w-[26rem] max-w-[calc(100vw-27rem)] flex flex-col rounded-xl bg-stone-900/90 backdrop-blur border border-stone-700 shadow-2xl">
          <header className="px-4 py-3 border-b border-stone-700 flex items-start justify-between gap-2">
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

          <div className="flex-1 overflow-y-auto nice-scroll px-4 py-3 text-sm text-stone-300">
            {fm.description && (
              <p className="text-stone-400 italic mb-3">{fm.description}</p>
            )}
            <Markdown>{detail.content}</Markdown>
          </div>

          <footer className="px-4 py-2.5 border-t border-stone-700 flex items-center justify-between gap-2 text-xs">
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
        </aside>
      )}

      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}

      <ChatPanel />
    </div>
  );
}
