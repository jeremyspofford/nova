// docs/evidence/interstitial-eval.md from the evidence file. Everything comes from the run; case ids,
// scores and outcomes only.
import { BOUNDS_IR, type IrMetrics } from '../../../src/core/decision-service/eval-interstitial.ts';
import { OC_QUESTIONS, VT_QUESTIONS } from '../../../src/core/decision-service/templates/interstitial.ts';
import type { IrRun } from './harness.ts';

export interface IrTemplateResult { status: 'pass' | 'fail'; why: string; metrics: IrMetrics }
export interface IrSize { status: 'ran' | 'not-run'; why: string; digest: string | null; ollama: string | null; run_at: string | null; templates: Record<string, IrTemplateResult>; cases: IrRun[] }
export interface IrEvidence { templates: string[]; version: number; template_commit: string; pre_run_commit: string; cases_sha256: string; wording: Record<string, string>; sizes: Record<string, IrSize> }

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
const f3 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(3));
const r = (x: { k: number; n: number } | null) => (x ? `${pct(x.n ? x.k / x.n : 0)} (${x.k}/${x.n})` : '—');
const Q: Record<string, readonly string[]> = { 'interstitial.verify-transfer': VT_QUESTIONS, 'interstitial.outbound-check': OC_QUESTIONS };

export function render(e: IrEvidence, m: { total: number; expected: Record<string, number>; counts: Record<string, number> }): string {
  const L: string[] = [];
  L.push('# Evidence: the Interstitial Research templates and their eval', '');
  L.push('Written by `tests/acceptance/interstitial-eval-real.test.ts` (opt-in, `NOVA_REAL_INTERSTITIAL=1`); bounds in `src/core/decision-service/eval-interstitial.ts`. Per-case results: `docs/evidence/interstitial-eval.json`. Verdicts the Decision Service follows: `src/core/decision-service/verdicts-interstitial.json`, recomputed in CI. All content is synthetic. Local seat only: no cloud seat was asked, and the cloud seat stays not yet proven.', '');
  L.push(`- **The templates and their rules, fixed before any eval case:** commit \`${e.template_commit}\`.`);
  L.push(`- **The eval and its bounds, fixed before any run:** commit \`${e.pre_run_commit}\`.`);
  L.push(`- **The set:** ${m.total} cases; expected outcomes ${Object.entries(m.expected).map(([o, n]) => `${o} ${n}`).join(', ')}. SHA-256 \`${e.cases_sha256}\`.`);
  L.push(`- **Bounds:** verify-transfer false uses ≤ ${pct(BOUNDS_IR.vt_false_use_max)}, use recall ≥ ${pct(BOUNDS_IR.vt_use_recall_min)}; outbound-check false sends ≤ ${pct(BOUNDS_IR.oc_false_send_max)}, send recall ≥ ${pct(BOUNDS_IR.oc_send_recall_min)}; ECE ≤ ${BOUNDS_IR.ece_max.toFixed(2)} per template (${BOUNDS_IR.bins} bins).`);
  L.push(`- **Wording measured:** ${Object.entries(e.wording).map(([t, w]) => `${t} \`${w.slice(0, 16)}…\``).join('; ')}.`, '');
  L.push('## Verdicts', '', '| Seat model | Template | Verdict | Trusted? | Unsafe (false use / send) | Recall | ECE | Accuracy | Digest | Run |', '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const [size, s] of Object.entries(e.sizes)) {
    if (s.status === 'not-run') { L.push(`| ${size} | all | not run: ${s.why} | no | — | — | — | — | — | — |`); continue; }
    for (const [t, v] of Object.entries(s.templates)) {
      const x = v.metrics;
      L.push(`| ${size} | ${t} | ${v.status} (${v.why}) | ${v.status === 'pass' ? 'yes' : 'no: evidence only'} | ${r(x.unsafe)} | ${r(x.recall)} | ${f3(x.ece)} | ${r(x.accuracy)} | ${s.digest ?? '—'} | ${s.run_at ?? '—'} |`);
    }
  }
  L.push('', '## The set by category', '', '| Category | Cases |', '| --- | ---: |');
  for (const [c, n] of Object.entries(m.counts)) L.push(`| ${c} | ${n} |`);
  for (const [size, s] of Object.entries(e.sizes)) {
    if (s.status === 'not-run') continue;
    for (const [t, v] of Object.entries(s.templates)) {
      const x = v.metrics;
      const q = Q[t]!;
      L.push('', `## ${size}: ${t}`, '');
      L.push(`- ${t.endsWith('verify-transfer') ? 'False uses' : 'False sends'}: ${r(x.unsafe)}, Wilson 95% ${x.unsafe.wilson95.join('–')}. Cases: ${x.unsafe_cases.join(', ') || 'none'}.`);
      L.push(`- ${t.endsWith('verify-transfer') ? 'Use recall' : 'Send recall'}: ${r(x.recall)}, Wilson 95% ${x.recall.wilson95.join('–')}. Missed: ${x.missed.join(', ') || 'none'}.`);
      if (x.label_accuracy) L.push(`- Label (established vs hypothesis) on cases used: ${r(x.label_accuracy)}. Discard recall: ${r(x.discard_recall)}. Quarantined: ${x.quarantined.join(', ') || 'none'}.`);
      L.push(`- ECE ${f3(x.ece)}; by question: ${Object.entries(x.ece_by_question).map(([k, w]) => `${k} ${f3(w)}`).join(', ')}. Unanswered: ${x.unanswered.join(', ') || 'none'}.`);
      L.push('', '| Case | Category | ' + q.join(' | ') + ' | Expected | Outcome | ms |', `| --- | --- | ${q.map(() => '---:').join(' | ')} | --- | --- | ---: |`);
      for (const c of s.cases.filter((y) => y.template === t)) {
        const cell = (k: string) => (c.scores ? `${f3(c.scores[k])}${c.labels[k] ? ' *' : ''}` : '—');
        L.push(`| ${c.id} | ${c.category} | ${q.map(cell).join(' | ')} | ${c.expected} | ${c.answered ? c.outcome : `${c.outcome} (unanswered: ${c.error})`} | ${c.ms} |`);
      }
    }
  }
  L.push('', '`*` marks a question whose label is true.');
  return `${L.join('\n')}\n`;
}
