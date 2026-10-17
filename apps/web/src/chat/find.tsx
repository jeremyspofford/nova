// Find in chat (FR-025): matches are marked while rendering, never by editing the DOM React owns.
// Markdown replies get a small rehype step that wraps matches in <mark data-find>; plain text is
// split the same way. The find bar then walks those marks in document order.
import type { ReactNode } from 'react';

/** A case-insensitive literal pattern for the query, or null for an empty query. */
export function findPattern(query: string): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

/** Split text into plain strings and matches. */
export function splitMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const re = findPattern(query);
  if (!re || !text) return text ? [{ text, hit: false }] : [];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index;
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: m[0], hit: true });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** Plain text with matches marked. */
export function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  if (!query.trim()) return text;
  return splitMatches(text, query).map((p, i) =>
    p.hit ? (
      <mark key={i} className="find-hit" data-find="">
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}

// Minimal hast shapes; only text nodes and children are touched.
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function markNode(node: HastNode, query: string): void {
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      for (const p of splitMatches(child.value, query)) {
        next.push(
          p.hit
            ? {
                type: 'element',
                tagName: 'mark',
                properties: { className: ['find-hit'], dataFind: '' },
                children: [{ type: 'text', value: p.text }],
              }
            : { type: 'text', value: p.text },
        );
      }
    } else {
      markNode(child, query);
      next.push(child);
    }
  }
  node.children = next;
}

/** A rehype plugin that marks matches of `query` in rendered Markdown. */
export function rehypeFind(query: string) {
  return function attacher() {
    return function transform(tree: HastNode) {
      if (findPattern(query)) markNode(tree, query);
    };
  };
}

/** The marked matches inside `root`, in reading order. */
export function findMarks(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>('mark[data-find]')] : [];
}
