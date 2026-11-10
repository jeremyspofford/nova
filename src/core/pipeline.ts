// Where Nova stands: the owner's pipeline dashboard (docs/builder-packet/
// nova-about-deploy-visibility-delta-2026-11-06.md §2), GENERATED at view time from records the
// repository already keeps, never from a hand-kept progress list:
//   - the roadmap, docs/builder-packet/ROADMAP-AND-GATES.md: its milestones and tracks;
//   - gate evidence, docs/evidence/*.md: a milestone whose gate evidence is filed is merged, unless
//     the file's own result line ("Result: failed" or "partial") says the gate didn't pass;
//   - the ledger, docs/ledger/*.md (one file per merge since 2026-11-06) and the history before it in
//     docs/LEDGER.md's plain-language section: a merge recorded there is merged;
//   - plans, docs/plans/<milestone>.md: a milestone with a plan and no evidence is designed.
// Each item carries the evidence behind its state. A state without evidence is "designed" at best:
// a roadmap section of its own is a design; a milestone only mentioned is "not started".
// Nova has no record of open pull requests (and never asks GitHub), so "in progress" means what the
// files can show: a milestone some of whose phases have gate evidence and some don't, or a series
// ("1 of 3") whose last part isn't in the ledger yet.
//
// Read-only and deterministic: the same files give the same answer (no clock, no git, no network).
// Only files under those folders are read, plain files only, each with a size cap; no path comes
// from the request. A file that doesn't keep its shape is left out and named in `problems`.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPlain } from './changelog.ts';

export const STATES = ['merged', 'progress', 'designed', 'none'] as const;
export type State = (typeof STATES)[number];
export const STATE_WORDS: Record<State, string> = { merged: 'Merged', progress: 'In progress', designed: 'Designed', none: 'Not started' };

export interface Evidence {
  kind: 'gate' | 'ledger' | 'plan' | 'roadmap';
  // Repository-relative, for the person to open; never an absolute path.
  path: string;
  // What the record says it is: a gate's or plan's title, a ledger entry's headline.
  title: string;
  // A ledger entry's own plain-language parts.
  changed?: string;
  now?: string;
  unfinished?: string;
  // A ledger entry's date (YYYY-MM-DD), and the pull request its history entry names.
  date?: string;
  pull?: number;
  // Where the record opens (A-080, F-048): the file at the running commit (or main) in the public
  // repository, and the pull request a history entry names. Built here from the path, never taken
  // from the file, so a link can only open the record it names.
  url?: string;
  pull_url?: string;
  // A gate evidence file's own result line, when it has one: passed, failed or partial; and
  // whether it was run on emulated devices.
  result?: 'passed' | 'failed' | 'partial';
  emulated?: boolean;
}
export interface Item { id: string; name: string; state: State; why: string; evidence: Evidence | null }
export interface Workstream { name: string; source: 'roadmap' | 'ledger'; items: Item[] }
export interface PipelineView { workstreams: Workstream[]; counts: Record<State, number>; sources: string[]; problems: string[] }

export const SOURCES = ['docs/builder-packet/ROADMAP-AND-GATES.md', 'docs/evidence/', 'docs/plans/', 'docs/ledger/', 'docs/LEDGER.md'];
const DOC_MAX = 1024 * 1024;
const HEAD_MAX = 512 * 1024;
const LEDGER_FILE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9.-]*\.md$/;
const HEADLINE = /^\*\*(\d{4}-\d{2}-\d{2}) · ([^·\n]+?) · ([^\n]+?)\*\*$/;
const CODE = /^M(\d+)([a-z]?)$/;

// ---- small readers --------------------------------------------------------------------------------

