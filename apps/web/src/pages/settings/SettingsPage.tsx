import { useEffect, useState } from 'react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Skeleton } from '../../components/ui'
import { useAuth } from '../../stores/auth-store'
import { getSettings, putSetting, settingValue, type SettingDef } from '../../lib/api'
import { AppearanceSection } from './AppearanceSection'
import { AccountSection } from './AccountSection'
import { ModelsSection } from './ModelsSection'

/**
 * The S1 settings shell: two sections and no tab machinery yet. The tabs and
 * search from the v0.5.0 shell earn their keep at a dozen sections, not two.
 *
 * S2e adds a third: Models. Its chat.model comes from the same settings
 * fetch this page already does for the appearance preset, rather than a
 * second GET /api/v1/settings.
 */
export function SettingsPage() {
  const { refresh } = useAuth()
  const [settings, setSettings] = useState<SettingDef[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const storedPreset = settings ? settingValue(settings, 'appearance.default_preset', 'default') : null
  const chatModel = settings ? settingValue(settings, 'chat.model', '') : ''

  /** Reflects a write this page already knows succeeded, without a second
   * GET /api/v1/settings round trip. */
  const updateSettingValue = (key: string, value: unknown) => {
    setSettings(prev => (prev ? prev.map(s => (s.key === key ? { ...s, value } : s)) : prev))
  }

  // Clears onboarding.completed and lets the app gate (App.tsx's Gate) pick
  // that up on its own: refresh() re-fetches this browser's identity, which
  // re-triggers the gate's settings re-probe and — seeing the flag false —
  // swaps this whole page out for the wizard, landing on Hardware/Engine
  // since the account already exists (steps.ts: initialStep(hasUsers)).
  // Navigating here directly would only be caught by AppRoutes' own
  // catch-all (back to /chat) before that swap happens.
  const handleRerunSetup = async () => {
    await putSetting('onboarding.completed', false)
    await refresh()
  }

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
        {settings === null && !error ? (
          <Skeleton lines={6} />
        ) : (
          <>
            <AppearanceSection
              storedPreset={storedPreset ?? 'default'}
              onStored={preset => updateSettingValue('appearance.default_preset', preset)}
            />
            <ModelsSection
              chatModel={chatModel}
              onModelChanged={model => updateSettingValue('chat.model', model)}
              onRerunSetup={handleRerunSetup}
            />
          </>
        )}
        <AccountSection />
      </div>
    </div>
  )
}
