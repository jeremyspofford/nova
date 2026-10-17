// Comment anchors on Markdown pages (FR-036): a comment points at the whole page, a text range
// (character offsets plus the quoted text) or a block (a paragraph, list, table, code fence...).
// Every save moves anchors forward to the new text: a range follows its quote to the nearest
// occurrence, a block follows the block that still starts with its quote; when the text is gone
// the comment is detached rather than pointing at the wrong words.
import { NovaError, type CommentAnchor } from '@nova/shared';

export interface Block {
  start: number;
  end: number;
  text: string;
}

const QUOTE_MAX = 200;

/** Top-level Markdown blocks: runs of non-blank lines; a fenced code block is one block. */
export function blocksOf(content: string): Block[] {
  const out: Block[] = [];
  const lines = content.split('\n');
  let offset = 0;
  let cur: { start: number; end: number } | null = null;
  let fence: string | null = null;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (cur) cur.end = lineEnd;
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      if (cur) out.push({ ...cur, text: content.slice(cur.start, cur.end) });
      cur = { start: lineStart, end: lineEnd };
      continue;
    }
    if (!line.trim()) {
      if (cur) out.push({ ...cur, text: content.slice(cur.start, cur.end) });
      cur = null;
      continue;
    }
    if (cur) cur.end = lineEnd;
    else cur = { start: lineStart, end: lineEnd };
  }
  if (cur) out.push({ ...cur, text: content.slice(cur.start, cur.end) });
  return out;
}

/**
 * Check an anchor against the text it was taken from and normalize it: a range must quote the
 * text at its offsets; a block anchor gets the block's own opening words as its quote.
 */
export function checkAnchor(anchor: CommentAnchor, content: string): CommentAnchor {
  switch (anchor.kind) {
    case 'page':
      return anchor;
    case 'range': {
      if (anchor.end > content.length || content.slice(anchor.start, anchor.end) !== anchor.quote)
        throw new NovaError('validation', 'the quoted text is not at that place in the page', {
          details: { reason: 'anchor_mismatch' },
        });
      return anchor;
    }
    case 'block': {
      const b = blocksOf(content)[anchor.index];
      if (!b)
        throw new NovaError('validation', `the page has no block ${anchor.index}`, {
          details: { reason: 'anchor_mismatch' },
        });
      return { kind: 'block', index: anchor.index, quote: b.text.slice(0, QUOTE_MAX) };
    }
  }
}

/** A range anchor for the first occurrence of `quote` (agents comment by quoting). */
export function anchorForQuote(content: string, quote: string): CommentAnchor | null {
  const q = quote.slice(0, 2000);
  if (!q.trim()) return null;
  const at = content.indexOf(q);
  return at < 0 ? null : { kind: 'range', start: at, end: at + q.length, quote: q };
}

function occurrences(text: string, quote: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(quote); at >= 0 && out.length < 1000; at = text.indexOf(quote, at + 1))
    out.push(at);
  return out;
}

/** Move an anchor from one version's text to the next one's. */
export function reanchor(
  anchor: CommentAnchor,
  next: string,
): { anchor: CommentAnchor; detached: boolean } {
  switch (anchor.kind) {
    case 'page':
      return { anchor, detached: false };
    case 'range': {
      const hits = occurrences(next, anchor.quote);
      if (!hits.length) return { anchor, detached: true };
      const best = hits.reduce((a, b) =>
        Math.abs(b - anchor.start) < Math.abs(a - anchor.start) ? b : a,
      );
      return {
        anchor: {
          kind: 'range',
          start: best,
          end: best + anchor.quote.length,
          quote: anchor.quote,
        },
        detached: false,
      };
    }
    case 'block': {
      const blocks = blocksOf(next);
      let best = -1;
      blocks.forEach((b, i) => {
        // The same opening words: unchanged, or edited further in (at least 12 shared chars).
        const head = b.text.slice(0, 40);
        const same =
          b.text.startsWith(anchor.quote) || (head.length >= 12 && anchor.quote.startsWith(head));
        if (!same) return;
        if (best < 0 || Math.abs(i - anchor.index) < Math.abs(best - anchor.index)) best = i;
      });
      if (best < 0) return { anchor, detached: true };
      return {
        anchor: { kind: 'block', index: best, quote: blocks[best]!.text.slice(0, QUOTE_MAX) },
        detached: false,
      };
    }
  }
}
