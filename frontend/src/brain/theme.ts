/** Brain theme registry — the renderer-swap seam.
 *
 * A theme is a factory producing a RendererHandle bound to a canvas. Adding a
 * new theme = write a factory, register it here; Brain.tsx never changes.
 */

import type { GraphNode, GraphEdge } from '../api';
import { createGalaxy, GALAXY_LEGEND } from './galaxy';
import { createGraph2D, GRAPH_LEGEND } from './graph2d';
import { createUniverse, UNIVERSE_LEGEND } from './universe';

export interface RendererHandle {
  setData(nodes: GraphNode[], edges: GraphEdge[]): void;
  resize(width: number, height: number): void;
  destroy(): void;
  /** Optional runtime settings (e.g. rotationSpeed, labelMode). */
  configure?(options: Record<string, unknown>): void;
  /** Reset the camera/viewport to frame the whole scene. */
  recenter?(): void;
  /** Navigate to a node (Atlas click): fly the camera there, select it. */
  focusNode?(id: string): void;
}

export interface RendererOpts {
  /** Fired on a genuine click (not a pan/orbit). null = clicked empty space. */
  onNodeClick?: (id: string | null) => void;
}

export type RendererFactory = (canvas: HTMLCanvasElement, opts?: RendererOpts) => RendererHandle;

/** One legend row. `key` ties it to a node type for live counts; rows
 *  without a key are visual vocabulary (flares, disabled, black hole). */
export interface LegendEntry {
  key?: string;
  label: string;
  color: string;
  note?: string;
}

export const THEMES: Record<string, { label: string; create: RendererFactory; legend: LegendEntry[] }> = {
  graph: { label: 'Graph', create: createGraph2D, legend: GRAPH_LEGEND },
  galaxy: { label: 'Galaxy', create: createGalaxy, legend: GALAXY_LEGEND },
  universe: { label: 'Universe', create: createUniverse, legend: UNIVERSE_LEGEND },
};

export const DEFAULT_THEME = 'graph';
