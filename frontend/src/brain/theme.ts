/** Brain theme registry — the renderer-swap seam.
 *
 * A theme is a factory producing a RendererHandle bound to a canvas. Adding a
 * new theme = write a factory, register it here; Brain.tsx never changes.
 */

import type { GraphNode, GraphEdge } from '../api';
import { createGalaxy } from './galaxy';
import { createGraph2D } from './graph2d';

export interface RendererHandle {
  setData(nodes: GraphNode[], edges: GraphEdge[]): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

export interface RendererOpts {
  /** Fired on a genuine click (not a pan) on a node. */
  onNodeClick?: (id: string) => void;
}

export type RendererFactory = (canvas: HTMLCanvasElement, opts?: RendererOpts) => RendererHandle;

export const THEMES: Record<string, { label: string; create: RendererFactory }> = {
  graph: { label: 'Graph', create: createGraph2D },
  galaxy: { label: 'Galaxy', create: createGalaxy },
};

export const DEFAULT_THEME = 'graph';
