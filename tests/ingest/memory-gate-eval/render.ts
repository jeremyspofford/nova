// docs/evidence/memory-gate-eval.md from the evidence file. Everything comes from the run; case ids,
// scores and outcomes only.
import { BOUNDS_MG, type MgMetrics } from '../../../src/core/decision-service/eval-memory.ts';
import { MG_QUESTIONS } from '../../../src/core/decision-service/templates/memory-gate.ts';
import type { MgRun } from './harness.ts';

export interface MgSize { status: 'pass' | 'fail' | 'not-run'; why: string; digest: string | null; ollama: string | null; run_at: string | null; metrics: MgMetrics | null; cases: MgRun[] }
export interface MgEvidence { template: string; version: number; template_commit: string; pre_run_commit: string; cases_sha256: string; sizes: Record<string, MgSize> }

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
const f3 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(3));
const r = (x: { k: number; n: number }) => `${pct(x.n ? x.k / x.n : 0)} (${x.k}/${x.n})`;

export function render(e: MgEvidence, m: { total: number; expected: Record<string, number>; counts: Record<string, number> }): string {
  const L: string[] = [];
  L.push('# Evidence: memory-gate and its eval', '');
  L.push('Written by `tests/acceptance/memory-gate-eval-real.test.ts` (opt-in, `NOVA_REAL_MEMORY_GATE=1`); plan `docs/plans/ds2-memory-gate.md`. Per-case results: `docs/evidence/memory-gate-eval.json`. Verdicts the Decision Service follows: `src/core/decision-service/verdicts-memory-gate.json`, recomputed in CI. All conversations are synthetic.', '');
  L.push(`- **The template, its rule and the bounds, fixed before any eval case:** commit \`${e.template_commit}\`.`);
  L.push(`- **The eval, fixed before any run:** commit \`${e.pre_run_commit}\`.`);
  L.push(`- **The set:** ${m.total} cases; expected outcomes ${Object.entries(m.expected).map(([o, n]) => `${o} ${n}`).join(', ')}. SHA-256 \`${e.cases_sha256}\`.`);
  L.push(`- **Bounds:** false saves ≤ ${pct(BOUNDS_MG.false_save_max)}; save recall ≥ ${pct(BOUNDS_MG.save_recall_min)}; ECE ≤ ${BOUNDS_MG.ece_max.toFixed(2)} (${BOUNDS_MG.bins} bins). A wrongly saved memory is worse than a missed one.`, '');
  L.push('## Verdicts', '', '| Size | Verdict | Trusted? | False saves | Save recall | ECE | Flag recall | Merge recall | Accuracy | Digest | Run |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const [size, s] of Object.entries(e.sizes)) {
    const x = s.metrics;
    L.push(`| ${size} | ${s.status === 'not-run' ? `not run: ${s.why}` : `${s.status} (${s.why})`} | ${s.status === 'pass' ? 'yes' : 'no: evidence only'} | ${x ? r(x.false_save) : '—'} | ${x ? r(x.save_recall) : '—'} | ${x ? f3(x.ece) : '—'} | ${x ? r(x.flag_recall) : '—'} | ${x ? r(x.merge_recall) : '—'} | ${x ? r(x.accuracy) : '—'} | ${s.digest ?? '—'} | ${s.run_at ?? '—'} |`);
  }
  L.push('', '## The set by category', '', '| Category | Cases |', '| --- | ---: |');
  for (const [c, n] of Object.entries(m.counts)) L.push(`| ${c} | ${n} |`);
  for (const [size, s] of Object.entries(e.sizes)) {
    if (!s.metrics) continue;
    const x = s.metrics;
    L.push('', `## ${size}`, '');
    L.push(`- False saves: ${r(x.false_save)}, Wilson 95% ${x.false_save.wilson95.join('–')}. Saved wrongly: ${x.false_saves.join(', ') || 'none'}.`);
    L.push(`- Save recall: ${r(x.save_recall)}, Wilson 95% ${x.save_recall.wilson95.join('–')}. Missed: ${x.missed_saves.join(', ') || 'none'}.`);
    L.push(`- ECE ${f3(x.ece)}; by question: ${Object.entries(x.ece_by_question).map(([q, v]) => `${q} ${f3(v)}`).join(', ')}.`);
    L.push(`- Deterministic (exact duplicates, no model call): ${r(x.deterministic)}. Unanswered: ${x.unanswered.join(', ') || 'none'}.`);
    L.push('', '### Reliability bins', '', '| Bin | Pairs | Mean p | Share true |', '| --- | ---: | ---: | ---: |');
    for (const b of x.bins) L.push(`| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}${b.hi === 1 ? ']' : ')'} | ${b.n} | ${f3(b.mean_p)} | ${f3(b.mean_label)} |`);
    L.push('', '### Per case', '', `| Case | Category | ${MG_QUESTIONS.join(' | ')} | Expected | Outcome | ms |`, `| --- | --- | ${MG_QUESTIONS.map(() => '---:').join(' | ')} | --- | --- | ---: |`);
    for (const c of s.cases) {
      const cell = (q: string) => (c.scores ? `${f3(c.scores[q])}${c.labels[q] ? ' *' : ''}` : '—');
      L.push(`| ${c.id} | ${c.category} | ${MG_QUESTIONS.map(cell).join(' | ')} | ${c.expected} | ${c.asked ? c.outcome ?? 'unanswered' : `${c.outcome} (no model call)`} | ${c.ms} |`);
    }
    L.push('', '`*` marks a question whose label is true.');
  }
  return `${L.join('\n')}\n`;
}
