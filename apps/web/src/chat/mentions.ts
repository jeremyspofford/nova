// `@`-mentions in the composer (FR-022, docs/04 §3): finding the `@query` at the caret, ranking
// the Hub's candidates fuzzily, and grouping them for the popover (files, folders, MCP servers,
// tools, skills).
import type { MentionCandidate, MentionKind } from '@nova/shared';
import type { IconName } from '@nova/ui';

export interface MentionToken {
  /** Index of the `@`. */
  start: number;
  /** End of the token (the caret, or the end of the word the caret is in). */
  end: number;
  /** Text typed after the `@`, up to the caret. */
  query: string;
}

/** The `@query` the caret is in: an `@` at the start or after whitespace, with no space after. */
export function mentionAt(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]{0,100})$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  const rest = /^[^\s@]*/.exec(text.slice(caret))?.[0] ?? '';
  return { start: caret - query.length - 1, end: caret + rest.length, query };
}

/** Higher is better; null when `query` is not even a subsequence of `text`. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  const at = t.indexOf(q);
  if (at >= 0) return 2 - Math.min(at, 999) / 1000;
  // Subsequence: each query character in order, closer together scores higher.
  let i = 0;
  let first = -1;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] !== q[i]) continue;
    if (first < 0) first = j;
    last = j;
    i++;
  }
  if (i < q.length) return null;
  return 1 - Math.min(last - first, 999) / 1000;
}

const score = (q: string, c: MentionCandidate) =>
  Math.max(fuzzyScore(q, c.label) ?? -1, fuzzyScore(q, c.ref) ?? -1);

/** Best matches first; the Hub's order breaks ties. Candidates are kept even without a match. */
export function rankMentions(items: MentionCandidate[], query: string): MentionCandidate[] {
  return items
    .map((c, i) => ({ c, i, s: score(query, c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

/** Only the candidates that match `query` (used while the Hub's answer is on its way). */
export function filterMentions(items: MentionCandidate[], query: string): MentionCandidate[] {
  return rankMentions(
    items.filter((c) => score(query, c) >= 0),
    query,
  );
}

export const MENTION_GROUPS: readonly { kind: MentionKind; label: string }[] = [
  { kind: 'file', label: 'Files' },
  { kind: 'folder', label: 'Folders' },
  { kind: 'mcp_server', label: 'MCP servers' },
  { kind: 'tool', label: 'Tools' },
  { kind: 'skill', label: 'Skills' },
];

export const MENTION_ICON: Record<MentionKind, IconName> = {
  file: 'file',
  folder: 'folder',
  mcp_server: 'server',
  tool: 'tool',
  skill: 'artifact',
};

export interface MentionGroup {
  kind: MentionKind;
  label: string;
  items: MentionCandidate[];
}

/** Candidates in group order; ranking order is kept inside each group. */
export function groupMentions(items: MentionCandidate[]): MentionGroup[] {
  return MENTION_GROUPS.map((g) => ({
    ...g,
    items: items.filter((c) => c.kind === g.kind),
  })).filter((g) => g.items.length > 0);
}

/** The most mentions one message may carry (`sendMessageSchema`). */
export const MAX_MENTIONS = 20;
