/** The Vault graph's palette.
 *
 *  Local rather than imported from `brain/graph2d.ts`, whose `NODE_COLORS` is
 *  not exported — exporting it would mean editing a file in `brain/`, and that
 *  directory belongs to the renderer lane. Four memory types is the whole
 *  surface here, so a copy is cheaper than a shared module.
 *
 *  Tag colour DOES come from `brain/systems.ts`, imported read-only, so the
 *  Vault, the Atlas and the Universe agree what colour a subject is.
 */

import { tagColor } from '../../brain/systems';
import type { GraphNode } from '../../api';

/** Matches graph2d.ts for the two types that have a fixed meaning. Topics and
 *  skills take their colour from their dominant tag instead, so a cluster
 *  reads as a cluster without the Vault re-deriving one. */
const BY_TYPE: Record<string, string> = {
  journal: '#78716C',   // stone — episodic, dim
  source: '#60A5FA',    // blue — external
  skill: '#FBBF24',     // amber — behaviour
};

const FALLBACK = '#24C9B8';   // teal — knowledge

let palette = new Map<string, string>();

/** Seed the per-node colours from the corpus once, so `NODE_COLOR` stays a
 *  cheap lookup inside the draw loop. */
export function seedColors(nodes: GraphNode[]) {
  palette = new Map(nodes.map(n => [
    n.id,
    BY_TYPE[n.type] ?? (n.tags?.length ? tagColor(n) : FALLBACK),
  ]));
}

export const NODE_COLOR = (type: string, id: string) =>
  palette.get(id) ?? BY_TYPE[type] ?? FALLBACK;

/** Only `link` is drawn by default. `subject` is a true claim about two
 *  documents but never co-membership, so it gets its own dim treatment when
 *  the operator asks for it; `tag` is never drawn — its endpoints are an
 *  arbitrary pair from a spanning path (see memory.graph, Brain.tsx:474-477). */
export const EDGE_COLOR: Record<string, string> = {
  link: 'rgba(36,201,184,0.35)',
  subject: 'rgba(167,139,250,0.22)',
};

export const SELECTED_EDGE = 'rgba(45,212,191,0.6)';
export const SELECTED_RING = '#F5F5F4';
export const LABEL = 'rgba(214,211,209,0.85)';
