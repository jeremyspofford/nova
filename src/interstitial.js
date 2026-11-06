// The Interstitial Research hook (docs/builder-packet/interstitial-research/). It runs only when
// config.features.interstitial is on AND the interstitial-research skill is loaded in the run (the
// runner checks both; with the flag off the skill doesn't exist for Nova and none of this runs).
//
// What it does in such a run:
//   - before each web_search, after the ingest gate's own deterministic outbound check, asks the
//     interstitial.outbound-check template; anything but a trusted "send" withholds the query;
//   - validates the field map the model writes in an ```interstitial-field-map block;
//   - verifies each claim the model writes in an ```interstitial-claims block, once per claim, with
//     interstitial.verify-transfer. A claim may cite only a page fetched in this run (its screened
//     extract, taint kept); anything else fails without a model;
//   - writes the per-run record (SKILL.md §7) as a session-log step, and keeps the counters in
//     ~/workspace/interstitial/state.json that file an improvement proposal for the owner's OK.
// Every judgement goes through the Decision Service (`ask`); nothing here calls a model.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, writeJson } from './core/index.ts';

export const SKILL_ID = 'interstitial-research';
export const VERIFY = 'interstitial.verify-transfer';
export const OUTBOUND = 'interstitial.outbound-check';
export const RELATIONSHIPS = ['shares-problem', 'shares-method', 'shares-substrate', 'opposite-assumption', 'historical-analogue'];
export const PRIVACY_CLASSES = ['public', 'personal-derived', 'sensitive'];
// Within-run overhead caps (SKILL.md §3): skill tokens over core tokens.
export const CAPS = Object.freeze({ quick: 0.15, standard: 0.4, deep: 1 });
// Improvement triggers (SKILL.md §8).
export const TRIGGERS = Object.freeze({ runs: 10, breaches: 3, corrections: 2 });
export const LAYERS = ['Core findings', 'Adjacent findings', 'Interstitial insight', 'Gaps confirmed', 'Checked, nothing there'];
const EXCERPT_MAX = 12_000;
const BLOCK = /```interstitial-(field-map|claims)[ \t]*\r?\n([\s\S]*?)```/g;
// shortcut: a correction is the person's next message opening with (or saying) that the answer was
// wrong; a pattern, recorded as a heuristic. Upgrade to a template once corrections are an eval set.
export const CORRECTION = /^\s*(no\b|nope\b|wrong\b|incorrect\b|actually\b|not (quite|right|true)\b|that['’]?s (not|wrong|incorrect))|\b(you(['’]re| are) wrong|that['’]?s (wrong|incorrect|not right|not true)|isn['’]?t (right|true|correct)|you missed|is a mistake)\b/i;

const order = (a, b) => (PRIVACY_CLASSES.indexOf(a) >= PRIVACY_CLASSES.indexOf(b) ? a : b);
const canon = (u) => { try { const x = new URL(String(u ?? '')); x.hash = ''; return x.href; } catch { return null; } };
const str = (v, max) => typeof v === 'string' && v.trim() && v.length <= max;
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// The field map's schema, checked strictly: every key, every type, every bound. Returns the errors.
export function validateFieldMap(v) {
  const e = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['the field map is not a JSON object'];
  const keys = ['core_fields', 'boundary_conditions', 'adjacent_fields', 'interstitial_questions', 'gap_hypotheses', 'search_matrix'];
  for (const k of Object.keys(v)) if (!keys.includes(k) && k !== 'privacy_class') e.push(`unknown key ${k}`);
  const strings = (k, min, max, len) => {
    if (!Array.isArray(v[k])) return e.push(`${k} must be a list`);
    if (v[k].length < min || v[k].length > max) e.push(`${k} must have ${min} to ${max} entries`);
    v[k].forEach((s, i) => { if (!str(s, len)) e.push(`${k}[${i}] must be text of at most ${len} characters`); });
  };
  strings('core_fields', 1, 5, 120);
  strings('boundary_conditions', 0, 10, 300);
  strings('interstitial_questions', 0, 4, 300);
  strings('gap_hypotheses', 0, 6, 300);
  if (!Array.isArray(v.adjacent_fields) || v.adjacent_fields.length > 5) e.push('adjacent_fields must be a list of at most 5');
  else v.adjacent_fields.forEach((a, i) => {
    if (!a || typeof a !== 'object' || Object.keys(a).some((k) => !['name', 'relationship', 'rationale'].includes(k))) return e.push(`adjacent_fields[${i}] must be {name, relationship, rationale}`);
    if (!str(a.name, 120)) e.push(`adjacent_fields[${i}].name must be text`);
    if (!RELATIONSHIPS.includes(a.relationship)) e.push(`adjacent_fields[${i}].relationship must be one of ${RELATIONSHIPS.join(', ')}`);
    if (!str(a.rationale, 400)) e.push(`adjacent_fields[${i}].rationale must be text`);
  });
  if (!Array.isArray(v.search_matrix) || v.search_matrix.length > 30) e.push('search_matrix must be a list of at most 30');
  else v.search_matrix.forEach((m, i) => {
    if (!m || typeof m !== 'object' || Object.keys(m).some((k) => !['query', 'cell'].includes(k)) || !str(m.query, 200) || !str(m.cell, 80)) e.push(`search_matrix[${i}] must be {query, cell}`);
  });
  if (v.privacy_class !== undefined && !PRIVACY_CLASSES.includes(v.privacy_class)) e.push(`privacy_class must be one of ${PRIVACY_CLASSES.join(', ')}`);
  return e;
}

