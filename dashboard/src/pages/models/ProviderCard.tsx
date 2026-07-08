import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, ExternalLink } from 'lucide-react'
import { apiFetch, testProvider } from '../../api'
import type { ProviderModelList } from '../../api'
import { Badge, Button, Card, StatusDot } from '../../components/ui'
import type { SemanticColor } from '../../lib/design-tokens'

const TYPE_BADGE: Record<string, { label: string; color: SemanticColor }> = {
  local:        { label: 'Local',        color: 'accent' },
  subscription: { label: 'Subscription', color: 'info' },
  free:         { label: 'Free Tier',    color: 'success' },
  paid:         { label: 'Paid API',     color: 'warning' },
}

export function ProviderCard({ provider }: { provider: ProviderModelList }) {
  // "In memory" truth for local models — backends evict/lazy-load, and a
  // pulled model is not a loaded model. One shared query across all cards.
  const { data: loadedInfo } = useQuery({
    queryKey: ['inference-loaded'],
    queryFn: () => apiFetch<{ backend: string; healthy: boolean; loaded_models: string[] }>(
      '/v1/health/inference/loaded'
    ),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 0,
    enabled: provider.type === 'local',
  })
  const loadedModels = loadedInfo?.loaded_models ?? []
  const isModelLoaded = (id: string) => {
    const base = id.includes('/') ? id.split('/').pop()! : id
    return loadedModels.some(l => l === id || l === base || l.startsWith(base) || base.startsWith(l))
  }
  const navigate = useNavigate()
  const badge = TYPE_BADGE[provider.type] ?? TYPE_BADGE.free
  const configured = provider.available
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms?: number; error?: string } | null>(null)
  const dotStatus = testResult ? (testResult.ok ? 'success' : 'danger') : configured ? 'neutral' : 'neutral'

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testProvider(provider.slug)
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, error: String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card
      className={clsx(
        configured ? 'border-accent-dim' : 'opacity-55 hover:opacity-75 transition-opacity',
      )}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <StatusDot status={dotStatus} />
            <h3 className="text-compact font-semibold text-content-primary">{provider.name}</h3>
            <Badge color={badge.color} size="sm">{badge.label}</Badge>
            {provider.models.length > 0 && configured && (
              <Badge color="neutral" size="sm">{provider.models.length} models</Badge>
            )}
          </div>
          {configured && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleTest}
              loading={testing}
            >
              Test
            </Button>
          )}
        </div>

        {/* Test result */}
        {testResult && (
          <div className={`mb-3 rounded-sm px-3 py-2 text-caption ${testResult.ok ? 'bg-success-dim text-success' : 'bg-danger-dim text-danger'}`}>
            {testResult.ok ? `OK -- ${testResult.latency_ms}ms` : `Failed: ${testResult.error}`}
          </div>
        )}

        {configured ? (
          <div className="space-y-1.5">
            {provider.models.length > 0 ? (
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {provider.models.map(m => (
                  <li
                    key={m.id}
                    className="flex items-center gap-1.5 text-mono-sm text-content-secondary truncate"
                    title={m.id}
                  >
                    {m.registered && <Check className="h-3 w-3 text-success shrink-0" />}
                    <span className="min-w-0 truncate">{m.id}</span>
                    {provider.type === 'local' && isModelLoaded(m.id) && (
                      <Badge color="success" size="sm">in memory</Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-content-tertiary italic">
                Connected -- models loaded from provider config
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-caption text-content-tertiary">Not configured. To enable:</p>
            <ul className="space-y-1">
              {provider.auth_methods.map((method, i) => (
                <li key={i} className="flex items-start gap-1.5 text-caption text-content-tertiary">
                  <span className="text-content-tertiary mt-0.5">--</span>
                  <code className="text-mono-sm text-content-secondary">{method}</code>
                </li>
              ))}
            </ul>
            <button
              onClick={() => navigate('/settings#provider-status')}
              className="inline-flex items-center gap-1 text-caption text-accent hover:underline"
            >
              Configure in Settings <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </Card>
  )
}
