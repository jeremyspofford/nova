import { Coins } from 'lucide-react'
import { Section } from '../../components/ui'
import type { SettingDef } from '../../lib/api'
import { TurnBudgetField, type TurnBudgetApi, type TurnBudgetUnit } from './TurnBudgetField'

/**
 * Settings → Behaviour → Turn token limit (epic verification-2-7, T26): core's
 * `turns.token_budget`, the prompt and completion tokens one turn's rounds may
 * use, summed, before it stops between rounds on a stated note. Drawn here so
 * it is reachable by navigation, never only through PUT /api/v1/settings.
 *
 * The field reads and writes TOKENS, the unit core stores; a typed "250,000"
 * is 250000 (grouping commas are dropped before it is read as a number).
 * The save, the readback and the refusal are TurnBudgetField's, shared with
 * the turn time limit: core is the only validator (10000..100000000, stated
 * in its own description) and a write shows only what core stored.
 */
export const TURN_TOKEN_BUDGET_KEY = 'turns.token_budget'

/** The def as core listed it, or null — a core that does not list the key
 * draws no field (its write would be refused by name). */
export function turnTokenBudgetDef(settings: SettingDef[]): SettingDef | null {
  return settings.find(s => s.key === TURN_TOKEN_BUDGET_KEY) ?? null
}

/** "1,000,000 tokens". */
export function tokenWords(tokens: number): string {
  return `${tokens.toLocaleString('en-US')} ${tokens === 1 ? 'token' : 'tokens'}`
}

/** Tokens in the field and stored: a typed number, commas dropped, is sent
 * as it reads; anything else as the text, so core refuses it in its words. */
const TOKENS: TurnBudgetUnit = {
  draftOf: tokens => String(tokens),
  payloadOf: typed => {
    const plain = typed.replace(/,/g, '')
    const asTokens = Number(plain)
    return plain !== '' && Number.isFinite(asTokens) ? asTokens : typed
  },
  words: tokenWords,
}

export function TurnTokenBudgetSection({
  def,
  onChanged,
  api,
}: {
  /** turns.token_budget as core listed it. */
  def: SettingDef
  /** Hands the parent the value CORE stored, so the page re-renders from it. */
  onChanged: (key: string, value: unknown) => void
  api?: TurnBudgetApi
}) {
  return (
    <Section
      icon={Coins}
      title="Turn token limit"
      description="How many tokens one turn may use before she stops and answers from what she has."
    >
      <TurnBudgetField
        settingKey={TURN_TOKEN_BUDGET_KEY}
        def={def}
        onChanged={onChanged}
        unit={TOKENS}
        label="Most tokens one turn may use"
        inputClassName="w-40"
        inputMode="numeric"
        testIdPrefix="turn-token-budget"
        what="the token limit"
        api={api}
      />
    </Section>
  )
}
