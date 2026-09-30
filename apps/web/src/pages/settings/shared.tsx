import { AlertCircle, Check, RotateCcw, Save } from 'lucide-react'
import { Button } from '../../components/ui'

export type SaveMessage = { kind: 'ok' | 'err'; text: string }

/**
 * What core says it stored for `key` (PUT /api/v1/settings answers with it)
 * and its note — or a refusal that says why the write cannot be shown as
 * done. There is deliberately no fallback to the value that was sent: a write
 * that cannot state what it stored has not been verified, and rendering the
 * typed value would report a success nobody checked. `type`, where a section
 * gives it, is the type the setting holds; a stored value of any other type
 * is refused the same way. Shared by the sections that read a write back
 * (Proactive, and the decision switches in Routing), so their refusals say the
 * same thing.
 */
export function storedFrom(
  written: unknown,
  key: string,
  type?: 'boolean' | 'string' | 'number',
): { value: unknown; note?: string } {
  if (written === null || typeof written !== 'object' || !('value' in written)) {
    throw new Error(
      `the write of ${key} returned no stored value, so what is stored is unknown — reload the page`,
    )
  }
  const answer = written as { key?: unknown; value: unknown; note?: string }
  if (answer.key !== key) {
    throw new Error(`the write of ${key} answered about ${String(answer.key)} instead`)
  }
  if (type !== undefined && typeof answer.value !== type) {
    throw new Error(
      `the write of ${key} returned ${JSON.stringify(answer.value)}, which is not a ${type}, so what is stored is unknown — reload the page`,
    )
  }
  return { value: answer.value, note: answer.note }
}

/**
 * The draft/dirty inline-save affordance from the v0.5.0 settings shell:
 * changes are live in the UI immediately, and a Reset/Save pair appears only
 * once the value differs from what the server holds. Nothing is written
 * behind the operator's back, and "saved" is only shown after the write
 * returned.
 */
export function InlineSave({
  dirty,
  saving,
  saveLabel = 'Save',
  onSave,
  onReset,
  message,
}: {
  dirty: boolean
  saving: boolean
  saveLabel?: string
  onSave: () => void
  onReset: () => void
  message?: SaveMessage | null
}) {
  if (!dirty && !message) return null
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {dirty && (
        <>
          <Button variant="ghost" size="sm" onClick={onReset} icon={<RotateCcw size={10} />}>
            Reset
          </Button>
          <Button size="sm" onClick={onSave} loading={saving} icon={<Save size={10} />}>
            {saveLabel}
          </Button>
        </>
      )}
      {message && (
        <span
          className={`flex items-center gap-1 text-caption ${
            message.kind === 'ok' ? 'text-success' : 'text-danger'
          }`}
        >
          {message.kind === 'ok' ? <Check size={12} /> : <AlertCircle size={12} />}
          {message.text}
        </span>
      )}
    </div>
  )
}
