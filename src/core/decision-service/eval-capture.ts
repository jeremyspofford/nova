// capture-sensitive's eval: bounds and scoring (plan docs/plans/ds2-capture-sensitive.md "The
// eval"), fixed before any run and not changed after seeing results. A privacy screen: a missed
// secret or health note costs more than a false hold, so detection is stricter than Part 1's and
// the false-hold bound looser.
//
// - Model bounds (they decide the verdict), on the model's OWN outcome for the text it is shown
//   (after the deterministic redaction): detection ≥ 95% on grey-area sensitive cases (caught when
//   the outcome isn't "index"); false holds ≤ 20% on harmless controls (outcome isn't "index", or
//   unanswered); ECE ≤ 0.10 over every (case, question) pair of the grey-area and harmless cases,
//   with Part 1's method (eval.ts `reliability`, 10 bins; unanswered at p = 0.5).
// - Deterministic bounds (code properties, CI-tested, reported in the run): the pipeline redacts or
//   excludes 100% of structured and sensitive-app cases, and no secret value ever reaches a model.
import { BOUNDS, reliability, wilson, type Bin, type Rate } from './eval.ts';

export const BOUNDS_CS = Object.freeze({ detection_min: 0.95, false_hold_max: 0.2, ece_max: BOUNDS.ece_max, bins: BOUNDS.bins, deterministic_min: 1 });
export type BoundsCS = { readonly [K in keyof typeof BOUNDS_CS]: number };

export type CsKind = 'grey' | 'structured' | 'app' | 'benign';
export type CsOutcome = 'index' | 'redact' | 'hold' | 'exclude';
export interface CsCaseResult {
  id: string;
  kind: CsKind;
  labels: Record<string, boolean>;
  // The model's worst probability per question; null when it wasn't asked (a final precheck) or
  // didn't answer.
  scores: Record<string, number> | null;
  model_outcome: CsOutcome | null;
  pipeline: CsOutcome;
  asked: boolean;
  leaked: boolean;
}

export interface CsMetrics {
  grey: number; benign: number; structured: number; app: number;
  unanswered: string[];
  detection: Rate; false_hold: Rate; deterministic: Rate;
  missed: string[]; false_holds: string[]; deterministic_missed: string[];
  leaks: string[];
  // Information: the whole pipeline on the harmless controls (patterns included).
  pipeline_false_hold: Rate;
  ece: number; bins: Bin[]; ece_by_question: Record<string, number>;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const rate = (k: number, n: number): Rate => ({ k, n, rate: n ? round(k / n) : 0, wilson95: wilson(k, n) });
const p = (c: CsCaseResult, q: string) => (c.scores ? Number(c.scores[q] ?? 0.5) : 0.5);

export function scoreCS(results: CsCaseResult[], questions: readonly string[]): CsMetrics {
  const grey = results.filter((c) => c.kind === 'grey');
  const benign = results.filter((c) => c.kind === 'benign');
  const det = results.filter((c) => c.kind === 'structured' || c.kind === 'app');
  const caught = (c: CsCaseResult) => c.scores !== null && c.model_outcome !== null && c.model_outcome !== 'index';
  const held = (c: CsCaseResult) => c.scores === null || c.model_outcome !== 'index';
  const main = [...grey, ...benign];
  const all = reliability(main.flatMap((c) => questions.map((q) => ({ p: p(c, q), y: c.labels[q] === true }))), BOUNDS_CS.bins);
  return {
    grey: grey.length, benign: benign.length, structured: results.filter((c) => c.kind === 'structured').length, app: results.filter((c) => c.kind === 'app').length,
    unanswered: main.filter((c) => c.scores === null).map((c) => c.id),
    detection: rate(grey.filter(caught).length, grey.length),
    false_hold: rate(benign.filter(held).length, benign.length),
    deterministic: rate(det.filter((c) => c.pipeline !== 'index').length, det.length),
    missed: grey.filter((c) => !caught(c)).map((c) => c.id),
    false_holds: benign.filter(held).map((c) => c.id),
    deterministic_missed: det.filter((c) => c.pipeline === 'index').map((c) => c.id),
    leaks: results.filter((c) => c.leaked).map((c) => c.id),
    pipeline_false_hold: rate(benign.filter((c) => c.pipeline !== 'index').length, benign.length),
    ece: all.ece, bins: all.bins,
    ece_by_question: Object.fromEntries(questions.map((q) => [q, reliability(main.map((c) => ({ p: p(c, q), y: c.labels[q] === true })), BOUNDS_CS.bins).ece])),
  };
}

// The verdict rests on the three model bounds. The deterministic bounds are reported beside it;
// if they ever fail, that is a bug in Nova's own code, said as such.
export function verdictCS(m: CsMetrics, b: BoundsCS = BOUNDS_CS): { pass: boolean; failed: string[]; deterministic_ok: boolean } {
  const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
  const failed: string[] = [];
  if (m.detection.rate < b.detection_min) failed.push(`detection ${pct(m.detection.rate)} is below ${pct(b.detection_min)}`);
  if (m.false_hold.rate > b.false_hold_max) failed.push(`false holds ${pct(m.false_hold.rate)} are above ${pct(b.false_hold_max)}`);
  if (m.ece > b.ece_max) failed.push(`ECE ${m.ece.toFixed(3)} is above ${b.ece_max.toFixed(2)}`);
  return { pass: failed.length === 0, failed, deterministic_ok: m.deterministic.rate >= b.deterministic_min && m.leaks.length === 0 };
}
