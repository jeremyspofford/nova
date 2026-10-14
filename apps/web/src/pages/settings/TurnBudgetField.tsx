import { useState } from 'react'
import { Input, Banner } from '../../components/ui'
import { putSetting as apiPutSetting, type SettingDef } from '../../lib/api'
import { InlineSave, storedFrom, type SaveMessage } from './shared'

/**
 * The one field a per-turn budget setting is edited with (epic
 * verification-2-7): Settings → Behaviour → Turn time limit (T25,
 * `turns.time_budget_s`) and Turn token limit (T26, `turns.token_budget`).
 * Each section supplies only its key, its unit and its words; the save, the
 * readback and the refusal are here once.
 *
 * The ProactiveSection rules hold:
 *
 * 1. Core is the only validator. The range lives in settings_store's
 *    `_int_range` and is stated in core's own description, shown verbatim
 *    below the field; nothing here keeps a second copy of the bounds. A value
 *    outside them is refused by core and its sentence is shown.
 * 2. A write is shown as done only when the answer says what was STORED, and
 *    the field and the "Now:" line re-render from that value, never from what
 *    was typed.
 */
export interface TurnBudgetApi {
  putSetting: typeof apiPutSetting
}

const DEFAULT_API: TurnBudgetApi = { putSetting: apiPutSetting }

/** How one budget reads and writes its stored whole number. */
export interface TurnBudgetUnit {
  /** The stored value as the field shows it. */
  draftOf: (stored: number) => string
  /** What a typed draft is sent as: the stored unit when it reads as a
   * number, else the text itself, so core refuses it in its own words. */
  payloadOf: (typed: string) => number | string
  /** The stored value in words, for the "Now:" and "Saved" lines. */
  words: (stored: number) => string
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function TurnBudgetField({
  settingKey,
  def,
  onChanged,
  unit,
  label,
  inputClassName,
  inputMode,
  testIdPrefix,
  what,
  api = DEFAULT_API,
}: {
  settingKey: string
  /** The setting as core listed it. */
  def: SettingDef
  /** Hands the parent the value CORE stored, so the page re-renders from it. */
  onChanged: (key: string, value: unknown) => void
  unit: TurnBudgetUnit
  label: string
  inputClassName: string
  /** A number input for a plain number; text when the field takes grouping
   * commas ("250,000"), which a number input would empty. */
  inputMode: 'number' | 'numeric'
  testIdPrefix: string
  /** The limit's name in the refusal ("the time limit"). */
  what: string
  api?: TurnBudgetApi
}) {
  // Where the stored value is not the type the def declares, the def's OWN
  // default is shown, never a number made up in the browser.
  const stored = typeof def.value === 'number' ? def.value : Number(def.default)
  // Seeded once: SettingsPage mounts sections after its one settings read.
  const [draft, setDraft] = useState(unit.draftOf(stored))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<SaveMessage | null>(null)

  const clear = () => {
    setError(null)
    setMessage(null)
  }

  const dirty = draft !== unit.draftOf(stored)
  const save = async () => {
    setSaving(true)
    clear()
    try {
      const written = await api.putSetting(settingKey, unit.payloadOf(draft.trim()))
      const { value } = storedFrom(written, settingKey, 'number')
      onChanged(settingKey, value)
      setDraft(unit.draftOf(value as number))
      setMessage({ kind: 'ok', text: `Saved — stored as ${unit.words(value as number)}` })
    } catch (err) {
      // Refused: the field keeps what was typed, the stored budget stands.
      setError(reasonOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Input
        label={label}
        className={inputClassName}
        type={inputMode === 'number' ? 'number' : 'text'}
        inputMode={inputMode === 'numeric' ? 'numeric' : undefined}
        value={draft}
        disabled={saving}
        error={error ? 'Not saved — the stored limit stands.' : undefined}
        onChange={e => {
          setDraft(e.target.value)
          clear()
        }}
      />
      <p data-testid={`${testIdPrefix}-now`} className="text-caption text-content-secondary">
        Now: {unit.words(stored)}.
      </p>
      <p data-testid={`${testIdPrefix}-description`} className="text-caption text-content-secondary">
        {def.description}
      </p>
      {error && (
        <Banner role="alert" data-testid={`${testIdPrefix}-error`}>
          Could not save {what}: {error}
        </Banner>
      )}
      <InlineSave
        dirty={dirty}
        saving={saving}
        onSave={save}
        onReset={() => {
          setDraft(unit.draftOf(stored))
          clear()
        }}
        message={message}
      />
    </div>
  )
}
