import { useEffect, useState } from 'react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Skeleton } from '../../components/ui'
import { useAuth } from '../../stores/auth-store'
import { useChatStore } from '../../stores/chat-store'
import { getSettings, putSetting, settingValue, type SettingDef } from '../../lib/api'
import { AppearanceSection } from './AppearanceSection'
import { AccountSection } from './AccountSection'
import { ModelsSection } from './ModelsSection'
import { AutonomySection } from './AutonomySection'
import { ResponseQualitySection } from './ResponseQualitySection'

/**
 * The S1 settings shell: two sections and no tab machinery yet. The tabs and
 * search from the v0.5.0 shell earn their keep at a dozen sections, not two.
 *
 * S2e adds a third: Models. Its chat.model comes from the same settings
 * fetch this page already does for the appearance preset, rather than a
 * second GET /api/v1/settings — EXCEPT once a switch has happened, or a
 * turn has run, in this session: see `chatModel` below.
 *
 * Slice 2f Fix A: switching the model here did not visibly take effect —
 * neither the list's "Current" marker nor the chat badge moved without
 * sending a message first. The chat badge's staleness was the real bug
 * (ChatPage's pre-first-turn fallback reads a Gate settings snapshot this
 * page's own PUT never touched); this page's own "Current" marker already
 * followed its local `settings` echo correctly, but a switch made here and
 * a switch's effect on chat were two different pieces of state that could
 * silently disagree. The fix reads BOTH from `chat-store`'s `state.model` —
 * the same store ChatPage already prefers over its Gate-derived
 * `initialModel` — falling back to the settings-fetched value only for a
 * session where neither a switch nor a turn has happened yet. `setModel`
 * (called from `onModelChanged` below) is the one write path both surfaces
 * now share.
 */
export function SettingsPage() {
  const { refresh } = useAuth()
  const { state: chatState, setModel } = useChatStore()
  const [settings, setSettings] = useState<SettingDef[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const storedPreset = settings ? settingValue(settings, 'appearance.default_preset', 'default') : null
  const chatModel =
    chatState.model ?? (settings ? settingValue(settings, 'chat.model', '') : '')
  // Opt-in, default OFF — reflects the stored value, unset reads false.
  const responsivenessCheck = settings
    ? settingValue(settings, 'agents.responsiveness_check', false)
    : false

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
              onModelChanged={model => {
                // Both writes matter: the settings echo keeps this page's
                // OWN state consistent with the PUT that just succeeded
                // (harmless once `chatModel` above prefers chat-store, but
                // cheap and correct), while `setModel` is what actually
                // makes the switch visible — the Settings list's "Current"
                // marker and the chat badge both re-render off it the
                // instant this fires, with no message sent.
                updateSettingValue('chat.model', model)
                setModel(model)
              }}
              onRerunSetup={handleRerunSetup}
            />
            <ResponseQualitySection
              checked={responsivenessCheck}
              onChanged={value => updateSettingValue('agents.responsiveness_check', value)}
            />
            <AutonomySection />
          </>
        )}
        <AccountSection />
      </div>
    </div>
  )
}
