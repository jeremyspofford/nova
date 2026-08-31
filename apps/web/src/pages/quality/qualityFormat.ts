import type { EvalCaseResult, EvalPredicateResult, EvalScoreSummary } from '../../lib/api'

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
 * checked. Argless predicates (e.g. consent_card_raised) show the name alone. */
export function predicateLabel(p: EvalPredicateResult): string {
  return p.arg ? `${p.predicate}(${p.arg})` : p.predicate
}
