// memory-gate's eval: bounds and scoring (plan docs/plans/ds2-memory-gate.md), fixed before any run
// and not changed after seeing results. A wrongly saved memory is worse than a missed one: it goes
// into every later prompt, and a missed one can be said again.
//
// - Each case's EXPECTED outcome is the template's own rule applied to its labels (true → "yes",
//   false → "no"), so labels and expectations can't disagree.
// - False saves ≤ 5%: of cases whose expected outcome isn't "save", the share the gate saves.
// - Save recall ≥ 75%: of cases whose expected outcome is "save", the share the gate saves.
// - An unanswered case counts against the model both ways: the consumer then falls back to
//   today's behaviour (save), so it is a false save where saving is wrong, and a missed save where
//   saving is right (it wasn't the gate that saved it).
// - ECE ≤ 0.10 over every (case, question) pair of the cases the model was asked, with Part 1's
//   method (10 bins; an unanswered case at p = 0.5).
// - Exact duplicates merge with no model call: a code property, CI-tested, reported beside it.
import { BOUNDS, reliability, wilson, type Bin, type Rate } from './eval.ts';

export const BOUNDS_MG = Object.freeze({ false_save_max: 0.05, save_recall_min: 0.75, ece_max: BOUNDS.ece_max, bins: BOUNDS.bins });
export type BoundsMG = { readonly [K in keyof typeof BOUNDS_MG]: number };

export type MgOutcome = 'save' | 'merge' | 'flag' | 'skip';
export interface MgCaseResult {
  id: string;
  labels: Record<string, boolean>;
  expected: MgOutcome;
  // The model's probabilities; null when it wasn't asked (a final precheck) or didn't answer.
  scores: Record<string, number> | null;
  asked: boolean;
  // What the gate decided: the precheck's, or the rule's on the model's answers; null if unanswered.
  outcome: MgOutcome | null;
}

export interface MgMetrics {
  cases: number; asked: number;
  unanswered: string[];
  false_save: Rate; save_recall: Rate;
  false_saves: string[]; missed_saves: string[];
  // Information.
  flag_recall: Rate; merge_recall: Rate; accuracy: Rate;
  deterministic: Rate;
  ece: number; bins: Bin[]; ece_by_question: Record<string, number>;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const rate = (k: number, n: number): Rate => ({ k, n, rate: n ? round(k / n) : 0, wilson95: wilson(k, n) });
const p = (c: MgCaseResult, q: string) => (c.scores ? Number(c.scores[q] ?? 0.5) : 0.5);

export function scoreMG(results: MgCaseResult[], questions: readonly string[]): MgMetrics {
  const unanswered = (c: MgCaseResult) => c.asked && c.outcome === null;
  const saved = (c: MgCaseResult) => unanswered(c) || c.outcome === 'save';
  const notSave = results.filter((c) => c.expected !== 'save');
  const save = results.filter((c) => c.expected === 'save');
  const asked = results.filter((c) => c.asked);
  const all = reliability(asked.flatMap((c) => questions.map((q) => ({ p: p(c, q), y: c.labels[q] === true }))), BOUNDS_MG.bins);
  const by = (o: MgOutcome) => results.filter((c) => c.expected === o);
  const det = results.filter((c) => !c.asked);
  return {
    cases: results.length, asked: asked.length,
    unanswered: results.filter(unanswered).map((c) => c.id),
    false_save: rate(notSave.filter(saved).length, notSave.length),
    save_recall: rate(save.filter((c) => !unanswered(c) && c.outcome === 'save').length, save.length),
    false_saves: notSave.filter(saved).map((c) => c.id),
    missed_saves: save.filter((c) => unanswered(c) || c.outcome !== 'save').map((c) => c.id),
    flag_recall: rate(by('flag').filter((c) => c.outcome === 'flag').length, by('flag').length),
    merge_recall: rate(by('merge').filter((c) => c.outcome === 'merge').length, by('merge').length),
    accuracy: rate(results.filter((c) => c.outcome === c.expected).length, results.length),
    deterministic: rate(det.filter((c) => c.outcome === c.expected).length, det.length),
    ece: all.ece, bins: all.bins,
    ece_by_question: Object.fromEntries(questions.map((q) => [q, reliability(asked.map((c) => ({ p: p(c, q), y: c.labels[q] === true })), BOUNDS_MG.bins).ece])),
  };
}

export function verdictMG(m: MgMetrics, b: BoundsMG = BOUNDS_MG): { pass: boolean; failed: string[] } {
  const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
  const failed: string[] = [];
  if (m.false_save.rate > b.false_save_max) failed.push(`false saves ${pct(m.false_save.rate)} are above ${pct(b.false_save_max)}`);
  if (m.save_recall.rate < b.save_recall_min) failed.push(`save recall ${pct(m.save_recall.rate)} is below ${pct(b.save_recall_min)}`);
  if (m.ece > b.ece_max) failed.push(`ECE ${m.ece.toFixed(3)} is above ${b.ece_max.toFixed(2)}`);
  return { pass: failed.length === 0, failed };
}