const list = (dir: string) => { try { return readdirSync(dir).sort(); } catch { return []; } };
const firstHeading = (text: string | null) => (text ?? '').split('\n').find((l) => l.startsWith('# '))?.slice(2).trim() ?? '';
const strip = (s: string) => s.replace(/`/g, '').replace(/\*\*/g, '').trim();

// "M10e" → [10, 'e']; ordering of milestone codes: number, then the parent before its phases.
const codeKey = (c: string) => { const m = CODE.exec(c)!; return [Number(m[1]), m[2] ?? ''] as const; };
const byCode = (a: string, b: string) => { const [na, la] = codeKey(a), [nb, lb] = codeKey(b); return na - nb || (la < lb ? -1 : la > lb ? 1 : 0); };
// Every code from A to B: M0 to M7, or M10a to M10c (the same milestone's phases).
function range(a: string, b: string): string[] {
  const [na, la] = codeKey(a), [nb, lb] = codeKey(b);
  if (!la && !lb && na <= nb) return Array.from({ length: nb - na + 1 }, (_, i) => `M${na + i}`);
  if (na === nb && la && lb && la <= lb) return Array.from({ length: lb.charCodeAt(0) - la.charCodeAt(0) + 1 }, (_, i) => `M${na}${String.fromCharCode(la.charCodeAt(0) + i)}`);
  return [a, b];
}

// A ledger entry: its headline, then "- What changed:", "- What you can now do:", "- Still unfinished:".
// A part runs on over lines indented under it (LEDGER.md's older entries), so a list in "Still
// unfinished" keeps every item, not only its first line.
function entryParts(lines: string[]) {
  const part = (label: string) => {
    const at = lines.findIndex((l) => l.startsWith(`- ${label}:`));
    if (at < 0) return undefined;
    const more: string[] = [];
    for (let i = at + 1; i < lines.length && /^\s{2,}\S/.test(lines[i]!); i++) more.push(lines[i]!.trim());
    return strip([lines[at]!.slice(label.length + 3), ...more].join(' ')) || undefined;
  };
  return { changed: part('What changed') ?? part('What they delivered') ?? part('What it delivered'), now: part('What you can now do'), unfinished: part('Still unfinished') };
}

// ---- the roadmap -----------------------------------------------------------------------------------

interface Section { title: string; code: string | null; name: string; body: string }

// "M10 — Execution Plane (Amendment 2026-10-30-C Part 4)" → "Execution Plane"; a name loses its
// parentheses and an amendment or date after its dash, which say where it came from, not what it is.
function nameOf(title: string, code: string | null): string {
  let t = title.replace(/\s*\([^)]*\)/g, '').trim();
  if (code) t = t.slice(code.length).replace(/^\s*[—:-]\s*/, '');
  const dash = t.split(' — ');
  if (dash.length > 1 && /^(Amendment|\d{4}-\d{2}-\d{2})/.test(dash.at(-1)!)) t = dash.slice(0, -1).join(' — ');
  return t.trim();
}

function sections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      const code = /^(M\d+[a-z]?)\b/.exec(title)?.[1] ?? null;
      cur = { title, code, name: nameOf(title, code), body: '' };
      out.push(cur);
    } else if (cur) cur.body += `${line}\n`;
  }
  return out;
}

// ---- evidence ----------------------------------------------------------------------------------------

interface Found { gates: Map<string, Evidence>; namedGates: { lead: string; ev: Evidence }[]; plans: Map<string, Evidence>; history: Map<string, Evidence> }

function evidenceFiles(root: string, problems: string[]): Pick<Found, 'gates' | 'namedGates'> {
  const gates = new Map<string, Evidence>();
  const namedGates: Found['namedGates'] = [];
  for (const f of list(join(root, 'docs', 'evidence')).filter((f) => f.endsWith('.md'))) {
    const text = readPlain(join(root, 'docs', 'evidence', f), HEAD_MAX);
    if (text === null) continue;
    const title = firstHeading(text);
    if (!title) { problems.push(`docs/evidence/${f} has no "# " title, so it wasn't read as evidence.`); continue; }
    // Gate evidence says so in its title: "M9 gate …", "M10a gate evidence: …", "M5 evidence — …".
    // Its own result line, if it has one: "Result: passed", "**Result:** failed", "Result: partial (emulated)".
    const r = /^\**Result:\**\s*(passed|failed|partial)\b([^\n]*)$/im.exec(text);
    const ev: Evidence = { kind: 'gate', path: `docs/evidence/${f}`, title, ...(r ? { result: r[1]!.toLowerCase() as Evidence['result'], ...(/emulated/i.test(r[2]!) ? { emulated: true } : {}) } : {}) };
    const m = /^(M\d+[a-z]?)\s+(gate|evidence)\b/i.exec(title);
    if (m) { if (!gates.has(m[1]!)) gates.set(m[1]!, ev); continue; }
    const named = /^(.+?)\s+gate\b/i.exec(title);
    if (named) namedGates.push({ lead: named[1]!.toLowerCase(), ev });
  }
  return { gates, namedGates };
}

