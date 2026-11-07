// Runs the Interstitial Research templates' eval as the service decides: the seat asked with the
// template, then the template's own rule on its answers (bands, then the truth table). An unanswered
// case takes the template's default (quarantine / withhold). No verdict switch: this measures the
// templates on a seat.
import { buildState } from '../../../src/core/decision-service/state.ts';
import { bands } from '../../../src/core/decision-service/policy.ts';
import { OC_QUESTIONS, OUTBOUND_CHECK_V1, VERIFY_TRANSFER_V1, VT_QUESTIONS, outboundPolicy, verifyPolicy } from '../../../src/core/decision-service/templates/interstitial.ts';
import type { IrCaseResult } from '../../../src/core/decision-service/eval-interstitial.ts';
import type { Answer, Seat } from '../../../src/core/decision-service/types.ts';
import type { Case } from './cases.ts';

export interface IrRun extends IrCaseResult { category: string; ms: number; error: string | null }

const T = {
  'interstitial.verify-transfer': { t: VERIFY_TRANSFER_V1, q: VT_QUESTIONS, rule: verifyPolicy, fallback: 'quarantine' },
  'interstitial.outbound-check': { t: OUTBOUND_CHECK_V1, q: OC_QUESTIONS, rule: outboundPolicy, fallback: 'withhold' },
} as const;

export async function runIR(seat: Pick<Seat, 'ask'>, cases: Case[]): Promise<IrRun[]> {
  const out: IrRun[] = [];
  for (const c of cases) {
    const { t, q, rule, fallback } = T[c.template];
    const started = performance.now();
    let scores: Record<string, number> | null = null;
    let outcome: string = fallback;
    let error: string | null = null;
    try {
      const a = await seat.ask(t, buildState(t, c.input));
      scores = Object.fromEntries(q.map((x) => { const v = a.answers[x]; return [x, v?.type === 'noul' ? v.noul : 0.5]; }));
      const answers: Record<string, Answer> = Object.fromEntries(q.map((x) => [x, { type: 'noul' as const, noul: scores![x]! }]));
      outcome = rule(bands(t, answers));
    } catch (e) { error = (e as Error).message; }
    out.push({ id: c.id, template: c.template, category: c.category, labels: c.labels, expected: c.expected, scores, outcome, answered: scores !== null, ms: Math.round(performance.now() - started), error });
  }
  return out;
}
