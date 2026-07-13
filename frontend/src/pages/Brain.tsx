import { useEffect, useRef, useState } from 'react';
import { getMemoryGraph, getMemoryStats } from '../api';
import { ChatPanel } from '../chat/ChatPanel';
import { DEFAULT_THEME, THEMES, RendererHandle } from '../brain/theme';

const CHAT_WIDTH = 384; // w-96
const REFRESH_MS = 20000;

export function Brain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RendererHandle | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [theme] = useState(DEFAULT_THEME);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = THEMES[theme].create(canvas);
    rendererRef.current = renderer;

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
  }, [theme]);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-stone-950">
      <canvas ref={canvasRef} className="absolute top-0 left-0" />

      {stats && (
        <div className="absolute top-4 left-4 z-10 px-3 py-2 rounded-lg bg-stone-900/80 backdrop-blur border border-stone-700 text-xs font-mono text-stone-400 space-x-3">
          <span className="text-teal-400">{stats.topic ?? 0} topics</span>
          <span className="text-amber-400">{stats.skill ?? 0} skills</span>
          <span>{stats.journal ?? 0} journals</span>
        </div>
      )}

      <ChatPanel />
    </div>
  );
}