// shortcut: depth follows the number of adjacent fields (1 Quick, up to 3 Standard, up to 5 Deep);
// upgrade if the skill gets an explicit depth field.
export const depthOf = (map) => (!map ? 'quick' : map.adjacent_fields.length <= 1 ? 'quick' : map.adjacent_fields.length <= 3 ? 'standard' : 'deep');

export function validateClaims(v) {
  if (!Array.isArray(v) || !v.length || v.length > 10) return ['claims must be a list of 1 to 10'];
  const e = [];
  v.forEach((c, i) => {
    if (!c || typeof c !== 'object' || !str(c.claim, 1000) || !str(c.field, 200) || !str(c.source, 2000)) e.push(`claims[${i}] must be {claim, field, source}`);
  });
  return e;
}

// The fenced blocks in what the model wrote, and the text without them.
export function readBlocks(text) {
  const out = { rest: String(text ?? ''), fieldMap: null, claims: null };
  for (const [, kind, body] of String(text ?? '').matchAll(BLOCK)) {
    let value = null;
    let errors = [];
    try { value = JSON.parse(body); } catch { errors = ['not valid JSON']; }
    if (!errors.length) errors = kind === 'field-map' ? validateFieldMap(value) : validateClaims(value);
    out[kind === 'field-map' ? 'fieldMap' : 'claims'] = { value: errors.length ? null : value, errors };
  }
  out.rest = out.rest.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

const probs = (d) => (d?.answers ? Object.fromEntries(Object.entries(d.answers).map(([q, a]) => [q, a.type === 'noul' ? a.noul : null])) : null);
const decisionOf = (d, id) => ({ template_id: d?.template_id ?? id, version: d?.version ?? 1, outcome: d?.outcome ?? null, trust: d?.trust ?? 'none', seat: d?.seat ?? 'stub', model: d?.model ?? null, id: d?.id ?? null });

export class Interstitial {
  // ask: the Decision Service's ask (core.decisionService.ask). ledger: for proposals.
  constructor({ home, ask, ledger = null, skillText = () => '', now = () => new Date() }) {
    this.home = home;
    this.ask = ask;
    this.ledger = ledger;
    this.skillText = skillText;
    this.now = now;
    this.dir = join(home, 'workspace', 'interstitial');
  }

  // A run that follows the skill: its working state. recall: the memory this turn recalled (a topic
  // that brought the person's own notes with it is personal-derived).
  begin({ recall = [] } = {}) {
    return {
      started: Date.now(), privacy_class: recall.length ? 'personal-derived' : 'public',
      field_map: null, field_map_errors: null, searches: [], sources: [], claims: [], claim_errors: null, decisions: [],
      tokens: { core: 0, skill: 0 }, last: 'core', text: '',
    };
  }

  #opts(ir, mode, task) { return { subsystem: 'interstitial-research', task_id: task ?? null, privacy_mode: mode }; }

  // Before a web_search leaves: a trusted "send", or the query stays here.
  async outbound(ir, query, mode, task = null) {
    const q = String(query ?? '').slice(0, 500);
    let d = null;
    try { d = await this.ask(OUTBOUND, { query: q, privacy_class: ir.privacy_class }, this.#opts(ir, mode, task)); } catch { d = null; }
    ir.decisions.push(decisionOf(d, OUTBOUND));
    const send = d?.outcome === 'send';
    const cell = ir.field_map?.search_matrix.find((m) => m.query.trim().toLowerCase() === q.trim().toLowerCase())?.cell ?? 'core';
    ir.searches.push({ query: q, cell, sent: send, outcome: d?.outcome ?? 'withhold', decision: d?.id ?? null });
    ir.last = /^core$/i.test(cell) ? 'core' : 'skill';
    return { send, why: d?.why ?? 'The outbound check gave no answer.' };
  }

  fieldMap(ir, block) {
    if (block.value) {
      ir.field_map = block.value;
      ir.field_map_errors = null;
      if (block.value.privacy_class) ir.privacy_class = order(block.value.privacy_class, ir.privacy_class);
    } else if (!ir.field_map) ir.field_map_errors = block.errors;
  }

  // A page fetched and screened in this run.
  source(ir, { url, origin, screen }) {
    const u = canon(url);
    if (!u || !screen) return;
    ir.sources.push({ url: u, origin, screen: screen.taint?.screen ?? screen.id ?? null, verdict: screen.verdict, taint: screen.taint ?? null, extract: String(screen.extract ?? '') });
  }

  // One Decision Service call per claim. Returns the verdicts as data for the model.
  async verify(ir, claims, mode, task = null) {
    const out = [];
    for (const c of claims) {
      const url = canon(c.source);
      const src = ir.sources.find((s) => s.url === url);
      let v;
      if (!src) v = { outcome: 'discard', why: 'It cites a page that wasn’t fetched in this run.', deterministic: true };
      else if (src.verdict === 'block') v = { outcome: 'discard', why: 'Its source was held back by the ingest screen.', deterministic: true };
      else {
        const excerpt = src.extract.slice(0, EXCERPT_MAX);
        let d = null;
        try { d = await this.ask(VERIFY, { claim: c.claim, claimed_field: c.field, cited_source_excerpt: excerpt }, this.#opts(ir, mode, task)); } catch { d = null; }
        ir.decisions.push(decisionOf(d, VERIFY));
        v = { outcome: d?.outcome ?? 'quarantine', why: d?.why ?? 'The check gave no answer.', probabilities: probs(d), trust: d?.trust ?? 'none', seat: d?.seat ?? 'stub', model: d?.model ?? null, decision: d?.id ?? null, ...(src.extract.length > EXCERPT_MAX ? { clipped: true } : {}) };
      }
      const verified = v.outcome === 'use_established' || v.outcome === 'use_hypothesis';
      out.push({ claim: c.claim, field: c.field, source: url ?? String(c.source).slice(0, 200), taint: src?.taint ?? null, ...v, label: v.outcome === 'use_established' ? 'established' : 'hypothesis', verified });
    }
    ir.claims.push(...out);
    ir.last = 'skill';
    return out;
  }

  // A model call's tokens, counted to the part of the run that led to it.
  tokens(ir, n) { if (Number.isFinite(n) && n > 0) ir.tokens[ir.last] += n; ir.last = 'core'; }

  // The per-run record (SKILL.md §7).
  record(ir, { meter = null } = {}) {
    const depth = ir.field_map ? depthOf(ir.field_map) : 'quick';
    const overhead = ir.tokens.core ? ir.tokens.skill / ir.tokens.core : null;
    const spent = meter?.spent ?? null;
    const body = this.skillText();
    return {
      skill: { id: SKILL_ID, version: 1, sha256: body ? sha256(body).slice(0, 16) : null },
      templates: [{ id: VERIFY, version: 1 }, { id: OUTBOUND, version: 1 }],
      depth,
      ...(ir.field_map ? {} : { depth_why: ir.field_map_errors ? `The field map didn’t validate (${ir.field_map_errors.slice(0, 3).join('; ')}), so this ran at Quick depth, core only.` : 'No field map was written, so this ran at Quick depth, core only.' }),
      privacy_class: ir.privacy_class,
      field_map: ir.field_map,
      ...(ir.field_map_errors ? { field_map_errors: ir.field_map_errors.slice(0, 10) } : {}),
      searches: ir.searches,
      sources: ir.sources.map(({ url, origin, screen, verdict }) => ({ url, origin, screen, verdict })),
      claims: ir.claims.map(({ claim, field, source, outcome, label, verified, probabilities, why, deterministic, trust, seat, model, decision }) => ({ claim, field, source, outcome, label, verified, probabilities: probabilities ?? null, why, ...(deterministic ? { deterministic } : {}), trust: trust ?? null, seat: seat ?? null, model: model ?? null, decision: decision ?? null })),
      ...(ir.claim_errors ? { claim_errors: ir.claim_errors.slice(0, 10) } : {}),
      quarantined: ir.claims.filter((c) => c.outcome === 'quarantine').length,
      discarded: ir.claims.filter((c) => c.outcome === 'discard').length,
      layers: LAYERS.filter((l) => ir.text.toLowerCase().includes(l.toLowerCase())),
      cost: {
        searches: { core: ir.searches.filter((s) => s.sent && s.cell.toLowerCase() === 'core').length, skill: ir.searches.filter((s) => s.sent && s.cell.toLowerCase() !== 'core').length, withheld: ir.searches.filter((s) => !s.sent).length },
        tokens: { core: ir.tokens.core, skill: ir.tokens.skill, total: spent ? spent.tokens_in + spent.tokens_out : null },
        decision_calls: ir.decisions.length,
        overhead, cap: CAPS[depth], breach: overhead !== null && overhead > CAPS[depth],
      },
      elapsed_ms: Date.now() - ir.started,
    };
  }

  // ---- the improvement counters (SKILL.md §8): proposals only ------------------------------------

  state() {
    let s = {};
    try { s = JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8')); } catch { s = {}; }
    const w = s.window ?? {};
    const by = (o) => Object.fromEntries(Object.keys(CAPS).map((d) => [d, count(o?.[d])]));
    return {
      runs: count(s.runs), breaches: by(s.breaches), corrections: count(s.corrections),
      window: { runs: count(w.runs), breaches: by(w.breaches), corrections: count(w.corrections) },
      proposals: Array.isArray(s.proposals) ? s.proposals.filter((p) => p && typeof p.task === 'string').slice(-20) : [],
    };
  }

  #save(s) { mkdirSync(this.dir, { recursive: true }); writeJson(join(this.dir, 'state.json'), s); }

  // A finished run: counted, kept, and a proposal filed when a trigger fires.
  counted(record) {
    const s = this.state();
    s.runs++; s.window.runs++;
    if (record.cost.breach) { s.breaches[record.depth]++; s.window.breaches[record.depth]++; }
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, 'runs.jsonl'), `${JSON.stringify({ at: this.now().toISOString(), ...record })}\n`);
    return this.#maybePropose(s);
  }

  correction() {
    const s = this.state();
    s.corrections++; s.window.corrections++;
    return this.#maybePropose(s);
  }

  #maybePropose(s) {
    const w = s.window;
    const breach = Object.entries(w.breaches).find(([, n]) => n >= TRIGGERS.breaches);
    const why = w.corrections >= TRIGGERS.corrections ? `${w.corrections} corrections from the person on its answers`
      : breach ? `${breach[1]} runs at ${breach[0]} depth over that depth’s cost cap`
      : w.runs >= TRIGGERS.runs ? `${w.runs} logged runs` : null;
    let task = null;
    if (why && this.ledger) {
      task = this.#propose(why, w.runs);
      s.proposals.push({ task: task.id, at: this.now().toISOString(), why });
      s.window = { runs: 0, breaches: Object.fromEntries(Object.keys(CAPS).map((d) => [d, 0])), corrections: 0 };
    }
    this.#save(s);
    return task;
  }

  // A Work Ledger task that waits for the owner's OK. Approving it only writes the proposal (with its
  // run records) into ~/workspace/interstitial/proposals/; the workspace worker can't reach skills/
  // or any template, and nothing is applied.
  #propose(why, runs) {
    let lines = [];
    try { lines = readFileSync(join(this.dir, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-Math.min(Math.max(runs, 1), 20)); } catch { lines = []; }
    const at = this.now().toISOString();
    const path = `interstitial/proposals/${at.replace(/[:.]/g, '-')}.md`;
    const content = `# Interstitial Research: improvement review\n\nWhy now: ${why}.\n\nThis is a proposal only. Apply any change as a new skill version via a builder PR, re-running the trigger set, the golden evals and the battery eval first (VERIFICATION-AND-IMPROVEMENT.md §G). Nothing here edits skills/ or a template, and no privacy rule, ingest rule, never-trigger case or threshold floor may be loosened through this flow.\n\n## Run records (evidence)\n\n\`\`\`jsonl\n${lines.join('\n')}\n\`\`\`\n`;
    return this.ledger.create({
      title: 'Review the Interstitial Research skill',
      owner: 'workspace',
      goal: `The skill’s improvement trigger fired (${why}). Approving writes this proposal and its run records to workspace/${path}; it applies nothing. To change anything, apply as a new skill version via a builder PR.`,
      origin: { kind: 'trigger', ref: SKILL_ID },
      evidence_required: [{ kind: 'read_back', target: `workspace:${path}` }],
      inputs: { action: 'write', path, content },
      privacy_mode: 'local-only',
      approval_tier: 2,
      idempotency_key: `interstitial-proposal:${at}`,
    });
  }

  exists() { return existsSync(this.dir); }
}

// The verdicts, as the model reads them back (data, in a tool result).
export function verdictWords(verdicts) {
  const say = { use_established: 'usable; label it established; it may be called Verified', use_hypothesis: 'usable; label it a hypothesis; it may be called Verified', quarantine: 'uncertain: keep it only labelled uncertain, never Verified', discard: 'discarded: leave it out, and list it under Checked, nothing there' };
  return `Transfer verification, one result per claim:\n${verdicts.map((v, i) => `${i + 1}. ${v.claim} [${v.field}; ${v.source}]: ${say[v.outcome]}. ${v.why}`).join('\n')}`;
}
