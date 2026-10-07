import { useState } from 'react'
import { Repeat } from 'lucide-react'
import { Input, Section } from '../../components/ui'
import { putSetting as apiPutSetting, reasonOf, type SettingDef } from '../../lib/api'
import { InlineSave, storedFrom, type SaveMessage } from './shared'

/**
 * Settings → Behaviour → Tool rounds: the tool-round limit
 * (`agents.max_tool_rounds`), the cap a chat turn has reached when it ends
 * with a note that it stopped after so many tool rounds without finishing.
 *
 * ProactiveSection's two rules run through the whole section:
 *
 * 1. Core is the only validator. The browser holds no copy of the bounds:
 *    core reads agents.MIN_ROUNDS..MAX_ROUNDS at write time, so a pair kept
 *    here would refuse what core accepts the day agents.py moves them. The
 *    field has no min or max, nothing is refused, clamped or rounded here,
 *    what was typed is sent, and a refusal is core's sentence, verbatim.
 * 2. A write is shown as done only when the answer states what was STORED
 *    (storedFrom, as a number). The field then shows that, never the typed
 *    value, and an answer that states no stored number is a failure with
 *    storedFrom's reason, not a save.
 *
 * The words under the field are the def's `description`, core's own, so they
 * cannot drift from what core does. The section prints no number of its own
 * (neither the default nor the range): the range is core's refusal and
 * deploy/README.md's, the default is core's def.
 *
 * `api` is the dependency-injection seam the other sections use: production
 * binds the real lib/api call, tests inject a fake.
 */
export interface ToolRoundsApi {
  putSetting: typeof apiPutSetting
}

const DEFAULT_API: ToolRoundsApi = { putSetting: apiPutSetting }

export const TOOL_ROUNDS_KEY = 'agents.max_tool_rounds'

export function ToolRoundsSection({
  def,
  onChanged,
  api = DEFAULT_API,
}: {
  /** The one settings fetch's SettingDef for `agents.max_tool_rounds`. */
  def: SettingDef
  /** Hands the parent the value CORE stored. */
  onChanged: (value: number) => void
  api?: ToolRoundsApi
}) {
  const stored = String(def.value)
  // Seeded once: SettingsPage renders its sections only after the one
  // settings fetch resolved, so `def.value` is already the server's value at
  // mount, and a re-seeding effect would fight the operator's typing on every
  // parent render (ProactiveSection's drafts work the same way).
  const [draft, setDraft] = useState(stored)
  const [saving, setSaving] = useState(false)
  // Core's refusal, or storedFrom's reason the answer named no stored number:
  // the one reason on screen, in the words it came in.
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<SaveMessage | null>(null)

  const clear = () => {
    setError(null)
    setMessage(null)
  }

  const save = async () => {
    // Sent as typed (ProactiveSection.saveMax's rule). A number goes as a
    // number, so core can say "expects int, got float"; anything else goes as
    // the text, so core can say "expects int, got str".
    const typed = draft.trim()
    const asNumber = Number(typed)
    const payload = typed !== '' && Number.isFinite(asNumber) ? asNumber : typed
    setSaving(true)
    clear()
    try {
      const written = await api.putSetting(TOOL_ROUNDS_KEY, payload)
      // storedFrom has checked that the answer is about this key and that what
      // it stored is a number, so the cast states a fact already checked.
      const value = storedFrom(written, TOOL_ROUNDS_KEY, 'number').value as number
      onChanged(value)
      setDraft(String(value))
      setMessage({ kind: 'ok', text: `Saved — stored as ${String(value)}` })
    } catch (err) {
      // Refused, or the answer stated nothing stored: the field keeps what was
      // typed so it can be corrected, and the reason is under it.
      setError(reasonOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section
      icon={Repeat}
      title="Tool rounds"
      description="The safety ceiling on tool rounds in one reply: a backstop against a runaway turn. A turn going in circles is stopped by its own check, before this limit whenever the limit is more than a few rounds."
    >
      <div className="space-y-2">
        <Input
          label="Tool-round limit"
          type="number"
          value={draft}
          disabled={saving}
          error={error ? 'Not saved — the stored limit stands.' : undefined}
          onChange={e => {
            setDraft(e.target.value)
            clear()
          }}
        />
        <p data-testid="tool-rounds-description" className="text-caption text-content-secondary">
          {def.description}
        </p>
        {error && (
          <div
            role="alert"
            data-testid="tool-rounds-error"
            className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
          >
            Could not save the limit: {error}
          </div>
        )}
        <InlineSave
          dirty={draft !== stored}
          saving={saving}
          onSave={save}
          onReset={() => {
            setDraft(stored)
            clear()
          }}
          message={message}
        />
      </div>
    </Section>
  )
}
