// Runs capture-sensitive's eval (plan docs/plans/ds2-capture-sensitive.md) exactly as the service
// decides: the template's own precheck first (a final one means no model call), then the Tev1 seat
// asked with the template on the text the precheck left (secrets redacted), the worst probability
// per question across pieces, the template's truth table, and the stricter of the precheck's and
// the model's outcomes. It also checks that no case's secret value is in anything sent to the
// model. No verdict switch: this measures the template on Tev1.
import { buildState } from '../../../src/core/decision-service/state.ts';
import { bands } from '../../../src/core/decision-service/policy.ts';
import { CAPTURE_SENSITIVE_V1, CS_QUESTIONS, capturePolicy, capturePrecheck } from '../../../src/core/decision-service/templates/capture-sensitive.ts';
import type { CsCaseResult, CsOutcome } from '../../../src/core/decision-service/eval-capture.ts';
import type { Tev1Seat } from '../../../src/core/decision-service/seats/tev1.ts';
import type { Answer } from '../../../src/core/decision-service/types.ts';
import type { Case } from './cases.ts';

export interface CsRun extends CsCaseResult { category: string; findings: string[]; requests: number; ms: number; error: string | null }

const ORDER: CsOutcome[] = ['index', 'redact', 'hold', 'exclude'];
const stricter = (a: CsOutcome, b: CsOutcome): CsOutcome => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

// `sent` collects what each request carried, for the leak check (the stand-in or a recorder).
export async function runCS(seat: Tev1Seat, cases: Case[], sent: () => string = () => ''): Promise<CsRun[]> {
  const out: CsRun[] = [];
  for (const c of cases) {
    const started = performance.now();
    const before = sent().length;
    const pre = capturePrecheck(c.input);
    let scores: Record<string, number> | null = null;
    let model: CsOutcome | null = null;
    let requests = 0;
    let error: string | null = null;
    let leaked = false;
    if (!pre?.final) {
      const fields = (pre?.fields ?? c.input) as Record<string, unknown>;
      // What the model is shown, checked for every secret value before anything is sent.
      const shown = JSON.stringify(buildState(CAPTURE_SENSITIVE_V1, fields).state);
      if (pre && c.secrets.some((s) => shown.includes(s))) leaked = true;
      try {
        const a = await seat.ask(CAPTURE_SENSITIVE_V1, buildState(CAPTURE_SENSITIVE_V1, fields));
        requests = a.requests;
        scores = Object.fromEntries(CS_QUESTIONS.map((q) => { const x = a.answers[q]; return [q, x?.type === 'noul' ? x.noul : 0.5]; }));
        const answers: Record<string, Answer> = Object.fromEntries(CS_QUESTIONS.map((q) => [q, { type: 'noul' as const, noul: scores![q]! }]));
        model = capturePolicy(bands(CAPTURE_SENSITIVE_V1, answers));
      } catch (e) { error = (e as Error).message; }
      const carried = sent().slice(before);
      if (c.kind === 'structured' && c.secrets.some((s) => carried.includes(s))) leaked = true;
    }
    // Unanswered: the template's default (index) after the precheck.
    const pipeline = stricter((pre?.outcome ?? 'index') as CsOutcome, model ?? 'index');
    out.push({
      id: c.id, kind: c.kind, category: c.category, labels: c.labels, scores, model_outcome: model, pipeline,
      asked: !pre?.final, leaked, findings: pre?.findings.map((f) => f.kind) ?? [], requests, ms: Math.round(performance.now() - started), error,
    });
  }
  return out;
}
