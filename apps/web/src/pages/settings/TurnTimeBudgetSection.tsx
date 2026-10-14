import { Timer } from 'lucide-react'
import { Section } from '../../components/ui'
import type { SettingDef } from '../../lib/api'
import { TurnBudgetField, type TurnBudgetApi, type TurnBudgetUnit } from './TurnBudgetField'

/**
 * Settings → Behaviour → Turn time limit (epic verification-2-7, T25): core's
 * `turns.time_budget_s`, the wall-clock seconds one turn may run before it
 * stops between rounds on a stated note. Until this section existed the only
 * way to change it was PUT /api/v1/settings — reachable by API only, which
 * the owner's discoverable-by-navigation rule does not accept.
 *
 * The field reads and writes MINUTES, because that is how a person thinks of
 * a turn's length; core stores whole seconds, so a write is the minutes times
 * 60, rounded to the second, and the line under the field says both.
 *
 * The save, the readback and the refusal are TurnBudgetField's, shared with
 * the turn token limit: core is the only validator (60..86400 s, stated in
 * its own description) and a write shows only what core stored.
 */
export type TurnTimeBudgetApi = TurnBudgetApi

export const TURN_TIME_BUDGET_KEY = 'turns.time_budget_s'

/** The def as core listed it, or null — a core that does not list the key
 * draws no field (its write would be refused by name). */
export function turnTimeBudgetDef(settings: SettingDef[]): SettingDef | null {
  return settings.find(s => s.key === TURN_TIME_BUDGET_KEY) ?? null
}

/** Seconds as minutes, to at most two decimals ("15", "1.5", "1.02"). */
export function minutesOf(seconds: number): string {
  return String(Math.round((seconds / 60) * 100) / 100)
}

/** "15 minutes (900 seconds)" — both units, so nothing is hidden by rounding. */
export function budgetWords(seconds: number): string {
  const minutes = minutesOf(seconds)
  return `${minutes} ${minutes === '1' ? 'minute' : 'minutes'} (${seconds} seconds)`
}

/** Minutes in the field, whole seconds stored: a number is sent as its
 * minutes times 60, rounded to the second; anything else as the text. */
const MINUTES: TurnBudgetUnit = {
  draftOf: minutesOf,
  payloadOf: typed => {
    const asMinutes = Number(typed)
    return typed !== '' && Number.isFinite(asMinutes) ? Math.round(asMinutes * 60) : typed
  },
  words: budgetWords,
}

export function TurnTimeBudgetSection({
  def,
  onChanged,
  api,
}: {
  /** turns.time_budget_s as core listed it. */
  def: SettingDef
  /** Hands the parent the value CORE stored, so the page re-renders from it. */
  onChanged: (key: string, value: unknown) => void
  api?: TurnTimeBudgetApi
}) {
  return (
    <Section
      icon={Timer}
      title="Turn time limit"
      description="How long one turn may run before she stops and answers from what she has."
    >
      <TurnBudgetField
        settingKey={TURN_TIME_BUDGET_KEY}
        def={def}
        onChanged={onChanged}
        unit={MINUTES}
        label="Longest one turn may run (minutes)"
        inputClassName="w-28"
        inputMode="number"
        testIdPrefix="turn-budget"
        what="the time limit"
        api={api}
      />
    </Section>
  )
}
