import { AlertCircle, Check, RotateCcw, Save } from 'lucide-react'
import { Button } from '../../components/ui'

export type SaveMessage = { kind: 'ok' | 'err'; text: string }

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
