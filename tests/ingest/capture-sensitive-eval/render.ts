// docs/evidence/capture-sensitive-eval.md from the evidence file. Everything in it comes from the
// run; no case text is ever written, only ids, scores and outcomes.
import { BOUNDS_CS, type CsMetrics } from '../../../src/core/decision-service/eval-capture.ts';
import { CS_QUESTIONS } from '../../../src/core/decision-service/templates/capture-sensitive.ts';
import type { CsRun } from './harness.ts';

export interface CsSize { status: 'pass' | 'fail' | 'not-run'; why: string; deterministic_ok: boolean | null; digest: string | null; ollama: string | null; run_at: string | null; metrics: CsMetrics | null; cases: CsRun[] }
export interface CsEvidence { template: string; version: number; template_commit: string; pre_run_commit: string; cases_sha256: string; sizes: Record<string, CsSize> }

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
const f3 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(3));
const r = (x: { k: number; n: number }) => `${pct(x.n ? x.k / x.n : 0)} (${x.k}/${x.n})`;

export function render(e: CsEvidence, m: { total: number; by_kind: Record<string, number>; counts: Record<string, number> }): string {
  const L: string[] = [];
  L.push('# Evidence: capture-sensitive and its eval (capture screening, job 1)', '');
  L.push('Written by `tests/acceptance/capture-sensitive-eval-real.test.ts` (opt-in, `NOVA_REAL_CAPTURE_SENSITIVE=1`); plan `docs/plans/ds2-capture-sensitive.md`. Per-case results: `docs/evidence/capture-sensitive-eval.json`. Verdicts the Decision Service follows: `src/core/decision-service/verdicts-capture-sensitive.json`, recomputed in CI. All content is synthetic.', '');
  L.push(`- **The template and its rule, fixed before any eval case:** commit \`${e.template_commit}\`.`);
  L.push(`- **The eval, fixed before any run:** commit \`${e.pre_run_commit}\`.`);
  L.push(`- **The set:** ${m.total} cases: ${m.by_kind.grey} grey-area sensitive, ${m.by_kind.structured} structured, ${m.by_kind.app} sensitive-app, ${m.by_kind.benign} harmless. SHA-256 \`${e.cases_sha256}\`.`);
  L.push(`- **Bounds (a privacy screen):** detection ≥ ${pct(BOUNDS_CS.detection_min)} on grey-area cases; false holds ≤ ${pct(BOUNDS_CS.false_hold_max)} on harmless ones; ECE ≤ ${BOUNDS_CS.ece_max.toFixed(2)} (${BOUNDS_CS.bins} bins). The deterministic layer must redact or exclude every structured and sensitive-app case, and no secret value may reach a model.`, '');
  L.push('## Verdicts', '', '| Size | Verdict | Trusted? | Detection | False holds | ECE | Deterministic | Secret leaks | Digest | Run |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const [size, s] of Object.entries(e.sizes)) {
    const x = s.metrics;
    L.push(`| ${size} | ${s.status === 'not-run' ? `not run: ${s.why}` : `${s.status} (${s.why})`} | ${s.status === 'pass' ? 'yes' : 'no: evidence only'} | ${x ? r(x.detection) : '—'} | ${x ? r(x.false_hold) : '—'} | ${x ? f3(x.ece) : '—'} | ${x ? r(x.deterministic) : '—'} | ${x ? x.leaks.length : '—'} | ${s.digest ?? '—'} | ${s.run_at ?? '—'} |`);
  }
  L.push('', '## The set by category', '', '| Kind: category | Cases |', '| --- | ---: |');
  for (const [c, n] of Object.entries(m.counts)) L.push(`| ${c} | ${n} |`);
  for (const [size, s] of Object.entries(e.sizes)) {
    if (!s.metrics) continue;
    const x = s.metrics;
    L.push('', `## ${size}`, '');
    L.push(`- Detection (grey area, model’s outcome not index): ${r(x.detection)}, Wilson 95% ${x.detection.wilson95.join('–')}. Missed: ${x.missed.join(', ') || 'none'}.`);
    L.push(`- False holds (harmless, model’s outcome not index): ${r(x.false_hold)}, Wilson 95% ${x.false_hold.wilson95.join('–')}. Held: ${x.false_holds.join(', ') || 'none'}.`);
    L.push(`- The whole pipeline on harmless cases (patterns included, information): ${r(x.pipeline_false_hold)}.`);
    L.push(`- Deterministic layer: ${r(x.deterministic)} of structured and sensitive-app cases redacted or excluded${x.deterministic_missed.length ? ` (missed: ${x.deterministic_missed.join(', ')})` : ''}; secret values reaching a model: ${x.leaks.length}${x.leaks.length ? ` (${x.leaks.join(', ')})` : ''}.`);
    L.push(`- ECE ${f3(x.ece)}; by question: ${Object.entries(x.ece_by_question).map(([q, v]) => `${q} ${f3(v)}`).join(', ')}.`);
    L.push(`- Unanswered: ${x.unanswered.join(', ') || 'none'}.`);
    L.push('', '### Reliability bins', '', '| Bin | Pairs | Mean p | Share true |', '| --- | ---: | ---: | ---: |');
    for (const b of x.bins) L.push(`| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}${b.hi === 1 ? ']' : ')'} | ${b.n} | ${f3(b.mean_p)} | ${f3(b.mean_label)} |`);
    L.push('', '### Per case', '', `| Case | Kind | ${CS_QUESTIONS.join(' | ')} | Model | Pipeline | Found | ms |`, `| --- | --- | ${CS_QUESTIONS.map(() => '---:').join(' | ')} | --- | --- | --- | ---: |`);
    for (const c of s.cases) {
      const cell = (q: string) => (c.scores ? `${f3(c.scores[q])}${c.labels[q] ? ' *' : ''}` : '—');
      L.push(`| ${c.id} | ${c.kind} | ${CS_QUESTIONS.map(cell).join(' | ')} | ${c.asked ? c.model_outcome ?? 'unanswered' : 'not asked'} | ${c.pipeline} | ${c.findings.join(', ') || '—'} | ${c.ms} |`);
    }
    L.push('', '`*` marks a question whose label is true.');
  }
  return `${L.join('\n')}\n`;
}
