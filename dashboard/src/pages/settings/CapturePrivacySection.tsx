import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Section } from '../../components/ui'
import type { ConfigSectionProps } from './shared'
import { useConfigValue } from './shared'

// ── Helper ────────────────────────────────────────────────────────────────────

function safeParseList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}

// ── List editor ───────────────────────────────────────────────────────────────

interface ListEditorProps {
  label: string
  hint: string
  values: string[]
  onChange: (values: string[]) => void
  saving: boolean
  placeholder?: string
}

function ListEditor({ label, hint, values, onChange, saving, placeholder }: ListEditorProps) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) {
      onChange([...values, v])
      setDraft('')
    }
  }

  const remove = (v: string) => onChange(values.filter(x => x !== v))

  return (
    <div>
      <label className="text-caption font-medium text-content-secondary block mb-1">{label}</label>
      <p className="text-micro text-content-tertiary mb-2">{hint}</p>

      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {values.map(v => (
            <span
              key={v}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-card border border-border-subtle text-caption text-content-primary"
            >
              {v}
              <button
                type="button"
                onClick={() => remove(v)}
                disabled={saving}
                className="text-content-tertiary hover:text-danger transition-colors disabled:opacity-50 ml-0.5 leading-none"
                aria-label={`Remove ${v}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={placeholder ?? `Add ${label.toLowerCase()}…`}
          disabled={saving}
          className="flex-1 rounded-md border border-border-subtle bg-surface-card px-2.5 py-1.5 text-compact text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
        <button
          type="button"
          onClick={add}
          disabled={saving || !draft.trim()}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-compact text-white font-medium hover:bg-teal-700 disabled:opacity-50 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_TITLES = ['Password', 'Incognito', 'Private Browsing', 'InPrivate']

// ── Section ───────────────────────────────────────────────────────────────────

export function CapturePrivacySection({ entries, onSave, saving }: ConfigSectionProps) {
  const apps = safeParseList(useConfigValue(entries, 'capture.denylist.apps', '[]'))
  const urls = safeParseList(useConfigValue(entries, 'capture.denylist.url_patterns', '[]'))
  const windows = safeParseList(useConfigValue(entries, 'capture.denylist.window_titles', '[]'))

  const updateList = (key: string, values: string[]) =>
    onSave(key, JSON.stringify(values))

  const resetDefaults = () => {
    onSave('capture.denylist.apps', '[]')
    onSave('capture.denylist.url_patterns', '[]')
    onSave('capture.denylist.window_titles', JSON.stringify(DEFAULT_WINDOW_TITLES))
  }

  return (
    <Section
      icon={ShieldAlert}
      title="Capture Privacy"
      description="Apps, URL patterns, and window titles to exclude from screen capture."
    >
      <ListEditor
        label="Excluded apps"
        hint="Exact app name match. The app will be skipped entirely during capture (e.g. 1Password)."
        values={apps}
        saving={saving}
        onChange={vs => updateList('capture.denylist.apps', vs)}
        placeholder="Add app name…"
      />

      <ListEditor
        label="Excluded URL patterns"
        hint="Regex applied to browser URLs. Matching pages are excluded from capture."
        values={urls}
        saving={saving}
        onChange={vs => updateList('capture.denylist.url_patterns', vs)}
        placeholder="Add URL pattern…"
      />

      <ListEditor
        label="Excluded window titles"
        hint="Case-insensitive substring match on window title. Matching windows are excluded."
        values={windows}
        saving={saving}
        onChange={vs => updateList('capture.denylist.window_titles', vs)}
        placeholder="Add window title substring…"
      />

      <div className="pt-2 border-t border-border-subtle">
        <button
          type="button"
          onClick={resetDefaults}
          disabled={saving}
          className="text-caption text-content-tertiary hover:text-content-secondary underline underline-offset-2 disabled:opacity-50 transition-colors"
        >
          Reset to defaults
        </button>
        <p className="text-micro text-content-tertiary mt-1">
          Restores window title defaults: {DEFAULT_WINDOW_TITLES.join(', ')}. Clears app and URL lists.
        </p>
      </div>
    </Section>
  )
}
