// Runs memory-gate's eval (plan docs/plans/ds2-memory-gate.md) as the service decides: the
// template's precheck first (an exact duplicate merges with no model call), then the Tev1 seat asked
// with the template, and the template's truth table on its answers. No verdict switch: this
// measures the template on Tev1.
import { buildState } from '../../../src/core/decision-service/state.ts';
import { bands } from '../../../src/core/decision-service/policy.ts';
import { MEMORY_GATE_V1, MG_QUESTIONS, memoryPolicy, memoryPrecheck } from '../../../src/core/decision-service/templates/memory-gate.ts';
import type { MgCaseResult, MgOutcome } from '../../../src/core/decision-service/eval-memory.ts';
import type { Tev1Seat } from '../../../src/core/decision-service/seats/tev1.ts';
import type { Answer } from '../../../src/core/decision-service/types.ts';
import type { Case } from './cases.ts';

export interface MgRun extends MgCaseResult { category: string; ms: number; error: string | null }

export async function runMG(seat: Tev1Seat, cases: Case[]): Promise<MgRun[]> {
  const out: MgRun[] = [];
  for (const c of cases) {
    const started = performance.now();
    const pre = memoryPrecheck(c.input);
    let scores: Record<string, number> | null = null;
    let outcome: MgOutcome | null = null;
    let error: string | null = null;
    if (pre?.final) outcome = pre.outcome as MgOutcome;
    else {
      try {
        const a = await seat.ask(MEMORY_GATE_V1, buildState(MEMORY_GATE_V1, c.input));
        scores = Object.fromEntries(MG_QUESTIONS.map((q) => { const x = a.answers[q]; return [q, x?.type === 'noul' ? x.noul : 0.5]; }));
        const answers: Record<string, Answer> = Object.fromEntries(MG_QUESTIONS.map((q) => [q, { type: 'noul' as const, noul: scores![q]! }]));
        outcome = memoryPolicy(bands(MEMORY_GATE_V1, answers));
      } catch (e) { error = (e as Error).message; }
    }
    out.push({ id: c.id, category: c.category, labels: c.labels, expected: c.expected, scores, asked: !pre?.final, outcome, ms: Math.round(performance.now() - started), error });
  }
  return out;
}
