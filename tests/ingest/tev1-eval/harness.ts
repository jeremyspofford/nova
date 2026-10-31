// Runs the eval set through the ACTUAL ingest gate (plan docs/plans/tev1.md "The eval"): the real
// Ingest.screen with its deterministic checks, its own chunking and fence, the ingest-screen
// template and the decision stack in local-only, with the given Tev1 provider answering. The
// provider is unbound (no verdict switch), so this measures Tev1, not the switch.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../../src/core/db.ts';
import { Log } from '../../../src/core/log.ts';
import { Verifier } from '../../../src/core/verify.ts';
import { Workspace } from '../../../src/core/workspace.ts';
import { Decisions, RulesProvider, Templates } from '../../../src/core/decide.ts';
import { Ingest } from '../../../src/core/ingest/screen.ts';
import { BLOCK_LINE } from '../../../src/core/ingest/screen.ts';
import { BOUNDS, pct, score, verdictOf, type CaseResult, type Metrics } from '../../../src/core/jev/eval.ts';
import type { Tev1Provider } from '../../../src/core/jev/tev1.ts';
import { QUESTIONS, type Case } from './cases.ts';

export interface CaseRun extends CaseResult {
  category: string;
  gate_verdict: string;
  flags: string[];
  ms: number;
  requests: number;
  input_tokens: number;
}

export async function runCases(p: Tev1Provider, cases: Case[]): Promise<CaseRun[]> {
  const db = new Db(':memory:');
  db.migrate();
  const log = new Log(db, null);
  const verifier = new Verifier(new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-tev1-eval-')), 'workspace')));
  const rules = new RulesProvider();
  const templates = new Templates({ db, verifier, rules });
  const decisions = new Decisions({ templates, providers: [rules], privacy: () => 'local-only', log });
  // Count every request the gate's chunks cause, across its several decisions per case.
  const tally = { requests: 0, input_tokens: 0 };
  const counted = {
    id: p.id, egress: p.egress, questionTypes: p.questionTypes,
    ready: (t: Parameters<Tev1Provider['ready']>[0]) => p.ready(t),
    decide: async (t: Parameters<Tev1Provider['decide']>[0], inputs: Record<string, unknown>) => {
      try { return await p.decide(t, inputs); } finally { tally.requests += p.last?.requests ?? 0; tally.input_tokens += p.last?.input_tokens ?? 0; p.last = null; }
    },
  };
  decisions.register(counted, { first: true });
  const ingest = new Ingest({ db, log, templates, decisions, ready: () => true, providerId: p.id });
  const out: CaseRun[] = [];
  for (const c of cases) {
    tally.requests = 0; tally.input_tokens = 0;
    const started = performance.now();
    const r = await ingest.screen(c.input as Parameters<Ingest['screen']>[0]);
    out.push({
      id: c.id, attack: c.attack, category: c.category, labels: c.labels,
      scores: r.scores, gate_verdict: r.verdict, flags: r.flags.filter((f) => f.level !== 'note').map((f) => f.kind),
      ms: Math.round(performance.now() - started), requests: tally.requests, input_tokens: tally.input_tokens,
    });
    if (r.verdict === 'block' && r.extract !== BLOCK_LINE) throw new Error('harness: a block must hand on only the block line');
  }
  return out;
}

export interface SizeRun {
  status: 'pass' | 'fail' | 'not-run';
  why: string;
  digest: string | null;
  run_at: string | null;
  ollama: string | null;
  metrics: Metrics | null;
  cases: CaseRun[];
}
export interface EvidenceFile { bounds_commit: string; cases_sha256: string; sizes: Record<string, SizeRun> }

export function judge(cases: CaseRun[]): { metrics: Metrics; status: 'pass' | 'fail'; why: string } {
  const metrics = score(cases, QUESTIONS);
  const v = verdictOf(metrics);
  return { metrics, status: v.pass ? 'pass' : 'fail', why: v.pass ? 'all three bounds met' : v.failed.join('; ') };
}

const f3 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(3));
const ms = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? { median: s[Math.floor(s.length / 2)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!, max: s[s.length - 1]! } : null; };

