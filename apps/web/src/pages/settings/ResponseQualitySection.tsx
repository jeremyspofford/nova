import { useState } from 'react'
import { Target } from 'lucide-react'
import { Section, Toggle } from '../../components/ui'
import { putSetting } from '../../lib/api'

/**
 * Settings -> Response quality (S3 walk-fix round 9): the opt-in responsiveness
 * check (agents.responsiveness_check). When on, after Nova answers, a quick
 * model check judges whether the reply addressed your message and — on drift —
 * re-answers once, focused on your question. It is OFF by default and reflects
 * the server-held value passed in as `checked`.
 *
 * The disclaimer is stated plainly, because the trade-off is real: the check
 * costs 1-2 extra model calls per reply (slower, more compute, most noticeable
 * on local models), it helps small-model topic drift, and — unlike the
 * mechanical guards — it is an AI judgment, so a helpful safety net rather than
 * a guarantee.
 *
 * The toggle writes immediately via PUT /api/v1/settings and reverts on
 * failure — nothing is shown as on that the server did not accept.
 */
const DISCLAIMER =
  'After Nova answers, a quick model check judges whether the reply addressed ' +
  'your message; if it drifted (common on smaller local models), Nova re-answers ' +
  'once, focused on your question. Trade-off: 1-2 extra model calls per reply, so ' +
  'replies are slower and use more compute (most noticeable on local models). The ' +
  'check is itself an AI judgment — the same model reviewing its own reply — so it ' +
  'is a helpful safety net, not a guarantee. Off by default.'

export function ResponseQualitySection({
  checked,
  onChanged,
}: {
  checked: boolean
  onChanged: (value: boolean) => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleToggle = async (value: boolean) => {
    setSaving(true)
    setError(null)
    onChanged(value) // optimistic — the switch follows the click immediately
    try {
      await putSetting('agents.responsiveness_check', value)
    } catch (err) {
      onChanged(!value) // the write was refused; put the switch back where it was
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section
      icon={Target}
      title="Response quality"
      description="Optional checks that trade a little extra compute for steadier answers."
    >
      <div className="space-y-2">
        <Toggle
          label="Responsiveness check"
          checked={checked}
          disabled={saving}
          onChange={handleToggle}
        />
        <p className="text-caption text-content-secondary">{DISCLAIMER}</p>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not save that setting: {error}
        </div>
      )}
    </Section>
  )
}
