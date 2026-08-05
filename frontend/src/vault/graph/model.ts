/** Everything the Vault derives from one `/api/v1/memory/graph` payload.
 *
 *  Pure functions over data the client already holds — 262 nodes and 279 edges
 *  today, so building this costs microseconds and saves four endpoints.
 */

import type { GraphEdge, GraphNode } from '../../api';

/** The backend's normaliser, restated: `links.py key()` is `lower().strip()`
 *  and nothing else. If this drifts, links open the wrong note. */
export const linkKey = (s: string) => (s || '').toLowerCase().trim();

/** A memory graph node's id IS its Files-API path.
 *
 *  `OkfStore.iter_files()` yields `str(p.relative_to(base_dir))` — e.g.
 *  `topics/what-a-nas-is.md` — and `memory.graph()` uses that as `node.id`.
 *  That is byte-identical to `{root:'memory', path}` in `files/api.ts`, so the
 *  graph and the editor address the same thing and there is no mapping table
 *  to keep honest. This function exists to say so, not to translate. */
export const docIdToRef = (docId: string) => ({ root: 'memory', path: docId });

export interface TagCount {
  tag: string;
  docs: string[];
}

export interface VaultIndex {
  nodes: GraphNode[];
  /** `kind === 'link'` only — the authored relationships. */
  links: GraphEdge[];
  byId: Map<string, GraphNode>;
  /** linkKey(title) -> doc_id. Fallback labels are excluded; see below. */
  byTitle: Map<string, string>;
  /** Keys held by more than one note, so an ambiguous link can say so. */
  dupTitles: Set<string>;
  /** doc_id -> the notes that link TO it. */
  inbound: Map<string, string[]>;
  /** doc_id -> the notes it links to. */
  outbound: Map<string, string[]>;
  /** Every tag, most-used first, with its members. */
  tags: TagCount[];
  degree: Map<string, number>;
}

const push = (m: Map<string, string[]>, k: string, v: string) => {
  const a = m.get(k);
  if (a) { if (!a.includes(v)) a.push(v); }
  else m.set(k, [v]);
};

export function buildIndex(nodes: GraphNode[], edges: GraphEdge[]): VaultIndex {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const byTitle = new Map<string, string>();
  const dupTitles = new Set<string>();

  for (const n of nodes) {
    // `memory.graph()` sets `label = fm.get("title", doc_id)`, so a label that
    // EQUALS the id is the no-frontmatter-title fallback. `links.py
    // title_map()` excludes exactly those notes from the resolution namespace
    // — letting the fallback in would put the literal string
    // 'journals/2026-07-13.md' (the one untitled note in the live corpus)
    // where a link could resolve to it, and where a retarget would go looking
    // for it. Empty keys go the same way.
    if (n.label === n.id) continue;
    const k = linkKey(n.label);
    if (!k) continue;
    if (byTitle.has(k)) dupTitles.add(k);
    else byTitle.set(k, n.id);
  }

  // `tag` edges are excluded on purpose: their endpoints are an arbitrary pair
  // from a spanning path, not an authored relationship (see memory.graph and
  // the same filter in Brain.tsx and brain/systems.ts). `subject` is a real
  // claim but not co-membership, so it is kept out of "links" and drawn
  // separately by the engine.
  const links = edges.filter(e => e.kind === 'link');
  const inbound = new Map<string, string[]>();
  const outbound = new Map<string, string[]>();
  const degree = new Map<string, number>();
  for (const e of links) {
    push(outbound, e.source, e.target);
    push(inbound, e.target, e.source);
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // A note may carry the same tag twice — the write path's link pass adopts
  // corpus tags into frontmatter and does not dedupe, so
  // `the-top-claude-code-features-we-use-summary.md` lists `claude-code` and
  // `scalekit` twice each. Carrying that through would double-count the tag
  // and render the same note twice under it.
  const tagMap = new Map<string, string[]>();
  for (const n of nodes) {
    for (const t of new Set(n.tags ?? [])) {
      const a = tagMap.get(t);
      if (a) a.push(n.id); else tagMap.set(t, [n.id]);
    }
  }
  const tags = [...tagMap.entries()]
    .map(([tag, docs]) => ({ tag, docs }))
    .sort((a, b) => b.docs.length - a.docs.length || a.tag.localeCompare(b.tag));

  return { nodes, links, byId, byTitle, dupTitles, inbound, outbound, tags, degree };
}

/** The open note plus everything within `hops` link-steps of it, undirected.
 *
 *  A subgraph, which is why local mode cannot contradict the backend's
 *  clustering: it never asks which component anything belongs to. */
export function neighbourhood(
  index: VaultIndex, docId: string, hops: number,
): { nodes: GraphNode[]; links: GraphEdge[] } {
  if (!index.byId.has(docId)) return { nodes: [], links: [] };
  const seen = new Set([docId]);
  let frontier = [docId];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of [...(index.inbound.get(id) ?? []), ...(index.outbound.get(id) ?? [])]) {
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return {
    nodes: index.nodes.filter(n => seen.has(n.id)),
    links: index.links.filter(e => seen.has(e.source) && seen.has(e.target)),
  };
}
