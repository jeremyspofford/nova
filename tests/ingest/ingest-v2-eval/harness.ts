// Runs ingest-screen v2's eval (DS2; plan docs/plans/ds2-ingest-v2.md §2) through the gate's own
// pieces and the Decision Service's: check() (the deterministic layer: hidden text, characters,
// decoding, flags), chunks() and fence() exactly as the gate uses them, then the Tev1 seat asked
// with template v2 for every chunk, the worst probability per question across chunks, v2's truth
// table, and the gate's combination of flags and outcome (eval-v2.ts `combined`). The gate itself
// still thresholds raw scores until Track 1 wires the service's outcome in (NOTES), so this is the
// gate as it will decide with v2, built from its own exported functions. No verdict switch: this
// measures v2 on Tev1, not trust.
import { check } from '../../../src/core/ingest/checks.ts';
import { chunks, fence } from '../../../src/core/ingest/screen.ts';
import { buildState } from '../../../src/core/decision-service/state.ts';
import { bands } from '../../../src/core/decision-service/policy.ts';
import { combined, type Outcome, type V2CaseResult } from '../../../src/core/decision-service/eval-v2.ts';
import { INGEST_SCREEN_V2, V2_QUESTIONS, v2Outcome } from '../../../src/core/decision-service/templates/ingest-screen-v2.ts';
import type { Tev1Seat } from '../../../src/core/decision-service/seats/tev1.ts';
import type { Answer } from '../../../src/core/decision-service/types.ts';
import type { Case } from './cases.ts';

export interface V2Run extends V2CaseResult {
  category: string;
  flags: string[];
  partial: boolean;
  chunks: number;
  requests: number;
  ms: number;
  error: string | null;
}

// The text the gate judges (screen.ts `judged`, which isn't exported): what a reader sees, then
// what the page hid from them.
export function judged(c: ReturnType<typeof check>): string {
  return c.hidden.length ? `${c.visible}\n\n[Not shown to a reader:]\n${c.hidden.map((h) => h.text).join('\n')}` : c.visible;
}

export async function runV2(seat: Tev1Seat, cases: { id: string; kind: Case['kind']; category: string; labels: Record<string, boolean>; input: Case['input'] }[]): Promise<V2Run[]> {
  const out: V2Run[] = [];
  for (const c of cases) {
    const started = performance.now();
    const checked = check(c.input as Parameters<typeof check>[0]);
    const { parts, partial } = chunks(judged(checked));
    let scores: Record<string, number> | null = Object.fromEntries(V2_QUESTIONS.map((q) => [q, 0]));
    let requests = 0;
    let error: string | null = null;
    for (const part of parts) {
      try {
        const a = await seat.ask(INGEST_SCREEN_V2, buildState(INGEST_SCREEN_V2, { source_kind: c.input.source.kind, origin: c.input.source.origin, content: fence(part) }));
        requests += a.requests;
        for (const q of V2_QUESTIONS) { const x = a.answers[q]; scores![q] = Math.max(scores![q]!, x?.type === 'noul' ? x.noul : 0.5); }
      } catch (e) { error = (e as Error).message; scores = null; break; }
    }
    const answers: Record<string, Answer> | null = scores ? Object.fromEntries(V2_QUESTIONS.map((q) => [q, { type: 'noul' as const, noul: scores![q]! }])) : null;
    const outcome: Outcome = answers ? v2Outcome(bands(INGEST_SCREEN_V2, answers)) : 'quarantine';
    out.push({
      id: c.id, kind: c.kind, category: c.category, labels: c.labels, scores, outcome,
      combined: combined(checked.flags, partial, outcome),
      flags: checked.flags.filter((f) => f.level !== 'note').map((f) => f.kind),
      partial, chunks: parts.length, requests, ms: Math.round(performance.now() - started), error,
    });
  }
  return out;
}
