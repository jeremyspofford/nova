// Slash commands in the composer (FR-046, docs/04 §3): a `/name` typed at the very start of the
// message completes from the Hub's skills and plugin commands; choosing one inserts `/name `.
import type { SlashCommandView } from '@nova/shared';

export interface SlashToken {
  /** Text typed after the `/`. */
  query: string;
  /** End of the command word. */
  end: number;
}

/** The `/query` at the start of the text while the caret is inside it, or null. */
export function slashAt(text: string, caret: number): SlashToken | null {
  const m = /^\/([A-Za-z0-9_-]{0,64})/.exec(text);
  if (!m) return null;
  const end = m[0].length;
  if (caret < 1 || caret > end) return null;
  // `/name` must stand alone: another `/` or a letter outside the set ends it as plain text.
  const next = text.charAt(end);
  if (next && !/\s/.test(next)) return null;
  return { query: (m[1] ?? '').toLowerCase(), end };
}

/**
 * Commands matching `query`: names that start with it, then names that contain it, then
 * descriptions that contain it. Loose subsequence matches are left out, so a short query stays
 * predictable.
 */
export function filterSlash(
  items: SlashCommandView[],
  query: string,
  limit = 50,
): SlashCommandView[] {
  const q = query.toLowerCase();
  const rank = (c: SlashCommandView): number => {
    if (!q) return 1;
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 3;
    if (name.includes(q)) return 2;
    return c.description.toLowerCase().includes(q) ? 1 : 0;
  };
  return items
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}

/** The text with `/name ` in place of the token, and where the caret goes. */
export function applySlash(
  text: string,
  name: string,
  end: number,
): { text: string; caret: number } {
  const head = `/${name} `;
  const rest = text.slice(end).replace(/^\s+/, '');
  return { text: head + rest, caret: head.length };
}
