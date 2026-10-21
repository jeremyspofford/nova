// Memory search over dated notes (home/memory/YYYY-MM-DD.md).
// MEMORY.md is always in context; this finds the day-level detail that
// matches the message. Plain keyword overlap: the files are small, and the
// result has to be explainable ("recalled from Tuesday's note").
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its ' +
  'just me my no not of on or our so that the their them then there these they this to was we were what when where ' +
  'which who why will with would you your about after again all also am any because been before being both each few ' +
  'more most other over same should some such than too very nova please tell know want need like get got make').split(' '));

export function terms(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])]
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => !STOP.has(w));
}

function chunks(text) {
  // Each bullet is its own memory; other text splits on blank lines.
  const out = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() && !/^#/.test(l.trim()));
    if (lines.every((l) => /^\s*[-*]\s/.test(l))) out.push(...lines.map((l) => l.replace(/^\s*[-*]\s+/, '')));
    else if (lines.length) out.push(lines.join(' '));
  }
  return out.map((c) => c.trim()).filter((c) => c.length > 0 && !c.startsWith('<!--'));
}

export function searchMemory(home, query, { limit = 3 } = {}) {
  const dir = join(home, 'memory');
  const q = terms(query);
  if (!q.length || !existsSync(dir)) return [];
  const need = q.length <= 2 ? 1 : 2;
  const hits = [];
  for (const file of readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()) {
    for (const text of chunks(readFileSync(join(dir, file), 'utf8'))) {
      const have = new Set(terms(text));
      const score = q.filter((w) => have.has(w)).length;
      if (score >= need) hits.push({ source: `memory/${file}`, text: text.length > 400 ? `${text.slice(0, 400)}…` : text, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ source, text }) => ({ source, text }));
}
