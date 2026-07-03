import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Save, RotateCcw, Database, ChevronDown, ChevronRight } from 'lucide-react'
import { apiFetch } from '../../api'
import { Section, Button, Input, StatusDot } from '../../components/ui'
import { useConfigValue, type ConfigSectionProps } from './shared'

const URL_KEY = 'memory.provider_url'
const DEFAULT_URL = 'http://memory-service:8002'

// ── MemoryProviderSection ───────────────────────────────────────────────────

export function MemoryProviderSection({ entries, onSave, saving }: ConfigSectionProps) {
  const configuredUrl = useConfigValue(entries, URL_KEY, DEFAULT_URL)

  const [showAdvanced, setShowAdvanced] = useState(configuredUrl !== DEFAULT_URL)
  const [customUrl, setCustomUrl] = useState(configuredUrl)

  useEffect(() => {
    setCustomUrl(configuredUrl)
    if (configuredUrl !== DEFAULT_URL) setShowAdvanced(true)
  }, [configuredUrl])

  const dirty = customUrl.trim() !== configuredUrl

  const handleSave = () => {
    if (dirty && customUrl.trim()) onSave(URL_KEY, JSON.stringify(customUrl.trim()))
  }

  const handleReset = () => {
    setCustomUrl(configuredUrl)
  }

  const { data: health } = useQuery<{ status: string }>({
    queryKey: ['memory-provider-health'],
    queryFn: () => apiFetch('/mem/health/ready'),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 1,
  })

  const isHealthy = health?.status === 'ok' || health?.status === 'ready'
  const healthStatus: 'success' | 'danger' | 'neutral' = health == null
    ? 'neutral'
    : isHealthy ? 'success' : 'danger'
  const healthLabel = health == null
    ? 'Checking...'
    : isHealthy ? 'Healthy' : 'Unreachable'

  return (
    <Section
      icon={Database}
      title="Memory"
      description="Nova's memory is a folder of markdown files with OKF frontmatter — human-readable, git-trackable, BM25 retrieval. Edit the files directly; the index self-heals."
    >
      {/* Current status */}
      <div className="flex items-center gap-3 mb-1">
        <StatusDot status={healthStatus} pulse={health == null} />
        <span className="text-compact text-content-primary">
          OKF Markdown — {healthLabel}
        </span>
        {!dirty && (
          <span className="text-caption font-mono text-content-tertiary ml-auto">
            {configuredUrl}
          </span>
        )}
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
          <div className="mb-1.5 flex items-center justify-end gap-2">
            {dirty && (
              <>
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
              </>
            )}
          </div>
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
