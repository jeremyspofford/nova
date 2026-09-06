import { useMemo, useState } from 'react'
import { Clock } from 'lucide-react'
import { Button, Select } from '../../../components/ui'
import { putSetting } from '../../../lib/api'
import {
  TIMEZONE_SETTING,
  browserTimeZone,
  formatNowIn,
  timeZoneChoices,
  useClock,
} from '../timezone'

/**
 * The instance's timezone (nova.timezone) — the zone Nova computes "7 am"
 * and "tomorrow" in for reminders and schedules. Preselected from this
 * browser, checkable by the clock shown for the chosen zone, and WRITTEN
 * before the wizard moves on: a refused or unreachable write is stated here
 * and the step stays. Nothing downstream is told a zone that core did not
 * accept.
 *
 * No Back: this step exists on the fresh run only (steps.ts lists it with
 * the account), and the step behind it is CreateAccount, which core lets
 * happen exactly once — the same reason HardwareDetection has no Back. A
 * returning owner changes the zone in Settings → General instead.
 */
export function Timezone({ onNext }: { onNext: () => void }) {
  const detected = useMemo(browserTimeZone, [])
  const zones = useMemo(() => timeZoneChoices([detected]), [detected])
  const [zone, setZone] = useState(detected ?? 'UTC')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useClock()
  const localTime = formatNowIn(zone, now)

  const handleContinue = async () => {
    setError(null)
    setSaving(true)
    try {
      await putSetting(TIMEZONE_SETTING, zone)
      onNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="w-16 h-16 rounded-xl bg-accent/10 flex items-center justify-center mb-6">
        <Clock className="w-8 h-8 text-accent" />
      </div>
      <h1 className="text-h2 text-content-primary mb-2">Where does Nova keep time?</h1>
      <p className="text-compact text-content-secondary max-w-md mb-6">
        Reminders and schedules are computed in this zone — &ldquo;7 am&rdquo; means 7 am
        here.{' '}
        {detected
          ? `This browser reports ${detected}.`
          : 'This browser did not report a zone, so pick one.'}
      </p>

      <div className="w-full max-w-sm space-y-3 text-left">
        <Select
          label="Timezone"
          value={zone}
          disabled={saving}
          // The banner below carries core's reason; this marks the FIELD
          // (ring, aria-invalid, aria-describedby) through the component.
          error={error ? 'Not saved.' : undefined}
          onChange={e => {
            setZone(e.target.value)
            setError(null)
          }}
          items={zones.map(z => ({ value: z, label: z }))}
        />
        <p data-testid="timezone-now" className="text-caption text-content-secondary">
          {localTime ? (
            <>
              Right now in {zone}:{' '}
              <span className="font-mono text-content-primary">{localTime}</span>
            </>
          ) : (
            `This browser cannot show the time in ${zone}.`
          )}
        </p>
        {error && (
          <div
            role="alert"
            className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger"
          >
            Could not save the timezone: {error}
          </div>
        )}
        <div className="flex gap-3 pt-2">
          <Button className="flex-1" loading={saving} onClick={handleContinue}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}
