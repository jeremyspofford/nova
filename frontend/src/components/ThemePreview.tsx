import { useEffect, useRef } from 'react';
import { THEMES } from '../brain/theme';
import { SAMPLE_NODES, SAMPLE_EDGES } from '../brain/sample';

/** Live mini-preview of a brain theme — the actual renderer on sample data. */
export function ThemePreview({ themeKey, selected, onSelect }: {
  themeKey: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = THEMES[themeKey].create(canvas);
    renderer.resize(220, 130);
    renderer.configure?.({ rotationSpeed: 1.5, labelMode: 'off', labelScale: 0.7 });
    renderer.setData(SAMPLE_NODES, SAMPLE_EDGES);
    return () => renderer.destroy();
  }, [themeKey]);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left rounded-lg overflow-hidden border-2 transition ${
        selected ? 'border-teal-500' : 'border-stone-700 hover:border-stone-500'
      }`}
    >
      <canvas ref={canvasRef} width={220} height={130} className="block pointer-events-none" />
      <div className={`px-2 py-1 text-xs capitalize ${
        selected ? 'bg-teal-900/50 text-teal-200' : 'bg-stone-800 text-stone-400'
      }`}>
        {THEMES[themeKey].label}{selected ? ' ✓' : ''}
      </div>
    </button>
  );
}
