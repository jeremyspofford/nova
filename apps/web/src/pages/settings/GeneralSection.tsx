import { useMemo, useState } from 'react'
import { Globe } from 'lucide-react'
import { Section, Select } from '../../components/ui'
import { putSetting } from '../../lib/api'
import {
  TIMEZONE_SETTING,
  browserTimeZone,
  formatNowIn,
  timeZoneChoices,
  useClock,
} from '../onboarding/timezone'
import { InlineSave, type SaveMessage } from './shared'

/**
 * Settings → General (S9 T5): the instance timezone, nova.timezone — the
 * zone reminders and schedules are computed in, and the zone `get_time`
 * answers in. The value is the server's, passed in from SettingsPage's one
 * settings fetch (the ResponseQualitySection idiom); the picker is the same
 * list the onboarding step offers, plus whatever is stored, so a zone set
 * from another machine never vanishes from the menu.
 *
 * InlineSave: the pick is live in the clock line immediately, but nothing
 * is written until Save; "Saved" appears only after the PUT returned. A
 * refusal (core validates the name against zoneinfo) is shown in core's own
 * words with the field marked invalid, and the stored value stands.
 *
 * Core's default for this key ("UTC") counts as UNSET on the server side —
 * the timers tool refuses an absolute time until it changes — so when the
 * stored value still equals the default this section says so, because this
 * is exactly where that refusal sends the owner.
 */
export function GeneralSection({
  timezone,
  timezoneIsDefault,
  onChanged,
}: {
  /** The stored nova.timezone; '' when this core does not expose the key. */
  timezone: string
  /** True while the stored value still equals the registry default. */
  timezoneIsDefault: boolean
  onChanged: (zone: string) => void
}) {
  const [draft, setDraft] = useState(timezone)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<SaveMessage | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const zones = useMemo(() => timeZoneChoices([browserTimeZone(), timezone]), [timezone])
  const now = useClock()

  const dirty = draft !== timezone
  const shown = draft || timezone
  const localTime = shown ? formatNowIn(shown, now) : null

  const save = async () => {
    setSaving(true)
    setMessage(null)
    setRefusal(null)
    try {
      await putSetting(TIMEZONE_SETTING, draft)
      onChanged(draft)
      setMessage({ kind: 'ok', text: `Saved — Nova keeps time in ${draft}` })
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setDraft(timezone)
    setMessage(null)
    setRefusal(null)
  }

  return (
    <Section icon={Globe} title="General" description="Where this instance keeps time.">
      <div className="space-y-3">
        <Select
          label="Timezone"
          value={draft}
          disabled={saving}
          // The banner below carries core's reason; this marks the FIELD
          // (ring, aria-invalid, aria-describedby) through the component.
          error={refusal ? 'Not saved — the stored zone stands.' : undefined}
          description="Reminders and schedules are computed in this zone — “7 am” means 7 am here."
          onChange={e => {
            setDraft(e.target.value)
            setMessage(null)
            setRefusal(null)
          }}
        >
          {!timezone && <option value="">Not set</option>}
          {zones.map(zone => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>

        <p data-testid="general-timezone-now" className="text-caption text-content-secondary">
          {!shown
            ? 'No timezone is set on this instance.'
            : localTime
              ? (
                <>
                  Right now in {shown}:{' '}
                  <span className="font-mono text-content-primary">{localTime}</span>
                </>
              )
              : `This browser cannot show the time in ${shown}.`}
        </p>

        {timezoneIsDefault && !dirty && (
          <div
            data-testid="general-timezone-default"
            className="rounded-sm border border-warning/30 bg-warning-dim px-3 py-2 text-caption text-content-primary"
          >
            Still the default. Nova treats it as unset: a reminder at a clock time is refused
            until a zone is chosen here. Relative ones (&ldquo;in 20 minutes&rdquo;) work either way.
          </div>
        )}

        {refusal && (
          <div
            role="alert"
            className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
          >
            Could not save the timezone: {refusal}
          </div>
        )}

        <InlineSave dirty={dirty} saving={saving} onSave={save} onReset={reset} message={message} />
      </div>
    </Section>
  )
}