function planFiles(root: string): Map<string, Evidence> {
  const plans = new Map<string, Evidence>();
  for (const f of list(join(root, 'docs', 'plans'))) {
    const m = /^(M\d+[a-z]?)\.md$/.exec(f);
    if (!m) continue;
    const text = readPlain(join(root, 'docs', 'plans', f), HEAD_MAX);
    if (text !== null) plans.set(m[1]!, { kind: 'plan', path: `docs/plans/${f}`, title: firstHeading(text) || m[1]! });
  }
  return plans;
}

// docs/LEDGER.md's plain-language history (before one file per merge): "**date · #213 · M3: …**"
// and the summaries "**M0 to M7 · #209 to #222 · …**". Either names the milestones it merged.
function history(root: string, problems: string[]): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  const text = readPlain(join(root, 'docs', 'LEDGER.md'), DOC_MAX);
  if (text === null) return out;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const from = lines.findIndex((l) => l === '## What changed (plain language)');
  if (from < 0) { problems.push('docs/LEDGER.md has no "What changed (plain language)" section, so its history wasn’t read.'); return out; }
  const to = lines.findIndex((l, i) => i > from && l.startsWith('## '));
  const part = lines.slice(from + 1, to < 0 ? undefined : to);
  part.forEach((line, i) => {
    if (!line.startsWith('**') || !line.endsWith('**')) return;
    const fields = line.slice(2, -2).split(' · ');
    if (fields.length < 3) return;
    let end = i + 1;
    while (end < part.length && (part[end]!.startsWith('- ') || /^\s{2,}\S/.test(part[end]!))) end++;
    const body = part.slice(i + 1, end);
    const pr = /^#(\d+)/.exec(fields[1]!.trim());
    const ev = (date?: string): Evidence => ({ kind: 'ledger', path: 'docs/LEDGER.md', title: strip(fields.slice(2).join(' · ')), ...entryParts(body), ...(date ? { date } : {}), ...(pr ? { pull: Number(pr[1]) } : {}) });
    const span = /^(M\d+[a-z]?)(?: to (M\d+[a-z]?))?$/.exec(fields[0]!.trim());
    if (span) { for (const c of span[2] ? range(span[1]!, span[2]) : [span[1]!]) if (!out.has(c)) out.set(c, ev()); return; }
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(fields[0]!.trim()) ? fields[0]!.trim() : undefined;
    const head = /^(M\d+[a-z]?):/.exec(fields[2]!.trim());
    if (dated && head && !out.has(head[1]!)) out.set(head[1]!, ev(dated));
  });
  return out;
}

// ---- the roadmap's workstream ---------------------------------------------------------------------

