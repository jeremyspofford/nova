import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Save, RotateCcw, Database, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { apiFetch } from '../../api'
import { Section, Button, Input, StatusDot } from '../../components/ui'
import { useConfigValue, type ConfigSectionProps } from './shared'

// ── Backend presets ─────────────────────────────────────────────────────────

const BACKENDS = [
  { value: 'engram', label: 'Engram Network (graph)', desc: 'Graph-based cognitive memory with spreading activation, consolidation, and pgvector retrieval. Current default.' },
  { value: 'okf', label: 'OKF Markdown (experimental)', desc: 'Memory as a folder of markdown files with OKF frontmatter — human-readable, git-trackable, BM25 retrieval. Ships with the OKF backend phase; selecting it before then falls back to engram.' },
] as const

const BACKEND_KEY = 'memory.backend'
const DEFAULT_BACKEND = 'engram'

const URL_KEY = 'memory.provider_url'
const DEFAULT_URL = 'http://memory-service:8002'

// ── MemoryProviderSection ───────────────────────────────────────────────────

export function MemoryProviderSection({ entries, onSave, saving }: ConfigSectionProps) {
  const configuredBackend = useConfigValue(entries, BACKEND_KEY, DEFAULT_BACKEND)
  const configuredUrl = useConfigValue(entries, URL_KEY, DEFAULT_URL)

  const [selectedBackend, setSelectedBackend] = useState(configuredBackend)
  const [showAdvanced, setShowAdvanced] = useState(configuredUrl !== DEFAULT_URL)
  const [customUrl, setCustomUrl] = useState(configuredUrl)

  useEffect(() => {
    setSelectedBackend(configuredBackend)
  }, [configuredBackend])

  useEffect(() => {
    setCustomUrl(configuredUrl)
    if (configuredUrl !== DEFAULT_URL) setShowAdvanced(true)
  }, [configuredUrl])

  const backendDirty = selectedBackend !== configuredBackend
  const urlDirty = customUrl.trim() !== configuredUrl

  const handleSave = () => {
    if (backendDirty) onSave(BACKEND_KEY, JSON.stringify(selectedBackend))
    if (urlDirty && customUrl.trim()) onSave(URL_KEY, JSON.stringify(customUrl.trim()))
  }

  const handleReset = () => {
    setSelectedBackend(configuredBackend)
    setCustomUrl(configuredUrl)
  }

  // Health + live backend — memory-service reports which backend actually serves
  const { data: health } = useQuery<{ status: string }>({
    queryKey: ['memory-provider-health'],
    queryFn: () => apiFetch('/mem/health/ready'),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 1,
  })
  const { data: liveBackend } = useQuery<{ backend: string }>({
    queryKey: ['memory-active-backend'],
    queryFn: () => apiFetch('/mem/api/v1/memory/backend'),
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: 1,
  })

  const isHealthy = health?.status === 'ok' || health?.status === 'ready'
  const healthStatus: 'success' | 'danger' | 'neutral' = health == null
    ? 'neutral'
    : isHealthy ? 'success' : 'danger'
  const healthLabel = health == null
    ? 'Checking...'
    : isHealthy ? 'Healthy' : 'Unreachable'

  const activeLabel = BACKENDS.find(b => b.value === (liveBackend?.backend ?? configuredBackend))?.label
    ?? liveBackend?.backend ?? configuredBackend
  const dirty = backendDirty || urlDirty

  return (
    <Section
      icon={Database}
      title="Memory Backend"
      description="Which storage engine serves Nova's memory. Switching backends does not migrate existing memories — each backend keeps its own store."
    >
      {/* Current status */}
      <div className="flex items-center gap-3 mb-1">
        <StatusDot status={healthStatus} pulse={health == null} />
        <span className="text-compact text-content-primary">
          {activeLabel} — {healthLabel}
        </span>
        {!dirty && (
          <span className="text-caption font-mono text-content-tertiary ml-auto">
            {configuredUrl}
          </span>
        )}
      </div>

      {backendDirty && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-caption text-amber-700 dark:text-amber-400">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Backend change selected.</p>
            <p className="text-amber-700/80 dark:text-amber-400/80">
              Switching backends does not migrate memories — Nova starts from whatever the target backend already holds. The switch takes effect within ~15 seconds, no restart needed.
            </p>
          </div>
        </div>
      )}

      {/* Backend selector */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-caption font-medium text-content-secondary">Backend</label>
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

        <select
          value={selectedBackend}
          onChange={e => setSelectedBackend(e.target.value)}
          className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors appearance-none"
        >
          {BACKENDS.map(b => (
            <option key={b.value} value={b.value}>{b.label}</option>
          ))}
        </select>

        <p className="mt-1 text-caption text-content-tertiary">
          {BACKENDS.find(b => b.value === selectedBackend)?.desc}
        </p>
      </div>

      {/* Advanced: external provider URL */}
      <button
        type="button"
        onClick={() => setShowAdvanced(v => !v)}
        className="mt-3 flex items-center gap-1 text-caption font-medium text-content-secondary hover:text-content-primary transition-colors"
      >
        {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Advanced: external provider URL
      </button>
      {showAdvanced && (
        <div className="mt-2">
          <Input
            value={customUrl}
            onChange={e => setCustomUrl(e.target.value)}
            placeholder={DEFAULT_URL}
          />
          <p className="mt-1 text-caption text-content-tertiary">
            Point the orchestrator at a different memory service entirely. Must serve <code className="font-mono">/api/v1/memory/*</code> paths per the nova-contracts memory interface. Leave at the default unless you run your own provider.
          </p>
        </div>
      )}
    </Section>
  )
}
