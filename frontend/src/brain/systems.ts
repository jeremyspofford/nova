/** Shared memory-layer grouping — the "star systems" computation.
 *
 * The Universe renderer and the Atlas explorer both group memory nodes into
 * connected components over link+tag edges, name each component by its
 * dominant shared tag, and color it from the tag palette. Extracted here so
 * the 3D view and the browser panel can never disagree about what belongs
 * where.
 */

import type { GraphNode, GraphEdge } from '../api';

export const TAG_COLORS = ['#22d3ee', '#4ade80', '#a78bfa', '#fb923c', '#f472b6', '#facc15'];

export const MEMORY_BODY_TYPES = new Set(['topic', 'source']);

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const tagColor = (n: GraphNode) =>
  TAG_COLORS[hashStr(n.tags?.[0] ?? n.id) % TAG_COLORS.length];

export interface MemorySystem {
  /** Dominant shared tag (falls back to the first member's label). */
  name: string;
  color: string;
  /** Deterministic identity: the lexicographically smallest member id. */
  key: string;
  members: GraphNode[];
}

export function computeSystems(nodes: GraphNode[], edges: GraphEdge[]): {
  systems: MemorySystem[];
  rogues: GraphNode[];
} {
  const memNodes = nodes.filter(n => MEMORY_BODY_TYPES.has(n.type));
  const memIds = new Set(memNodes.map(n => n.id));
  const memEdges = edges.filter(e =>
    (e.kind === 'link' || e.kind === 'tag') && memIds.has(e.source) && memIds.has(e.target));

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const id of memIds) parent.set(id, id);
  for (const e of memEdges) {
    const a = find(e.source), b = find(e.target);
    if (a !== b) parent.set(a, b);
  }
  const components = new Map<string, GraphNode[]>();
  for (const n of memNodes) {
    const root = find(n.id);
    (components.get(root) ?? components.set(root, []).get(root)!).push(n);
  }

  const systems = [...components.values()]
    .filter(c => c.length >= 2)
    .map(members => {
      const key = members.map(n => n.id).sort()[0];
      const counts = new Map<string, number>();
      for (const m of members) for (const tag of m.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const name = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
        ?? members[0].label;
      return { name, color: TAG_COLORS[hashStr(name) % TAG_COLORS.length], key, members };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const rogues = [...components.values()].filter(c => c.length === 1).map(c => c[0]);

  return { systems, rogues };
}
