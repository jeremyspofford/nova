import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { Skeleton } from '../../components/ui'
import { useAuth } from '../../stores/auth-store'
import { useChatStore } from '../../stores/chat-store'
import { getSettings, putSetting, settingValue, type SettingDef } from '../../lib/api'
import { GeneralSection } from './GeneralSection'
import { AppearanceSection } from './AppearanceSection'
import { DisplayDiagnostics } from './DisplayDiagnostics'
import { DEFAULT_PRESET, normalizePreset } from '../../lib/color-palettes'
import { AccountSection } from './AccountSection'
import { ModelsSection } from './ModelsSection'
import { DevicesSection } from './DevicesSection'
import { ProvidersSection } from './ProvidersSection'
import { ResponseQualitySection } from './ResponseQualitySection'
import { RoutingSection } from './RoutingSection'
import { ProactiveSection } from './ProactiveSection'
import { SETTINGS_TABS, resolveTab } from './tabs'

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
  // The URL owns which tab is showing. An unrecognised slug — a bookmark
  // from before a rename, a typo — resolves to the first tab rather than
  // rendering nothing, because an empty settings page and a settings page
  // that failed to load look identical.
  const tab = resolveTab(useParams().tab)
  const { refresh } = useAuth()
  const { state: chatState, setModel } = useChatStore()
  const [settings, setSettings] = useState<SettingDef[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // The instance may still hold a key from before the theme redesign
  // ('default', 'ocean', …): read it as what replaced it, so the picker can
  // mark a real card as the default instead of naming a theme that is gone.
  const storedPreset = settings
    ? normalizePreset(settingValue(settings, 'appearance.default_preset', DEFAULT_PRESET)) ?? DEFAULT_PRESET
    : null
  const chatModel =
    chatState.model ?? (settings ? settingValue(settings, 'chat.model', '') : '')
  // Opt-in, default OFF — reflects the stored value, unset reads false.
  const responsivenessCheck = settings
    ? settingValue(settings, 'agents.responsiveness_check', false)
    : false
  // nova.timezone (S9): the zone schedules are computed in. Its registry
  // default counts as UNSET on the server (the timers tool refuses a clock
  // time until it changes), so General is told when value === default.
  // '' when this core does not expose the key yet.
  const timezoneDef = settings?.find(s => s.key === 'nova.timezone')
  const timezone = typeof timezoneDef?.value === 'string' ? timezoneDef.value : ''
  const timezoneIsDefault = timezoneDef !== undefined && timezoneDef.value === timezoneDef.default

  // S11: the three proactive settings, off the same one settings fetch. The
  // section is mounted only when core exposes all three keys — a core that
  // predates the slice cannot be configured, and defaults invented here would
  // draw a switch whose write core refuses by name. Where a stored value is
  // not the type the registry declares, the def's OWN default is shown rather
  // than a number made up in the browser.
  const defOf = (key: string) => settings?.find(s => s.key === key)
  const enabledDef = defOf('proactive.enabled')
  const digestDef = defOf('proactive.digest_at')
  const maxNoticesDef = defOf('proactive.max_notices_per_day')
  const proactive =
    enabledDef && digestDef && maxNoticesDef
      ? {
          enabled: enabledDef.value === true,
          digestAt:
            typeof digestDef.value === 'string' ? digestDef.value : String(digestDef.default),
          maxNoticesPerDay:
            typeof maxNoticesDef.value === 'number'
              ? maxNoticesDef.value
              : Number(maxNoticesDef.default),
        }
      : null

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

      {/* LINKS, not buttons with state. Each tab is a real address, so it
          can be bookmarked, sent to someone, and survive a refresh — and the
          browser's back button steps between tabs the way it does everywhere
          else. `aria-current` is the honest markup for that; the ARIA tab
          pattern describes in-page panels, which these are not. */}
      <nav aria-label="Settings sections" className="mb-4 border-b border-border-subtle">
        <div className="flex gap-1 overflow-x-auto custom-scrollbar -mb-px">
          {SETTINGS_TABS.map(t => {
            const current = t.slug === tab
            return (
              // A plain Link, NOT NavLink: NavLink decides `aria-current`
              // from its OWN path match and overrides the prop, so at bare
              // `/settings` — which resolves to this first tab — it marked
              // nothing current. `current` here comes from the resolved tab,
              // which knows about that fallback and about bad slugs.
              <Link
                key={t.slug}
                to={`/settings/${t.slug}`}
                aria-current={current ? 'page' : undefined}
                data-testid={`settings-tab-${t.slug}`}
                className={clsx(
                  'shrink-0 whitespace-nowrap px-3 py-2 text-compact font-medium border-b-2 transition-colors duration-fast',
                  current
                    ? 'border-accent text-accent'
                    : 'border-transparent text-content-secondary hover:text-content-primary hover:border-border',
                )}
              >
                {t.label}
              </Link>
            )
          })}
        </div>
      </nav>
      <p className="mb-6 text-caption text-content-tertiary" data-testid="settings-tab-blurb">
        {SETTINGS_TABS.find(t => t.slug === tab)?.blurb}
      </p>

      <div className="space-y-6" data-testid="settings-panel">
        {settings === null && !error ? (
          <Skeleton lines={6} />
        ) : (
          <>
            {tab === 'general' && (
              <GeneralSection
                timezone={timezone}
                timezoneIsDefault={timezoneIsDefault}
                onChanged={zone => updateSettingValue('nova.timezone', zone)}
              />
            )}
            {tab === 'appearance' && (
              <>
                <AppearanceSection
                  storedPreset={storedPreset ?? DEFAULT_PRESET}
                  onStored={preset => updateSettingValue('appearance.default_preset', preset)}
                />
                {/* Reads the device, writes nothing. Here because every
                    layout defect this app has had lived in iOS standalone
                    mode, which no harness reproduces — so the numbers have to
                    come from the phone that looks wrong. */}
                <DisplayDiagnostics />
              </>
            )}
            {tab === 'models' && (
              <>
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
                <ProvidersSection
                  chatModel={chatModel}
                  onModelChanged={model => {
                    updateSettingValue('chat.model', model)
                    setModel(model)
                  }}
                />
                <RoutingSection chatModel={chatModel} />
              </>
            )}
            {tab === 'behaviour' && (
              <>
                {proactive && (
                  <ProactiveSection
                    enabled={proactive.enabled}
                    digestAt={proactive.digestAt}
                    maxNoticesPerDay={proactive.maxNoticesPerDay}
                    // The value CORE stored, handed straight back into the
                    // one settings state this page renders from.
                    onChanged={(key, value) => updateSettingValue(key, value)}
                  />
                )}
                <ResponseQualitySection
                  checked={responsivenessCheck}
                  onChanged={value => updateSettingValue('agents.responsiveness_check', value)}
                />
              </>
            )}
            {tab === 'devices' && <DevicesSection />}
          </>
        )}
        {/* Signing out is not one of the five errands above, and hunting for
            it under a tab would be worse than a row at the foot of every one
            of them. */}
        {tab === 'general' && <AccountSection />}
      </div>
    </div>
  )
}
