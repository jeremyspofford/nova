import { useState } from 'react'
import { Timer } from 'lucide-react'
import { Input, Section, Banner } from '../../components/ui'
import { putSetting as apiPutSetting, type SettingDef } from '../../lib/api'
import { InlineSave, storedFrom, type SaveMessage } from './shared'

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
 * The ProactiveSection rules hold here too:
 *
 * 1. Core is the only validator. The range (60..86400 s) lives in
 *    settings_store's `_int_range` and is stated in core's own description,
 *    shown verbatim below the field; nothing here keeps a second copy of the
 *    bounds. A value outside them is refused by core and its sentence is shown.
 * 2. A write is shown as done only when the answer says what was STORED, and
 *    the field and the "Now:" line re-render from that value, never from what
 *    was typed.
 */
export interface TurnTimeBudgetApi {
  putSetting: typeof apiPutSetting
}

const DEFAULT_API: TurnTimeBudgetApi = { putSetting: apiPutSetting }

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

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function TurnTimeBudgetSection({
  def,
  onChanged,
  api = DEFAULT_API,
}: {
  /** turns.time_budget_s as core listed it. */
  def: SettingDef
  /** Hands the parent the value CORE stored, so the page re-renders from it. */
  onChanged: (key: string, value: unknown) => void
  api?: TurnTimeBudgetApi
}) {
  // Where the stored value is not the type the def declares, the def's OWN
  // default is shown, never a number made up in the browser.
  const seconds = typeof def.value === 'number' ? def.value : Number(def.default)
  // Seeded once: SettingsPage mounts sections after its one settings read.
  const [draft, setDraft] = useState(minutesOf(seconds))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<SaveMessage | null>(null)

  const clear = () => {
    setError(null)
    setMessage(null)
  }

  const dirty = draft !== minutesOf(seconds)
  const save = async () => {
    // Sent as seconds when it is a number, as the text when it is not — core
    // then says "expects int, got str" in its own words.
    const typed = draft.trim()
    const asMinutes = Number(typed)
    const payload = typed !== '' && Number.isFinite(asMinutes) ? Math.round(asMinutes * 60) : typed
    setSaving(true)
    clear()
    try {
      const written = await api.putSetting(TURN_TIME_BUDGET_KEY, payload)
      const { value: stored } = storedFrom(written, TURN_TIME_BUDGET_KEY, 'number')
      onChanged(TURN_TIME_BUDGET_KEY, stored)
      setDraft(minutesOf(stored as number))
      setMessage({ kind: 'ok', text: `Saved — stored as ${budgetWords(stored as number)}` })
    } catch (err) {
      // Refused: the field keeps what was typed, the stored budget stands.
      setError(reasonOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section
      icon={Timer}
      title="Turn time limit"
      description="How long one turn may run before she stops and answers from what she has."
    >
      <div className="space-y-2">
        <Input
          label="Longest one turn may run (minutes)"
          className="w-28"
          type="number"
          value={draft}
          disabled={saving}
          error={error ? 'Not saved — the stored limit stands.' : undefined}
          onChange={e => {
            setDraft(e.target.value)
            clear()
          }}
        />
        <p data-testid="turn-budget-now" className="text-caption text-content-secondary">
          Now: {budgetWords(seconds)}.
        </p>
        <p data-testid="turn-budget-description" className="text-caption text-content-secondary">
          {def.description}
        </p>
        {error && (
          <Banner role="alert" data-testid="turn-budget-error">
            Could not save the time limit: {error}
          </Banner>
        )}
        <InlineSave
          dirty={dirty}
          saving={saving}
          onSave={save}
          onReset={() => {
            setDraft(minutesOf(seconds))
            clear()
          }}
          message={message}
        />
      </div>
    </Section>
  )
}