function roadmap(root: string, problems: string[]): Workstream | null {
  const path = 'docs/builder-packet/ROADMAP-AND-GATES.md';
  const text = readPlain(join(root, path), DOC_MAX);
  if (text === null) { problems.push(`${path} isn’t in this build of Nova, so the roadmap isn’t shown.`); return null; }
  const found: Found = { ...evidenceFiles(root, problems), plans: planFiles(root), history: history(root, problems) };
  const secs = sections(text).filter((s) => !/^Sequencing rules\b/i.test(s.title));
  // Every milestone the roadmap names: its own sections, phases it mentions ("M10j") or spans
  // ("M10e–M10k"), and the phases that have a plan or gate evidence of their own.
  const codes = new Set<string>(secs.flatMap((s) => (s.code ? [s.code] : [])));
  for (const m of text.matchAll(/\b(M\d+[a-z])[–-](M\d+[a-z])\b/g)) for (const c of range(m[1]!, m[2]!)) codes.add(c);
  for (const m of text.matchAll(/\bM\d+[a-z]\b/g)) codes.add(m[0]);
  for (const c of [...found.plans.keys(), ...found.gates.keys()]) if (/[a-z]$/.test(c) && codes.has(c.replace(/[a-z]$/, ''))) codes.add(c);
  const phasesOf = (c: string) => [...codes].filter((x) => x !== c && x.replace(/[a-z]$/, '') === c && /[a-z]$/.test(x)).sort(byCode);

  const titled = (c: string) => {
    const t = found.plans.get(c)?.title ?? found.gates.get(c)?.title ?? '';
    return t.replace(/^M\d+[a-z]?\s*(plan|gate evidence|gate|evidence)?\s*(\([^)]*\))?\s*[:—-]?\s*/i, '').replace(/^\(ADR\)\s*[:—-]?\s*/i, '').trim();
  };
  const settle = (id: string, name: string, own: Section | null): Item => {
    const code = own?.code ?? (CODE.test(id) ? id : null);
    if (own && /\(no work scheduled\)/i.test(own.title)) return { id, name, state: 'none', why: 'The roadmap schedules no work for it.', evidence: { kind: 'roadmap', path, title: own.title } };
    const gate = code ? found.gates.get(code) : found.namedGates.find((g) => g.lead === name.toLowerCase() || name.toLowerCase().startsWith(g.lead))?.ev;
    if (gate?.result === 'failed' || gate?.result === 'partial') return { id, name, state: 'progress', why: `Its gate evidence is filed, and says the gate ${gate.result === 'failed' ? 'failed' : 'passed only in part'}.`, evidence: gate };
    if (gate) return { id, name, state: 'merged', why: gate.result === 'passed' ? `Its gate evidence is filed and says the gate passed${gate.emulated ? ', on emulated devices' : ''}.` : 'Its gate evidence is filed; the file states no result line, so this rests on it being filed.', evidence: gate };
    const merged = code ? found.history.get(code) : undefined;
    if (merged) return { id, name, state: 'merged', why: 'The ledger records it merged.', evidence: merged };
    const plan = code ? found.plans.get(code) : undefined;
    if (plan) return { id, name, state: 'designed', why: 'It has a plan, and no gate evidence or ledger entry yet.', evidence: plan };
    if (own) return { id, name, state: 'designed', why: 'The roadmap describes it; nothing records it built yet.', evidence: { kind: 'roadmap', path, title: own.title } };
    return { id, name, state: 'none', why: 'The roadmap names it; it has no plan or evidence yet.', evidence: { kind: 'roadmap', path, title: `${id}, named in the roadmap` } };
  };

  const items: Item[] = [];
  for (const s of secs) {
    const phases = s.code ? phasesOf(s.code) : [];
    const kids = phases.map((c) => { const t = titled(c) || 'a phase the roadmap names'; return settle(c, `${c} · ${t[0]!.toUpperCase()}${t.slice(1)}`, null); });
    const label = s.code ? `${s.code} · ${s.name}` : s.name;
    let item = settle(s.code ?? s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, s);
    // A milestone in phases stands where its phases do: all merged is merged; some is in progress.
    const done = kids.filter((k) => k.state === 'merged').length;
    if (kids.length && done === kids.length) item = { ...item, state: 'merged', why: `All ${kids.length} of its phases are merged.` };
    else if (kids.length && done) item = { ...item, state: 'progress', why: `${done} of its ${kids.length} phases are merged; ${kids.filter((k) => k.state !== 'merged').map((k) => k.id).join(', ')} not yet.` };
    items.push(item, ...kids);
  }
  return { name: 'Roadmap', source: 'roadmap', items };
}

// ---- the ledger's workstreams -----------------------------------------------------------------------

