import { useEffect, useState } from 'react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Skeleton } from '../../components/ui'
import { getSettings, settingValue } from '../../lib/api'
import { AppearanceSection } from './AppearanceSection'
import { AccountSection } from './AccountSection'

/**
 * The S1 settings shell: two sections and no tab machinery yet. The tabs and
 * search from the v0.5.0 shell earn their keep at a dozen sections, not two.
 */
export function SettingsPage() {
  const [storedPreset, setStoredPreset] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getSettings()
      .then(settings => setStoredPreset(settingValue(settings, 'appearance.default_preset', 'default')))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <div>
      <PageHeader
        title="Settings"
        description="How this instance looks and who is signed in."
      />

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not read the settings: {error}
        </div>
      )}

      <div className="space-y-6">
        {storedPreset === null && !error ? (
          <Skeleton lines={6} />
        ) : (
          <AppearanceSection storedPreset={storedPreset ?? 'default'} onStored={setStoredPreset} />
        )}
        <AccountSection />
      </div>
    </div>
  )
}
