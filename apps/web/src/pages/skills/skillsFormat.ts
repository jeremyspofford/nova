import type { SkillInfo, SkillUses } from '../../lib/api'

/** The pill for a skill's status, and for a file that has no row at all.
 *
 * A file with no row is NOT drawn as a problem: agents have named files under
 * `skills/` since S12 and those grants still work. It is drawn as what it is —
 * a file, with no lifecycle around it. */
export function statusPill(status: SkillInfo['status']): {
  label: string
  color: 'neutral' | 'success' | 'warning' | 'danger'
} {
  switch (status) {
    case 'active':
      return { label: 'Active', color: 'success' }
    case 'draft':
      return { label: 'Draft', color: 'neutral' }
    case 'flagged':
      return { label: 'Flagged', color: 'warning' }
    case 'retired':
      return { label: 'Retired', color: 'neutral' }
    default:
      return { label: 'File only', color: 'neutral' }
  }
}

/** The ledger in a sentence, with the unwatched uses kept SEPARATE.
 *
 * Folding a turn nobody watched finish into the clean ones is reading silence
 * as success, which is the thing the `outcome_known` column exists to stop —
 * so the words here never do it either. */
export function usesWords(uses: SkillUses | null): string {
  if (uses === null) return 'No row, so nothing is recorded about it'
  if (uses.total === 0) return 'Never read'
  const parts = [`Read ${uses.total} ${uses.total === 1 ? 'time' : 'times'}`]
  if (uses.watched === 0) {
    parts.push('none of them in a turn that finished, so nothing is known about how they went')
  } else {
    parts.push(
      `${uses.rough} of the ${uses.watched} watched ${uses.watched === 1 ? 'turn' : 'turns'} went badly`,
    )
    if (uses.unwatched > 0) {
      parts.push(`${uses.unwatched} never watched`)
    }
  }
  return parts.join('; ')
}

/** What the two trial columns amount to, said without overclaiming.
 *
 * One run a side and a non-deterministic model: the honest verb is "did",
 * never "is better". */
export function trialWords(withCalls: number | null, withoutCalls: number | null): string {
  if (withCalls === null || withoutCalls === null) return 'One of the runs did not finish'
  if (withCalls === withoutCalls) return `Both runs made ${withCalls} calls`
  const fewer = withCalls < withoutCalls
  return `With the procedure: ${withCalls} calls; without it: ${withoutCalls}. ${
    fewer ? 'Fewer' : 'More'
  } with it, in this one run each.`
}
