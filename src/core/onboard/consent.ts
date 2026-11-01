// Reading consent in setup's own words (M10f review, finding 1): where to look, and what to bring in.
// Consent is explicit and fails closed. Anything that isn't an unambiguous yes is a no, or a question
// back:
//   - a negation before a thing (not, no, don't, without, except, never, nor) leaves it out;
//   - "only" or "just" leaves out everything not named;
//   - a general yes ("sure", "all", "yes") with exceptions is everything but those;
//   - a refusal of one thing is not a yes to the rest;
//   - a mention and a bare no together ("network? no") are unclear.
// Pure: setup asks these, and acts only on what they return.
import type { Source } from './sources.ts';

const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
// Clauses: a negation reaches only as far as its own clause.
const clauses = (s: string) => s.split(/[,;.?!:]|\bbut\b/i).map((c) => c.trim()).filter(Boolean);
const NEG = /\b(not|no|don't|dont|do not|without|except|never|nor|exclude|excluding|skip)\b/i;
const BARE_NO = /^(no|nope|nah|not now|no thanks?|skip|nothing|neither|none|don't|dont|do not)\b/i;
const YES = /^(y|yes|yeah|yep|sure|ok(ay)?|please|go ahead|do it|all|everything|all of (it|them))\b/i;
const ONLY = /\b(only|just)\b/i;

// True when a negation comes before `at` in the clause.
const negatedAt = (clause: string, at: number) => NEG.test(clause.slice(0, at));
function mention(clause: string, re: RegExp): { at: number } | null {
  const m = re.exec(clause);
  return m ? { at: m.index } : null;
}

export type Scope = 'device' | 'network' | 'none' | 'unclear';
// Whether the words name this computer, not the network (so a plain yes can be told from it).
export const mentionsDevice = (input: string): boolean => /\b(this (computer|machine|one|device)|here|locally)\b/i.test(norm(input));
const NETWORK = /\b(network|lan|wi-?fi)\b/i;
const DEVICE = /\b(this (computer|machine|one|device)|here|locally)\b/i;
const BOTH = /\bboth\b/i;

// Where to look: this computer, the network too, nowhere, or unclear (ask again).
export function readScope(input: string): Scope {
  const text = norm(input);
  if (!text) return 'unclear';
  let netYes = false, netNo = false, devYes = false, devNo = false, bareNo = false, general = false, exclusive = false;
  clauses(text).forEach((c, i) => {
    if (i === 0 && YES.test(c) && !/^(all|everything)\b/i.test(c)) general = true;
    const net = mention(c, NETWORK);
    const dev = mention(c, DEVICE);
    const both = mention(c, BOTH);
    if (net) { if (negatedAt(c, net.at)) netNo = true; else netYes = true; }
    if (both) { if (negatedAt(c, both.at)) { netNo = true; } else { netYes = true; devYes = true; } }
    if (dev) { if (negatedAt(c, dev.at)) devNo = true; else { devYes = true; if (ONLY.test(c)) exclusive = true; } }
    if (!net && !dev && !both && BARE_NO.test(c)) bareNo = true;
  });
  if (bareNo) return netYes || devYes || general ? 'unclear' : 'none';
  if (devNo) return 'unclear';
  if (netYes) return netNo || exclusive ? 'unclear' : 'network';
  if (devYes || general) return 'device';
  return 'unclear';
}

const KIND: Record<Source['kind'], RegExp> = { notes: /\bnotes?\b/i, calendar: /\b(calendars?|events?|ics)\b/i, bookmarks: /\bbookmarks?\b/i };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type Picks = { kind: 'picked'; ids: string[] } | { kind: 'none' } | { kind: 'unclear' };

// What to bring in, of the sources offered. A source's own label (what a screen sends) is matched
// exactly, case and all: on Linux, ~/Notes and ~/notes are different folders.
export function readPicks(input: string, sources: readonly Source[]): Picks {
  let text = norm(input);
  if (!text) return { kind: 'unclear' };
  const yes = new Set<string>();
  const no = new Set<string>();
  // Labels first, then they are taken out so their words (and commas) aren't read again.
  for (const s of [...sources].sort((a, b) => b.label.length - a.label.length)) {
    const at = text.indexOf(s.label);
    if (at < 0) continue;
    const before = text.slice(0, at);
    const clause = before.slice(Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.toLowerCase().lastIndexOf(' but ')) + 1);
    (NEG.test(clause) ? no : yes).add(s.id);
    text = `${text.slice(0, at)} ${text.slice(at + s.label.length)}`;
  }
  let general = false, exclusive = false, bareNo = false;
  clauses(text).forEach((c, i) => {
    if (i === 0 && YES.test(c)) general = true;
    let any = false;
    for (const kind of Object.keys(KIND) as Source['kind'][]) {
      const m = mention(c, KIND[kind]);
      const ofKind = sources.filter((s) => s.kind === kind);
      // An app named in the clause narrows a kind to that app's source ("Chrome bookmarks").
      const apps = ofKind.filter((s) => s.app && new RegExp(`\\b${escape(s.app)}\\b`, 'i').test(c));
      if (m) {
        any = true;
        for (const s of apps.length ? apps : ofKind) (negatedAt(c, m.at) ? no : yes).add(s.id);
        if (!negatedAt(c, m.at) && ONLY.test(c)) exclusive = true;
      }
    }
    // An app named alone ("not Firefox").
    for (const s of sources) {
      if (!s.app) continue;
      const m = mention(c, new RegExp(`\\b${escape(s.app)}\\b`, 'i'));
      if (!m || KIND[s.kind].test(c)) continue;
      any = true;
      (negatedAt(c, m.at) ? no : yes).add(s.id);
    }
    if (!any && BARE_NO.test(c)) bareNo = true;
  });
  for (const id of no) yes.delete(id);
  if (bareNo) return yes.size || general ? { kind: 'unclear' } : { kind: 'none' };
  const picked = general && !exclusive ? sources.filter((s) => !no.has(s.id)).map((s) => s.id) : sources.filter((s) => yes.has(s.id)).map((s) => s.id);
  return picked.length ? { kind: 'picked', ids: picked } : { kind: 'unclear' };
}
