/** React around `engine.ts`, and nothing else.
 *
 *  Three deliberately separate effects, because the mount effect must have an
 *  empty dependency array: DATA MUST NEVER RECREATE THE ENGINE. A simulation
 *  torn down and rebuilt on every poll or selection change loses every node
 *  position, and the graph re-explodes in the operator's face.
 */

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import type { GraphEdge, GraphNode } from '../../api';
import { createVaultGraph, type VaultGraphEngine } from './engine';

export interface ForceGraphHandle {
  fit(): void;
  focus(id: string): void;
  zoomBy(f: number): void;
}

export interface ForceGraphProps {
  /** Must be referentially stable — memoise in the parent, or the engine
   *  re-seeds its layout on every render. */
  nodes: GraphNode[];
  links: GraphEdge[];
  selected: string | null;
  dimmed: Set<string> | null;
  paused?: boolean;
  onPick: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  className?: string;
}

export const ForceGraph = forwardRef<ForceGraphHandle, ForceGraphProps>(function ForceGraph(
  { nodes, links, selected, dimmed, paused = false, onPick, onHover, className }, ref,
) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const eng = useRef<VaultGraphEngine | null>(null);
  // Callbacks reach the engine through a ref: they are fresh arrows every
  // render, and depending on them would tear the simulation down.
  const cb = useRef({ onPick, onHover });
  cb.current = { onPick, onHover };

  useEffect(() => {
    const canvas = cv.current;
    const box = wrap.current;
    if (!canvas || !box) return;
    const e = createVaultGraph(canvas, {
      onPick: id => cb.current.onPick(id),
      onHover: id => cb.current.onHover?.(id),
    });
    eng.current = e;
    // Observe the WRAPPER, not the canvas: a canvas sized by its width/height
    // attributes does not report layout changes usefully.
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      e.resize(width, height, window.devicePixelRatio || 1);
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      e.destroy();
      eng.current = null;
    };
  }, []);

  useEffect(() => { eng.current?.setData(nodes, links); }, [nodes, links]);
  useEffect(() => { eng.current?.setSelected(selected); }, [selected]);
  useEffect(() => { eng.current?.setDim(dimmed); }, [dimmed]);
  useEffect(() => { eng.current?.setPaused(paused); }, [paused]);

  useImperativeHandle(ref, () => ({
    fit: () => eng.current?.fit(),
    focus: (id: string) => eng.current?.focus(id),
    zoomBy: (f: number) => eng.current?.zoomBy(f),
  }), []);

  return (
    <div ref={wrap} className={`relative min-w-0 min-h-0 ${className ?? ''}`}>
      <canvas ref={cv} className="absolute inset-0 touch-none" />
    </div>
  );
});