// docs/ledger/<date>-<branch>.md, newest first: each entry's area is its workstream ("UI rebuild
// (design)" is the UI rebuild's). A merge that ships no working capability declares it in its area
// ("(design)", "(ADR)"; docs/ledger/README.md), and tests/ledger-files.test.js holds every entry whose
// headline says so (for the owner's reaction, proposed, not built yet) to that note: it is designed.
// A part of a series ("(2 of 3)") is in progress until its last part is in; everything else in the
// ledger is merged.
function ledger(root: string, problems: string[]): Workstream[] {
  const dir = join(root, 'docs', 'ledger');
  const streams = new Map<string, Workstream>();
  const series = new Map<string, number>(); // area → the highest part merged, for "n of m"
  const entries: { f: string; date: string; area: string; base: string; note: string; headline: string; lines: string[] }[] = [];
  for (const f of list(dir).filter((f) => f !== 'README.md' && f.endsWith('.md')).reverse()) {
    if (!LEDGER_FILE.test(f)) { problems.push(`docs/ledger/${f} isn't named <YYYY-MM-DD>-<branch>.md, so it was left out.`); continue; }
    const text = readPlain(join(dir, f), HEAD_MAX);
    if (text === null) continue;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const h = HEADLINE.exec(lines[0] ?? '');
    if (!h) { problems.push(`docs/ledger/${f} doesn't start with **date · area · what changed**, so it was left out.`); continue; }
    const area = h[2]!.trim();
    const base = area.replace(/\s*\([^)]*\)/g, '').trim() || area;
    const note = /\(([^)]*)\)/.exec(area)?.[1] ?? '';
    const part = /^(\d+) of (\d+)$/.exec(note);
    if (part) series.set(base.toLowerCase(), Math.max(series.get(base.toLowerCase()) ?? 0, Number(part[1])));
    entries.push({ f, date: h[1]!, area, base, note, headline: strip(h[3]!), lines });
  }
  for (const e of entries) {
    const key = e.base.toLowerCase();
    if (!streams.has(key)) streams.set(key, { name: e.base, source: 'ledger', items: [] });
    const part = /^(\d+) of (\d+)$/.exec(e.note);
    const ev: Evidence = { kind: 'ledger', path: `docs/ledger/${e.f}`, title: e.headline, date: e.date, ...entryParts(e.lines.slice(1)) };
    const state: State = designOnly(e.note, e.headline) ? 'designed' : part && (series.get(key) ?? 0) < Number(part[2]) ? 'progress' : 'merged';
    const why = state === 'designed' ? 'A design merged; the ledger has no build for it in this entry.' : state === 'progress' ? `Part ${part![1]} of ${part![2]} is merged; the rest isn’t in the ledger yet.` : 'The ledger records it merged.';
    streams.get(key)!.items.push({ id: e.f.replace(/\.md$/, ''), name: e.headline, state, why, evidence: ev });
  }
  return [...streams.values()];
}

// A ledger entry that ships no working capability: its area note says design or ADR, or its headline
// says it is for the owner's reaction, proposed, or not built yet (the words the note must go with).
export const DESIGN_NOTE = /\b(design|adr)\b/i;
export const DESIGN_WORDS = /\b(not built yet|for (?:the )?owner(?:['’]s)? reaction|proposed for)\b/i;
export const designOnly = (note: string, headline: string) => DESIGN_NOTE.test(note) || DESIGN_WORDS.test(headline);

// The public repository the records are read from, for links that open them.
export const REPOSITORY = 'https://github.com/jeremyspofford/nova';
const linked = (ev: Evidence, ref: string): Evidence => ({ ...ev, url: `${REPOSITORY}/blob/${ref}/${ev.path.split('/').map(encodeURIComponent).join('/')}`, ...(ev.pull ? { pull_url: `${REPOSITORY}/pull/${ev.pull}` } : {}) });

// GET /api/v1/pipeline. `commit`: the running build's, so a link opens the record this build read.
export function pipelineView(root: string, o: { commit?: string | null } = {}): PipelineView {
  const problems: string[] = [];
  const ref = o.commit && /^[0-9a-f]{7,40}$/.test(o.commit) ? o.commit : 'main';
  const workstreams = [roadmap(root, problems), ...ledger(root, problems)].filter((w): w is Workstream => !!w && w.items.length > 0)
    .map((w) => ({ ...w, items: w.items.map((it) => (it.evidence ? { ...it, evidence: linked(it.evidence, ref) } : it)) }));
  const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
  for (const w of workstreams) for (const it of w.items) counts[it.state]++;
  return { workstreams, counts, sources: SOURCES, problems };
}
