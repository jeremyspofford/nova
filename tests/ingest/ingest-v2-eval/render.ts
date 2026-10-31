// docs/evidence/ingest-v2-eval.md from the evidence file (DS2). Everything in it comes from the run.
import { BOUNDS_V2, type V2Metrics } from '../../../src/core/decision-service/eval-v2.ts';
import { V2_QUESTIONS } from '../../../src/core/decision-service/templates/ingest-screen-v2.ts';
import type { V2Run } from './harness.ts';

export interface HeldOut { detection: { k: number; n: number }; false_positive: { k: number; n: number }; missed: string[]; false_positives: string[] }
export interface SizeResult { status: 'pass' | 'fail' | 'not-run'; why: string; digest: string | null; ollama: string | null; run_at: string | null; metrics: V2Metrics | null; cases: V2Run[]; held_out: HeldOut | null }
export interface EvidenceV2 { template: string; version: number; template_commit: string; pre_run_commit: string; cases_sha256: string; sizes: Record<string, SizeResult> }

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
const f3 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(3));
const r = (x: { k: number; n: number }) => `${pct(x.n ? x.k / x.n : 0)} (${x.k}/${x.n})`;

export function render(e: EvidenceV2, m: { total: number; attacks: number; benign: number; steering: number; counts: Record<string, number> }): string {
  const L: string[] = [];
  L.push('# Evidence: ingest-screen v2 and its fresh eval (DS2)', '');
  L.push('Written by `tests/acceptance/ingest-v2-eval-real.test.ts` (opt-in, `NOVA_REAL_INGEST_V2=1`); plan `docs/plans/ds2-ingest-v2.md`. Per-case results: `docs/evidence/ingest-v2-eval.json`. The verdicts the Decision Service follows: `src/core/decision-service/verdicts.json`, recomputed in CI from the per-case results.', '');
  L.push(`- **v2 and its rule fixed before any case existed:** commit \`${e.template_commit}\`.`);
  L.push(`- **The fresh eval fixed before any run:** commit \`${e.pre_run_commit}\`.`);
  L.push(`- **The fresh set:** ${m.total} cases: ${m.attacks} text-borne attacks, ${m.benign} benign, ${m.steering} steering. SHA-256 \`${e.cases_sha256}\` (\`tests/ingest/ingest-v2-eval/manifest.json\`).`);
  L.push(`- **Bounds:** detection ≥ ${pct(BOUNDS_V2.detection_min)} (a case is caught when v2's outcome isn't pass); false positives ≤ ${pct(BOUNDS_V2.false_positive_max)}; ECE ≤ ${BOUNDS_V2.ece_max.toFixed(2)} over every (case, question) pair, ${BOUNDS_V2.bins} bins; every steering case held by the combined gate (the deterministic layer with v2's outcome).`, '');
  L.push('## Verdicts', '', '| Size | Verdict | Trusted? | Detection | False positives | ECE | Steering held | Digest | Run | Ollama |', '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |');
  for (const [size, s] of Object.entries(e.sizes)) {
    const x = s.metrics;
    L.push(`| ${size} | ${s.status === 'not-run' ? `not run: ${s.why}` : `${s.status} (${s.why})`} | ${s.status === 'pass' ? 'yes' : 'no: evidence only'} | ${x ? r(x.detection) : '—'} | ${x ? r(x.false_positive) : '—'} | ${x ? f3(x.ece) : '—'} | ${x ? r(x.steering_held) : '—'} | ${s.digest ?? '—'} | ${s.run_at ?? '—'} | ${s.ollama ?? '—'} |`);
  }
  L.push('', 'A size that is not trusted answers ingest-screen v2 as a shadow only (its answers are kept in the decision record as evidence); the gate decides with the deterministic layer plus quarantine-on-uncertain, or today’s sorting model on v1 while it is still in use.', '');
  L.push('## The fresh set by category', '', '| Category | Cases |', '| --- | ---: |');
  for (const [c, n] of Object.entries(m.counts)) L.push(`| ${c} | ${n} |`);
  for (const [size, s] of Object.entries(e.sizes)) {
    if (!s.metrics) continue;
    const x = s.metrics;
    L.push('', `## ${size}`, '');
    L.push(`- Detection: ${r(x.detection)}, Wilson 95% ${x.detection.wilson95.join('–')}. Missed: ${x.missed.join(', ') || 'none'}.`);
    L.push(`- False positives: ${r(x.false_positive)}, Wilson 95% ${x.false_positive.wilson95.join('–')}. Flagged: ${x.false_positives.join(', ') || 'none'}.`);
    L.push(`- Blocked (information): ${r(x.detection_block)} of attacks.`);
    L.push(`- ECE ${f3(x.ece)}; by question: ${Object.entries(x.ece_by_question).map(([q, v]) => `${q} ${f3(v)}`).join(', ')}.`);
    L.push(`- Steering: the combined gate held ${r(x.steering_held)}${x.steering_passed.length ? ` (passed: ${x.steering_passed.join(', ')})` : ''}; v2’s outcome alone caught ${r(x.steering_model_caught)} (information).`);
    L.push(`- Unanswered: ${x.unanswered.join(', ') || 'none'}.`);
    const ms = s.cases.map((c) => c.ms).sort((a, b) => a - b);
    L.push(`- Latency per case: median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms; ${s.cases.reduce((a, c) => a + c.requests, 0)} requests in all.`);
    if (s.held_out) L.push(`- **Held out (v1’s 99 cases, reported only):** detection ${r(s.held_out.detection)}, false positives ${r(s.held_out.false_positive)}. Missed: ${s.held_out.missed.join(', ') || 'none'}. Flagged: ${s.held_out.false_positives.join(', ') || 'none'}.`);
    L.push('', '### Reliability bins', '', '| Bin | Pairs | Mean p | Share true |', '| --- | ---: | ---: | ---: |');
    for (const b of x.bins) L.push(`| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}${b.hi === 1 ? ']' : ')'} | ${b.n} | ${f3(b.mean_p)} | ${f3(b.mean_label)} |`);
    L.push('', '### Per case', '', `| Case | Kind | ${V2_QUESTIONS.join(' | ')} | v2 outcome | Combined | Flags | Requests | ms |`, `| --- | --- | ${V2_QUESTIONS.map(() => '---:').join(' | ')} | --- | --- | --- | ---: | ---: |`);
    for (const c of s.cases) {
      const cell = (q: string) => (c.scores ? `${f3(c.scores[q])}${c.labels[q] ? ' *' : ''}` : '—');
      L.push(`| ${c.id} | ${c.kind} | ${V2_QUESTIONS.map(cell).join(' | ')} | ${c.scores ? c.outcome : 'unanswered'} | ${c.combined} | ${c.flags.join(', ') || '—'} | ${c.requests} | ${c.ms} |`);
    }
    L.push('', '`*` marks a question whose label is true.');
  }
  return `${L.join('\n')}\n`;
}
