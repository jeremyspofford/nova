import { useState } from 'react'
import { Monitor, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { Section } from '../../components/ui'
import { ConfigField } from './shared'
import { testScreenpipeConnection } from '../../api'
import type { ConfigSectionProps } from './shared'

// ── Screenpipe Connection Section ─────────────────────────────────────────────

export function ScreenpipeConnectionSection({ entries, onSave, saving }: ConfigSectionProps) {
  const enabledEntry = entries.find(e => e.key === 'screenpipe.enabled')
  const enabled = enabledEntry?.value === true || enabledEntry?.value === 'true'

  const urlEntry = entries.find(e => e.key === 'screenpipe.url')
  const urlValue = urlEntry?.value != null && urlEntry.value !== '' ? String(urlEntry.value) : ''

  const apiKeyEntry = entries.find(e => e.key === 'screenpipe.api_key')
  const apiKeyValue = apiKeyEntry?.value != null && apiKeyEntry.value !== '' ? String(apiKeyEntry.value) : ''

  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const onTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testScreenpipeConnection()
      if (result.ok) {
        setTestResult({
          ok: true,
          text: `Connected (${result.sample_event_count ?? 0} sample events)`,
        })
      } else {
        setTestResult({ ok: false, text: `Error: ${result.error ?? 'unknown'}` })
      }
    } catch (e) {
      setTestResult({ ok: false, text: `Error: ${(e as Error).message}` })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Section
      icon={Monitor}
      title="Screenpipe"
      description="Subscribe to a workstation-side screenpipe daemon for personal screen capture context. Captured events are ingested into Nova's memory as engrams."
    >
      {/* Enable / disable toggle */}
      <div className="flex items-center justify-between py-2">
        <div>
          <p className="text-compact font-medium text-content-primary">Enable Screenpipe</p>
          <p className="text-caption text-content-tertiary mt-0.5">
            Stream screen capture events from a local screenpipe daemon into Nova's memory.
          </p>
        </div>
        <button
          onClick={() => onSave('screenpipe.enabled', JSON.stringify(!enabled))}
          disabled={saving}
          className={`relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${
            enabled ? 'bg-teal-500' : 'bg-stone-700'
          }`}
          aria-label={enabled ? 'Disable Screenpipe' : 'Enable Screenpipe'}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-5' : ''
            }`}
          />
        </button>
      </div>

      <ConfigField
        label="Screenpipe URL"
        configKey="screenpipe.url"
        value={urlValue}
        placeholder="http://workstation:3030"
        description="Base URL of the screenpipe daemon running on your workstation."
        onSave={onSave}
        saving={saving}
      />

      <ConfigField
        label="API Key"
        configKey="screenpipe.api_key"
        value={apiKeyValue}
        placeholder={apiKeyValue ? '••••••••••••• (key configured)' : 'Screenpipe API key (if required)'}
        description="Bearer token for authenticating with the screenpipe daemon. Leave blank if authentication is not enabled."
        onSave={onSave}
        saving={saving}
      />

      {/* Test connection */}
      <div className="mt-4 space-y-2">
        <button
          onClick={onTest}
          disabled={testing || !urlValue}
          className="flex items-center gap-2 rounded-md border border-teal-600 text-teal-600 dark:text-teal-400 dark:border-teal-600 px-3 py-1.5 text-sm font-medium hover:bg-teal-50 dark:hover:bg-teal-900/20 disabled:opacity-50 transition-colors"
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : null}
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
        {testResult && (
          <p
            className={`flex items-center gap-1.5 text-sm ${
              testResult.ok
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {testResult.text}
          </p>
        )}
        {!urlValue && (
          <p className="text-xs text-content-tertiary">Enter a Screenpipe URL above to test the connection.</p>
        )}
      </div>
    </Section>
  )
}
