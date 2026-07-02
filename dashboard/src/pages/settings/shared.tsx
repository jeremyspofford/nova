import { useState, useEffect } from 'react'
import { Save, RotateCcw, CheckCircle2, XCircle, History, AlertTriangle } from 'lucide-react'
import { Button, Input, Textarea } from '../../components/ui'
import { getPlatformConfigHistory } from '../../api'
import type { PlatformConfigEntry, PlatformConfigHistoryEntry } from '../../api'

// Re-export the new design system Section so existing section files can migrate gradually
export { Section } from '../../components/ui'

// ── Config entry helper ──────────────────────────────────────────────────────

export function useConfigValue(
  entries: PlatformConfigEntry[],
  key: string,
  defaultValue = '',
): string {
  const entry = entries.find(e => e.key === key)
  if (!entry || entry.value === null || entry.value === '') return defaultValue
  return String(entry.value)
}

// ── Inline editable field ────────────────────────────────────────────────────

export function ConfigField({
  label,
  configKey,
  value,
  description,
  multiline = false,
  rows,
  placeholder = '',
  onSave,
  saving,
  envOverride,
}: {
  label: string
  configKey: string
  value: string
  description?: string
  multiline?: boolean
  rows?: number
  placeholder?: string
  onSave: (key: string, value: string) => void
  saving: boolean
  /** Passed for keys that also have a legacy .env variable set (source badge). */
  envOverride?: { var: string; value: string; ignored: boolean }
}) {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)

  // Sync if external value changes (e.g. after save)
  useEffect(() => {
    setDraft(value)
    setDirty(false)
  }, [value])

  const handleChange = (v: string) => {
    setDraft(v)
    setDirty(v !== value)
  }

  const handleSave = () => onSave(configKey, JSON.stringify(draft))
  const handleReset = () => { setDraft(value); setDirty(false) }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <label className="text-caption font-medium text-content-secondary">{label}</label>
          <EnvOverrideBadge override={envOverride} />
          <ConfigHistoryToggle configKey={configKey} />
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              icon={<RotateCcw size={10} />}
            >
              Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              loading={saving}
              icon={<Save size={10} />}
            >
              Save
            </Button>
          </div>
        )}
      </div>

      {multiline ? (
        <Textarea
          value={draft}
          onChange={e => handleChange(e.target.value)}
          placeholder={placeholder}
          rows={rows ?? 6}
          autoResize={false}
          description={description}
        />
      ) : (
        <Input
          value={draft}
          onChange={e => handleChange(e.target.value)}
          placeholder={placeholder}
          description={description}
        />
      )}
    </div>
  )
}

// ── .env override badge ───────────────────────────────────────────────────────
// Amber "source" warning: this DB-owned key also has a legacy .env variable set
// whose value is being ignored (Settings wins). Signals dead weight to remove.

export function EnvOverrideBadge({
  override,
}: {
  override?: { var: string; value: string; ignored: boolean }
}) {
  if (!override?.ignored) return null
  return (
    <span
      title={`Also set in .env as ${override.var}=${override.value}, but that value is ignored — this Settings value wins. Remove it from .env to silence.`}
      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    >
      <AlertTriangle size={11} /> .env ignored
    </span>
  )
}

// ── Config change history disclosure ──────────────────────────────────────────
// A clock button that lazily fetches platform_config_audit rows for one key.
// Available on every ConfigField so any setting can show "who changed what when".

function formatConfigValue(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return '(none)'
  if (typeof v === 'string') return v === '' ? '(empty)' : v
  return String(v)
}

export function ConfigHistoryToggle({ configKey }: { configKey: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<PlatformConfigHistoryEntry[] | null>(null)

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && rows === null && !loading) {
      setLoading(true)
      setError(null)
      try {
        setRows(await getPlatformConfigHistory(configKey))
      } catch {
        setError('Failed to load history')
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        title="Change history"
        aria-label="Change history"
        className={`inline-flex items-center rounded p-0.5 transition-colors ${
          open ? 'text-teal-500' : 'text-content-tertiary hover:text-content-secondary'
        }`}
      >
        <History size={13} />
      </button>
      {open && (
        <div className="mt-1 w-full basis-full rounded-md border border-stone-200 bg-stone-50 p-2 text-caption dark:border-stone-700 dark:bg-stone-900/50">
          {loading && <div className="text-content-tertiary">Loading history…</div>}
          {error && <div className="text-error">{error}</div>}
          {rows && rows.length === 0 && (
            <div className="text-content-tertiary">No recorded changes yet.</div>
          )}
          {rows && rows.length > 0 && (
            <ul className="space-y-1.5">
              {rows.map((r, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-[11px] text-content-tertiary line-through">
                    {formatConfigValue(r.old_value)}
                  </span>
                  <span className="text-content-tertiary">→</span>
                  <span className="font-mono text-[11px] text-content-primary">
                    {formatConfigValue(r.new_value)}
                  </span>
                  <span className="ml-auto text-[11px] text-content-tertiary">
                    {r.changed_at ? new Date(r.changed_at).toLocaleString() : ''}
                    {r.changed_by ? ` · ${r.changed_by.slice(0, 8)}` : ' · system'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

// ── Service Status Badge ─────────────────────────────────────────────────────
// Used by RemoteAccessSection to show running/stopped/unconfigured state.

export function ServiceStatusBadge({ configured, running }: { configured: boolean; running: boolean }) {
  if (running) return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full">
      <CheckCircle2 size={12} /> Running
    </span>
  )
  if (configured) return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 rounded-full">
      <XCircle size={12} /> Stopped
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded-full">
      Not configured
    </span>
  )
}

// ── Common types for section props ───────────────────────────────────────────

export interface ConfigSectionProps {
  entries: PlatformConfigEntry[]
  onSave: (key: string, value: string) => void
  saving: boolean
}
