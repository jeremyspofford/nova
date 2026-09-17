import type {
  EvalCaseResult,
  EvalPredicateResult,
  EvalRepeatedCase,
  EvalRepeatedRuns,
  EvalScoreSummary,
} from '../../lib/api'

/**
 * The pure formatting a scored case needs, kept out of the page so the
 * "ungradeable is not a fail, and not in the rate" rule is unit-testable on its
 * own — the same idiom activityFormat/modelsFormat use.
 */

export type CaseVerdict = 'passed' | 'failed' | 'ungradeable'

/**
 * A case's verdict. UNGRADEABLE (the turn errored) is its own state, never
 * folded into "failed": `passed` is null exactly then, and the backend excludes
 * it from the pass rate — so the UI must too.
 */
export function verdictOf(c: EvalCaseResult): CaseVerdict {
  if (c.ungradeable) return 'ungradeable'
  return c.passed ? 'passed' : 'failed'
}

export const VERDICT_LABEL: Record<CaseVerdict, string> = {
  passed: 'Passed',
  failed: 'Failed',
  ungradeable: 'Ungradeable',
}

export const VERDICT_COLOR: Record<CaseVerdict, 'success' | 'danger' | 'neutral'> = {
  passed: 'success',
  failed: 'danger',
  ungradeable: 'neutral',
}

/**
 * "5 / 7 passed" over the GRADEABLE cases only — the denominator is
 * `summary.gradeable`, never `summary.total`, so an ungradeable case never
 * inflates the count it is scored against.
 */
export function scoreLine(summary: EvalScoreSummary): string {
  return `${summary.passed} / ${summary.gradeable} passed`
}

/**
 * The pass rate as a whole-number percent, or null when nothing is gradeable —
 * the caller shows an empty state for null, never a fabricated 0%.
 */
export function passRatePercent(summary: EvalScoreSummary): number | null {
  return summary.pass_rate === null ? null : Math.round(summary.pass_rate * 100)
}

/** One predicate rendered as "tool_called(web_search)" — WHAT the contract
 * checked. Every live predicate takes an arg (corpus v5); a stored result with
 * none (a historical run at suite_version <= 4) shows the name alone. */
export function predicateLabel(p: EvalPredicateResult): string {
  return p.arg ? `${p.predicate}(${p.arg})` : p.predicate
}

/**
 * The headline across repeated runs: what passed EVERY time, with the single
 * best run beside it so the gap is visible rather than averaged away.
 *
 * Reported at the floor on purpose (2026-09-14). One run of this suite scored
 * 22/23 and the run an hour before it scored 21/23 on nearly the same corpus,
 * disagreeing about a case neither version had touched. Quoting the newer
 * number would have been quoting the luckier one.
 */
export function everyRunLine(r: EvalRepeatedRuns): string {
  const runs = `${r.runs_read} run${r.runs_read === 1 ? '' : 's'}`
  if (r.runs_read < 2) return `${r.every_run.passed} passed · one run, so nothing about stability`
  return `${r.every_run.passed} passed in every one of ${runs} · best single run ${r.best.passed}`
}

/** "3/3" — how many of the repeated runs this case passed. */
export function caseRunsLabel(c: EvalRepeatedCase): string {
  return `${c.passed}/${c.of}`
}

/** The cases that did not agree with themselves across runs — the ones whose
 * result is not yet a measurement. */
export function unstableCases(r: EvalRepeatedRuns): EvalRepeatedCase[] {
  return r.cases.filter(c => c.stable === false)
}