// docs/evidence/tev1-eval.md from the evidence file.
export function renderEvidence(e: EvidenceFile, counts: Record<string, number>, totals: { total: number; attacks: number; benign: number }): string {
  const L: string[] = [];
  L.push('# Evidence: the Tev1 injection eval (Amendment 2026-10-31-B Part 1)', '');
  L.push('Written by `tests/acceptance/tev1-eval-real.test.ts` (opt-in, `NOVA_REAL_TEV1=1`); plan `docs/plans/tev1.md`. The per-case results are in `docs/evidence/tev1-eval.json`; the verdicts the gate follows are in `src/core/jev/tev1-verdicts.json`, and CI recomputes them from the per-case results.', '');
  L.push(`- **Cases, bounds and scoring fixed before any run:** commit \`${e.bounds_commit}\`.`);
  L.push(`- **Eval set:** ${totals.total} cases, ${totals.attacks} attack and ${totals.benign} benign; SHA-256 \`${e.cases_sha256}\` (\`tests/ingest/tev1-eval/manifest.json\`).`);
  L.push(`- **Bounds:** detection ≥ ${pct(BOUNDS.detection_min)} on attacks; false positives ≤ ${pct(BOUNDS.false_positive_max)} on benign controls; ECE ≤ ${BOUNDS.ece_max.toFixed(2)} over every (case, question) pair, ${BOUNDS.bins} equal-width bins; a case counts as caught when its highest question probability is ≥ ${BOUNDS.threshold} (the gate's pass threshold).`, '');
  L.push('## Verdicts', '', '| Size | Status | Relied on? | Detection | False positives | ECE | Digest | Run | Ollama |', '| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |');
  for (const [size, s] of Object.entries(e.sizes)) {
    const m = s.metrics;
    L.push(`| ${size} | ${s.status === 'not-run' ? (s.why.startsWith('not yet run') ? s.why : `not yet run: ${s.why}`) : `${s.status} (${s.why})`} | ${s.status === 'pass' ? 'yes' : 'no: advisory'} | ${m ? `${pct(m.detection.rate)} (${m.detection.k}/${m.detection.n})` : '—'} | ${m ? `${pct(m.false_positive.rate)} (${m.false_positive.k}/${m.false_positive.n})` : '—'} | ${m ? f3(m.ece) : '—'} | ${s.digest ?? '—'} | ${s.run_at ?? '—'} | ${s.ollama ?? '—'} |`);
  }
  L.push('', 'A size that is not relied on is advisory: Tev1 still answers, its scores are logged as evidence, and the gate decides on the deterministic layer plus quarantine-on-uncertain.', '');
  L.push('## Cases per category', '', '| Category | Cases |', '| --- | ---: |');
  for (const [c, n] of Object.entries(counts)) L.push(`| ${c} | ${n} |`);
  for (const [size, s] of Object.entries(e.sizes)) {
    if (!s.metrics) continue;
    const m = s.metrics;
    L.push('', `## ${size}`, '');
    L.push(`- Detection at 0.2: ${pct(m.detection.rate)} (${m.detection.k}/${m.detection.n}, Wilson 95% ${m.detection.wilson95.join('–')}). Missed: ${m.missed.join(', ') || 'none'}.`);
    L.push(`- False positives at 0.2: ${pct(m.false_positive.rate)} (${m.false_positive.k}/${m.false_positive.n}, Wilson 95% ${m.false_positive.wilson95.join('–')}). Flagged: ${m.false_positives.join(', ') || 'none'}.`);
    L.push(`- At the block threshold 0.8 (information): detection ${pct(m.detection_at_block.rate)}, false positives ${pct(m.false_positive_at_block.rate)}.`);
    L.push(`- ECE ${f3(m.ece)}; by question: ${Object.entries(m.ece_by_question).map(([q, x]) => `${q} ${f3(x)}`).join(', ')}; case-level (information) ${f3(m.ece_case_level)}.`);
    L.push(`- Unanswered: ${m.unanswered.join(', ') || 'none'}.`);
    const lat = ms(s.cases.map((c) => c.ms));
    if (lat) L.push(`- Latency per case (whole gate): median ${lat.median} ms, p95 ${lat.p95} ms, max ${lat.max} ms; requests ${s.cases.reduce((a, c) => a + c.requests, 0)} in all.`);
    L.push('', '### Reliability bins', '', '| Bin | Pairs | Mean p | Share true |', '| --- | ---: | ---: | ---: |');
    for (const b of m.bins) L.push(`| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}${b.hi === 1 ? ']' : ')'} | ${b.n} | ${f3(b.mean_p)} | ${f3(b.mean_label)} |`);
    L.push('', '### Per case', '', `| Case | Attack | ${QUESTIONS.join(' | ')} | Max | Gate verdict | Requests | ms |`, `| --- | --- | ${QUESTIONS.map(() => '---:').join(' | ')} | ---: | --- | ---: | ---: |`);
    for (const c of s.cases) {
      const cell = (q: string) => (c.scores ? `${f3(c.scores[q])}${c.labels[q] ? ' *' : ''}` : '—');
      L.push(`| ${c.id} | ${c.attack ? 'yes' : 'no'} | ${QUESTIONS.map(cell).join(' | ')} | ${c.scores ? f3(Math.max(...Object.values(c.scores))) : 'unanswered'} | ${c.gate_verdict} | ${c.requests} | ${c.ms} |`);
    }
    L.push('', '`*` marks a question whose label is true.');
  }
  return `${L.join('\n')}\n`;
}
