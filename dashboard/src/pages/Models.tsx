import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  apiFetch,
  discoverModels,
  getOllamaPulled,
  getOllamaStatus,
  pullOllamaModel,
  deleteOllamaModel,
  loadOllamaModel,
  unloadOllamaModel,
  getProviderStatus,
  testProvider,
  getRoutingStats,
  getLMStudioStatus,
  getLMStudioDownloaded,
  loadLMStudioModel,
  unloadLMStudioModel,
} from '../api'
import type { ProviderModelList, OllamaPulledModel, OllamaStatus, LMStudioStatus, LMStudioDownloadedModel } from '../api'
import { CLOUD_PROVIDER_ORDER } from '../constants'
import {
  RefreshCw, Trash2, Download, Check, HardDrive, Cloud, Loader2,
  AlertTriangle, ExternalLink, Server, X, Info, Play, Cpu, Thermometer,
  Activity, Layers, Zap, ChevronDown, ChevronRight, Power, Eye, Wrench,
} from 'lucide-react'
import clsx from 'clsx'
import { formatBytes } from '../lib/format'
import { recoveryFetch } from '../api-recovery'
import {
  getBackendStatus, searchModels, switchModel, getRecommendedModels, getGPUStats, getHardwareInfo,
  type BackendStatus, type ModelSearchResult, type RecommendedModel,
} from '../api-recovery'
import { LocalModelsTable, localCounts, type LocalModelRow } from './models/LocalModelsTable'
import { PageHeader } from '../components/layout/PageHeader'
import {
  Badge, Button, Card, EmptyState, Metric, ProgressBar,
  SearchInput, Select, Skeleton, StatusDot, Table, Tooltip,
} from '../components/ui'
import type { TableColumn } from '../components/ui'
import type { SemanticColor } from '../lib/design-tokens'

// ── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_BADGE: Record<string, { label: string; color: SemanticColor }> = {
  local:        { label: 'Local',        color: 'accent' },
  subscription: { label: 'Subscription', color: 'info' },
  free:         { label: 'Free Tier',    color: 'success' },
  paid:         { label: 'Paid API',     color: 'warning' },
}

const ONBOARDING_DISMISSED_KEY = 'nova_onboarding_dismissed'

// ── Onboarding Banner ─────────────────────────────────────────────────────────

function OnboardingBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Card className="relative p-4 border-warning-dim">
      <button
        onClick={onDismiss}
        className="absolute top-3 right-3 text-content-tertiary hover:text-content-primary transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex gap-3">
        <Info className="h-5 w-5 text-warning shrink-0 mt-0.5" />
        <div className="space-y-2">
          <p className="text-compact font-medium text-content-primary">
            Nova is running on CPU with a small starter model -- responses may be slower than usual.
          </p>
          <p className="text-caption text-content-secondary">To speed things up:</p>
          <ul className="space-y-1 text-caption text-content-secondary">
            <li className="flex items-start gap-2">
              <Server className="h-4 w-4 text-accent shrink-0 mt-0.5" />
              <span><strong>Connect a GPU</strong> -- Point to a remote Ollama instance with GPU in Settings</span>
            </li>
            <li className="flex items-start gap-2">
              <Cloud className="h-4 w-4 text-info shrink-0 mt-0.5" />
              <span><strong>Use a cloud provider</strong> -- Configure an API key in Settings (Groq's free tier is a great start)</span>
            </li>
          </ul>
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            Got it
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ── Ollama Status Badge ───────────────────────────────────────────────────────

function OllamaStatusBadge({ status }: { status: OllamaStatus | undefined }) {
  if (!status) return null
  return (
    <Badge color={status.healthy ? 'success' : 'danger'} dot size="sm">
      {status.healthy ? 'Connected' : 'Unreachable'}
      <span className="text-content-tertiary font-normal ml-1">{status.base_url}</span>
    </Badge>
  )
}

// ── GPU Stats Card ──────────────────────────────────────────────────────────

function GPUStatsCard() {
  const { data: gpuStats } = useQuery({
    queryKey: ['gpu-stats'],
    queryFn: getGPUStats,
    refetchInterval: 10_000,
  })

  if (!gpuStats) return null

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Cpu size={16} className="text-accent" />
        <span className="text-compact font-semibold text-content-primary">GPU</span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <span className="text-caption text-content-tertiary flex items-center gap-1">
            <Activity size={10} /> Utilization
          </span>
          <p className="text-display font-mono text-content-primary mt-1">{gpuStats.gpu_utilization_pct}%</p>
        </div>
        <div>
          <span className="text-caption text-content-tertiary flex items-center gap-1">
            <Layers size={10} /> VRAM
          </span>
          <p className="text-display font-mono text-content-primary mt-1">
            {gpuStats.vram_used_gb}/{gpuStats.vram_total_gb} GB
          </p>
          <ProgressBar
            value={(gpuStats.vram_used_gb / gpuStats.vram_total_gb) * 100}
            size="sm"
            className="mt-1"
          />
        </div>
        <div>
          <span className="text-caption text-content-tertiary flex items-center gap-1">
            <Thermometer size={10} /> Temp
          </span>
          <p className="text-display font-mono text-content-primary mt-1">{gpuStats.temperature_c}&deg;C</p>
        </div>
      </div>
    </Card>
  )
}

// ── Provider Card ─────────────────────────────────────────────────────────────

function ProviderCard({ provider }: { provider: ProviderModelList }) {
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
                    <span className="truncate">{m.id}</span>
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

// ── Pulled model row ──────────────────────────────────────────────────────────

function isRequiredModel(name: string, required: Set<string>): boolean {
  if (required.has(name)) return true
  const base = name.split(':')[0]
  return required.has(base)
}

/** Max-size filter chips for the recommended grid. */
const SIZE_FILTERS = [
  { label: 'All', value: 0 },
  { label: '<= 5 GB', value: 5 },
  { label: '<= 10 GB', value: 10 },
  { label: '<= 24 GB', value: 24 },
  { label: '<= 48 GB', value: 48 },
  { label: '<= 64 GB', value: 64 },
  { label: '<= 96 GB', value: 96 },
]

// Ollama treats `name` and `name:latest` as identical. Strip the implicit tag
// so a catalog entry of `nomic-embed-text` matches an installed `nomic-embed-text:latest`.
function normalizeOllamaName(name: string): string {
  return name.endsWith(':latest') ? name.slice(0, -7) : name
}

// ── Routing Stats section ─────────────────────────────────────────────────────

function RoutingStatsSection() {
  const [open, setOpen] = useState(false)
  const { data: stats, isLoading } = useQuery({
    queryKey: ['routing-stats'],
    queryFn: () => getRoutingStats(),
    staleTime: 30_000,
  })

  if (isLoading) return <Skeleton variant="rect" height="120px" />
  if (!stats || stats.by_model.length === 0) return null

  return (
    <Card className="overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-surface-card-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-accent" />
          <span className="text-compact font-semibold text-content-primary">Routing Stats (7d)</span>
          <Tooltip content="Percentage of requests where the primary model failed and a fallback was used.">
            <Badge color={stats.fallback_rate_pct > 20 ? 'warning' : 'success'} size="sm">
              {stats.fallback_rate_pct.toFixed(1)}% fallback
            </Badge>
          </Tooltip>
        </div>
        {open ? <ChevronDown size={14} className="text-content-tertiary" /> : <ChevronRight size={14} className="text-content-tertiary" />}
      </button>
      {open && (
        <div className="px-4 pb-4 overflow-x-auto border-t border-border-subtle pt-3">
          <table className="w-full text-caption">
            <thead>
              <tr className="text-content-tertiary">
                <th className="text-left py-1.5 pr-3 font-medium">Model</th>
                <th className="text-right py-1.5 px-3 font-medium">Requests</th>
                <th className="text-right py-1.5 px-3 font-medium">Avg Tokens</th>
                <th className="text-right py-1.5 px-3 font-medium">Avg Latency</th>
                <th className="text-right py-1.5 pl-3 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {stats.by_model.map(m => (
                <tr key={m.model}>
                  <td className="py-1.5 pr-3 font-mono text-content-primary">{m.model}</td>
                  <td className="py-1.5 px-3 text-right text-content-secondary">{m.requests.toLocaleString()}</td>
                  <td className="py-1.5 px-3 text-right text-content-secondary">{m.avg_tokens.toLocaleString()}</td>
                  <td className="py-1.5 px-3 text-right text-content-secondary">{(m.avg_latency_ms / 1000).toFixed(1)}s</td>
                  <td className="py-1.5 pl-3 text-right font-mono text-content-secondary">${m.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── Help entries ─────────────────────────────────────────────────────────────

const HELP_ENTRIES = [
  { term: 'Ollama', definition: "A local inference engine that runs AI models on your machine's CPU or GPU — free but slower than cloud." },
  { term: 'Routing Strategy', definition: 'How Nova decides where to send requests — local-first tries your machine first, cloud-first prefers API providers, etc.' },
  { term: 'Provider', definition: 'An AI service Nova can call — Anthropic (Claude), OpenAI (GPT), Groq, Gemini, etc. Each needs an API key.' },
  { term: 'Pulled Models', definition: 'AI models downloaded and cached locally in Ollama, ready for immediate inference.' },
  { term: 'LM Studio', definition: 'A desktop app that runs local models via an OpenAI-compatible server. Nova discovers loaded models and (on LM Studio 0.4.0+) can load/unload models from your downloaded library.' },
]

// ── LM Studio Library Section ─────────────────────────────────────────────────

function LMStudioStatusBadge({ status }: { status: LMStudioStatus | undefined }) {
  const healthy = status?.healthy ?? false
  return (
    <Badge color={healthy ? 'success' : 'danger'} size="sm">
      <StatusDot status={healthy ? 'success' : 'danger'} pulse={healthy} />
      {healthy ? 'Connected' : 'Not reachable'}
    </Badge>
  )
}

function LMStudioLibrarySection({ isActive = false }: { isActive?: boolean }) {
  const qc = useQueryClient()
  const [loadingModels, setLoadingModels] = useState<Set<string>>(new Set())
  const [unloadingModels, setUnloadingModels] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const status = useQuery({
    queryKey: ['lmstudio-status'],
    queryFn: getLMStudioStatus,
    refetchInterval: 10_000,
  })

  const downloaded = useQuery({
    queryKey: ['lmstudio-downloaded'],
    queryFn: () => getLMStudioDownloaded().catch(() => [] as LMStudioDownloadedModel[]),
    refetchInterval: 15_000,
    enabled: status.data?.healthy ?? false,
  })

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['lmstudio-downloaded'] })
    qc.invalidateQueries({ queryKey: ['lmstudio-status'] })
    qc.invalidateQueries({ queryKey: ['model-catalog'] })
    qc.fetchQuery({ queryKey: ['model-catalog'], queryFn: () => discoverModels(true) })
  }

  const loadModel = useMutation({
    mutationFn: (key: string) => loadLMStudioModel(key),
    onMutate: (key) => {
      setError(null)
      setLoadingModels(prev => new Set(prev).add(key))
    },
    onSuccess: () => invalidateAll(),
    onError: (e: Error) => setError(e.message || 'Failed to load model'),
    onSettled: () => setLoadingModels(prev => { const n = new Set(prev); n.clear(); return n }),
  })

  const unloadModel = useMutation({
    mutationFn: (instanceId: string) => unloadLMStudioModel(instanceId),
    onMutate: (instanceId) => {
      setError(null)
      setUnloadingModels(prev => new Set(prev).add(instanceId))
    },
    onSuccess: () => invalidateAll(),
    onError: (e: Error) => setError(e.message || 'Failed to unload model'),
    onSettled: () => setUnloadingModels(prev => { const n = new Set(prev); n.clear(); return n }),
  })

  const healthy = status.data?.healthy ?? false
  const models = downloaded.data ?? []
  const loadedCount = models.filter(m => m.loaded).length

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <HardDrive className="h-5 w-5 text-accent" />
        <h2 className="text-compact font-semibold text-content-primary">LM Studio</h2>
        <Badge color={isActive ? 'success' : 'neutral'} size="sm">
          {isActive ? 'Active — serving Nova' : 'Available'}
        </Badge>
        <LMStudioStatusBadge status={status.data} />
        {models.length > 0 && (
          <span className="font-mono text-caption text-content-tertiary">
            on disk {models.length} · in memory {loadedCount}
          </span>
        )}
      </div>
      {healthy && (
        <p className="text-caption text-content-tertiary flex items-center gap-1.5">
          <Info className="h-3 w-3 shrink-0" />
          Add models: download them in the LM Studio app — they appear here once downloaded.
          (LM Studio has no download API, so Nova loads/unloads them but can't pull them for you.)
        </p>
      )}

      {!healthy && (
        <EmptyState
          icon={Server}
          title="LM Studio is not reachable"
          description="Start LM Studio, open the Developer tab, and click Start Server (default port 1234). Then set inference.lmstudio_url in Settings if it isn't on your host."
          action={{ label: 'Configure in Settings', onClick: () => window.location.hash = '#/settings#local-inference' }}
        />
      )}

      {error && (
        <div className="flex items-center gap-2 text-compact text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {healthy && downloaded.isLoading && (
        <Card><div className="p-4"><Skeleton lines={3} /></div></Card>
      )}

      {healthy && !downloaded.isLoading && models.length === 0 && (
        <Card>
          <div className="px-4 py-6 text-compact text-content-tertiary text-center">
            No models downloaded in LM Studio yet. Download models in the LM Studio app to see them here.
          </div>
        </Card>
      )}

      {models.length > 0 && (() => {
        const rows: LocalModelRow[] = models.map(m => ({
          id: m.key,
          name: m.display_name,
          sizeBytes: m.size_bytes,
          params: m.params_string,
          quant: m.quantization,
          context: m.max_context_length ? `${Math.round(m.max_context_length / 1024)}K` : null,
          caps: [
            ...(m.type === 'embedding' ? ['embed'] : []),
            ...(m.supports_vision ? ['vision'] : []),
            ...(m.supports_tools ? ['tools'] : []),
          ],
          loaded: m.loaded,
        }))
        const instanceOf = new Map(models.map(m => [m.key, m.loaded_instances[0] ?? m.key]))
        return (
          <Card>
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-compact font-medium text-content-primary">Models</h3>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw className={`h-3.5 w-3.5 ${downloaded.isFetching ? 'animate-spin' : ''}`} />}
                onClick={() => qc.invalidateQueries({ queryKey: ['lmstudio-downloaded'] })}
              >
                Refresh
              </Button>
            </div>
            <LocalModelsTable
              rows={rows}
              busyIds={new Set([
                ...[...loadingModels],
                ...models.filter(m => unloadingModels.has(m.loaded_instances[0] ?? m.key)).map(m => m.key),
              ])}
              onLoad={(id) => loadModel.mutate(id)}
              onUnload={(id) => unloadModel.mutate(instanceOf.get(id) ?? id)}
              emptyText="No models downloaded in LM Studio yet."
            />
          </Card>
        )
      })()}
    </section>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function Models() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [pullInput, setPullInput] = useState('')
  const [pullingModels, setPullingModels] = useState<Set<string>>(new Set())
  const [deletingModels, setDeletingModels] = useState<Set<string>>(new Set())
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [sizeFilter, setSizeFilter] = useState<number>(0)
  // Installed models expanded by default (the whole point of the page);
  // collapsible so a big multi-backend machine can tuck a list away.
  const [installedOpen, setInstalledOpen] = useState(() => localStorage.getItem('models.installedOpen') !== '0')
  // Recommendation source: live ollama.com popularity (default) or the curated file
  const [recSource, setRecSource] = useState<'popular' | 'curated'>(
    () => (localStorage.getItem('models.recSource') as 'popular' | 'curated') ?? 'popular'
  )
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true'
  )

  // Queries
  const catalog = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
  })

  // Curated pull recommendations — data/recommended_models.json via recovery.
  const ollamaCatalog = useQuery({
    queryKey: ['recommended-models', 'ollama'],
    queryFn: () => getRecommendedModels('ollama'),
    staleTime: 300_000,
  })
  const recModels = ollamaCatalog.data ?? []
  const requiredModels = new Set(
    recModels.filter(m => m.required).map(m => m.ollama_id ?? m.id)
  )

  const popularCatalog = useQuery({
    queryKey: ['recommended-models', 'ollama', 'popular'],
    queryFn: () => getRecommendedModels('ollama', undefined, 'popular'),
    staleTime: 300_000,
    enabled: recSource === 'popular',
  })
  const gridModels = recSource === 'popular' ? (popularCatalog.data ?? []) : recModels
  const gridQuery = recSource === 'popular' ? popularCatalog : ollamaCatalog

  const hardware = useQuery({
    queryKey: ['hardware-info'],
    queryFn: getHardwareInfo,
    staleTime: 300_000,
    retry: 0,
  })
  const detectedVram = Math.max(0, ...(hardware.data?.gpus?.map(g => g.vram_gb) ?? [0]))

  // What this machine can actually run: VRAM if there's a GPU, else system
  // RAM (CPU inference). 0 = hardware unknown → can't judge fit, show all.
  const machineCapacityGB = detectedVram > 0
    ? detectedVram
    : Math.floor(hardware.data?.ram_gb ?? 0)
  const capacityLabel = detectedVram > 0
    ? `${detectedVram} GB GPU`
    : machineCapacityGB > 0 ? `${machineCapacityGB} GB RAM` : ''

  // Recommendations default to models that fit this machine (+ all cloud).
  // "Show all sizes" lifts the cap for the curious.
  const [showAllSizes, setShowAllSizes] = useState(false)

  const pulled = useQuery({
    queryKey: ['ollama-pulled'],
    queryFn: () => getOllamaPulled().catch(() => [] as OllamaPulledModel[]),
    staleTime: 30_000,
  })

  const ollamaStatus = useQuery({
    queryKey: ['ollama-status'],
    queryFn: getOllamaStatus,
    staleTime: 15_000,
  })

  // Parent-level LM Studio reachability so its section can show alongside
  // Ollama's (both are separate model stores; either can be reachable).
  const lmstudioStatus = useQuery({
    queryKey: ['lmstudio-status'],
    queryFn: getLMStudioStatus,
    staleTime: 15_000,
    retry: 0,
  })

  const providers = useQuery({
    queryKey: ['provider-status'],
    queryFn: getProviderStatus,
    staleTime: 30_000,
  })

  const backendStatus = useQuery({
    queryKey: ['inference-backend-status'],
    queryFn: getBackendStatus,
    staleTime: 5_000,
  })

  const recommended = useQuery({
    queryKey: ['recommended-models', backendStatus.data?.backend],
    queryFn: () => getRecommendedModels(backendStatus.data?.backend ?? undefined),
    enabled: !!backendStatus.data?.backend,
    staleTime: 60_000,
  })

  const gpuStats = useQuery({
    queryKey: ['gpu-stats'],
    queryFn: getGPUStats,
    refetchInterval: 10_000,
    enabled: (backendStatus.data?.backend ?? 'ollama') !== 'none',
  })

  const activeBackend = backendStatus.data?.backend ?? 'ollama'
  const backendState = backendStatus.data?.state ?? 'stopped'
  const isSwitching = backendState === 'switching'

  // Mutations
  const pullMutation = useMutation({
    mutationFn: pullOllamaModel,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ollama-pulled'] })
      qc.invalidateQueries({ queryKey: ['model-catalog'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteOllamaModel,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ollama-pulled'] })
      qc.invalidateQueries({ queryKey: ['model-catalog'] })
    },
  })

  // Load/unload = warm into / evict from memory (Ollama /api/ps state).
  const [ollamaBusy, setOllamaBusy] = useState<Set<string>>(new Set())
  const ollamaLoadUnload = async (name: string, load: boolean) => {
    setOllamaBusy(s => new Set(s).add(name))
    try {
      await (load ? loadOllamaModel(name) : unloadOllamaModel(name))
      qc.invalidateQueries({ queryKey: ['ollama-pulled'] })
      qc.invalidateQueries({ queryKey: ['inference-loaded'] })
    } catch { /* surfaced by the row's disabled state resetting */ }
    finally {
      setOllamaBusy(s => { const n = new Set(s); n.delete(name); return n })
    }
  }

  const startOllama = useMutation({
    mutationFn: () =>
      recoveryFetch('/api/v1/recovery/inference/backend/ollama/start', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ollama-pulled'] })
      qc.invalidateQueries({ queryKey: ['ollama-status'] })
      qc.invalidateQueries({ queryKey: ['model-catalog'] })
      qc.invalidateQueries({ queryKey: ['inference-backend-status'] })
    },
  })

  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ModelSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const switchModelMutation = useMutation({
    mutationFn: ({ backend, model }: { backend: string; model: string }) =>
      switchModel(backend, model),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inference-backend-status'] })
      qc.invalidateQueries({ queryKey: ['model-catalog'] })
    },
  })

  const handleModelSearch = async () => {
    if (!modelSearchQuery.trim()) return
    setSearching(true)
    try {
      const results = await searchModels(modelSearchQuery, activeBackend)
      setSearchResults(results)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const handleSwitchModel = (model: string) => {
    if (!confirm(`Switch to ${model}? This restarts ${activeBackend} (~30-120s). Cloud providers remain available.`)) return
    switchModelMutation.mutate({ backend: activeBackend, model })
  }

  // Poll faster during model switch
  useEffect(() => {
    if (!isSwitching) return
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['inference-backend-status'] })
    }, 2000)
    return () => clearInterval(interval)
  }, [isSwitching, qc])

  // Handlers
  const handlePull = async (name: string) => {
    if (!name.trim()) return
    setPullingModels(s => new Set(s).add(name))
    try {
      await pullMutation.mutateAsync(name)
    } finally {
      setPullingModels(s => { const n = new Set(s); n.delete(name); return n })
    }
    setPullInput('')
  }

  const handleDelete = async (name: string) => {
    setDeletingModels(s => new Set(s).add(name))
    try {
      await deleteMutation.mutateAsync(name)
    } finally {
      setDeletingModels(s => { const n = new Set(s); n.delete(name); return n })
    }
  }

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['model-catalog'] })
    qc.invalidateQueries({ queryKey: ['ollama-pulled'] })
    qc.invalidateQueries({ queryKey: ['ollama-status'] })
    qc.invalidateQueries({ queryKey: ['provider-status'] })
    qc.fetchQuery({ queryKey: ['model-catalog'], queryFn: () => discoverModels(true) })
  }

  const dismissOnboarding = () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true')
    setOnboardingDismissed(true)
  }

  // Derived state
  const pulledNames = new Set((pulled.data ?? []).map(m => normalizeOllamaName(m.name)))
  const totalAvailable = (catalog.data ?? []).reduce((n, p) => n + (p.available ? p.models.length : 0), 0)
  const ollamaHealthy = ollamaStatus.data?.healthy ?? false
  const gpuAvailable = ollamaStatus.data?.gpu_available ?? false
  const hasCloudProvider = (providers.data ?? []).some(p => p.slug !== 'ollama' && p.available)
  const isStarterModel = (ollamaStatus.data?.routing_strategy ?? '').includes('local') && pulledNames.size <= 2
  const showOnboarding = !onboardingDismissed && !gpuAvailable && !hasCloudProvider && isStarterModel

  // Cloud providers from catalog
  const cloudProviders = (catalog.data ?? []).filter(p => p.slug !== 'ollama')
  const sortedCloud = CLOUD_PROVIDER_ORDER
    .map(slug => cloudProviders.find(p => p.slug === slug))
    .filter((p): p is ProviderModelList => !!p)
  const remainingCloud = cloudProviders.filter(p => !CLOUD_PROVIDER_ORDER.includes(p.slug))
  const allCloud = [...sortedCloud, ...remainingCloud]

  return (
    <div className="space-y-8">
      {/* Header */}
      <PageHeader
        title="Models"
        description={`Available LLM providers, routing stats, and model configuration.${totalAvailable > 0 ? ` ${totalAvailable} models available.` : ''}`}
        helpEntries={HELP_ENTRIES}
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className={`h-3.5 w-3.5 ${catalog.isFetching ? 'animate-spin' : ''}`} />}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        }
      />

      {/* Onboarding Banner — amber-dim for CPU-only warning */}
      {showOnboarding && <OnboardingBanner onDismiss={dismissOnboarding} />}

      {/* Active model hero — the one-second answer */}
      {activeBackend !== 'none' && (
        <Card className={clsx(
          'p-5 relative overflow-hidden',
          (backendState === 'ready' || backendState === 'running') && 'border-accent/30 shadow-[0_0_20px_rgba(25,168,158,0.15)]',
        )}>
          <div className="flex items-center gap-4">
            <div className={clsx(
              'flex items-center justify-center w-10 h-10 rounded-lg',
              (backendState === 'ready' || backendState === 'running')
                ? 'bg-accent/15 text-accent'
                : backendState === 'switching' || backendState === 'starting'
                  ? 'bg-warning-dim text-warning'
                  : 'bg-surface-elevated text-content-tertiary',
            )}>
              {activeBackend === 'ollama' ? <HardDrive size={20} /> : <Server size={20} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-caption text-content-tertiary">Active Backend</p>
                <Badge
                  color={backendState === 'ready' || backendState === 'running' ? 'success' : backendState === 'switching' || backendState === 'starting' ? 'warning' : 'danger'}
                  dot size="sm"
                >
                  {backendState}
                </Badge>
              </div>
              <p className="text-xl font-bold tracking-tight text-content-primary">
                {activeBackend === 'ollama' ? 'Ollama' : activeBackend.toUpperCase()}
                {backendStatus.data?.external && (
                  <span className="ml-2 text-caption font-normal text-content-tertiary">external server</span>
                )}
                {backendStatus.data?.active_model && (
                  <span className="ml-2 text-base font-mono font-normal text-content-secondary">
                    {backendStatus.data.active_model}
                  </span>
                )}
              </p>
              <div className="flex items-center gap-3 mt-1 text-caption text-content-tertiary">
                {gpuStats.data && (
                  <span className="flex items-center gap-1">
                    <Cpu size={10} className="text-accent" />
                    GPU {gpuStats.data.gpu_utilization_pct}%
                    <span className="text-content-tertiary">|</span>
                    VRAM {gpuStats.data.vram_used_gb}/{gpuStats.data.vram_total_gb} GB
                  </span>
                )}
                {ollamaStatus.data && activeBackend === 'ollama' && (
                  <span>{ollamaStatus.data.gpu_available ? 'GPU accelerated' : 'CPU only'}</span>
                )}
                {hasCloudProvider && <span>Cloud fallback available</span>}
              </div>
            </div>
          </div>
          {(backendState === 'ready' || backendState === 'running') && (
            <div className="absolute inset-0 rounded-[inherit] animate-[glow-pulse_3s_ease-in-out_infinite] pointer-events-none border border-accent/20" />
          )}
        </Card>
      )}

      {/* ── Local Inference: one section per backend that's active or reachable ──
          Each local backend is a separate model store. Showing them side by
          side (each labeled Active/Available) is why switching Ollama↔LM Studio
          no longer looks like "the same models" — you see both, clearly named. */}
      {(ollamaHealthy || lmstudioStatus.data?.healthy || activeBackend !== 'none') && (
        <div className="flex items-center gap-2 pt-2">
          <Cpu className="h-4 w-4 text-content-tertiary" />
          <h2 className="text-caption font-semibold uppercase tracking-wider text-content-tertiary">
            Local Inference
          </h2>
        </div>
      )}

      {/* Ollama — reachable model store, active or not */}
      {(activeBackend === 'ollama' || ollamaHealthy) && (() => {
        const rows: LocalModelRow[] = (pulled.data ?? []).map(m => ({
          id: m.name,
          name: m.name,
          sizeBytes: m.size,
          params: m.parameter_size || null,
          quant: m.quantization_level || null,
          loaded: m.loaded,
          required: isRequiredModel(m.name, requiredModels),
        }))
        const { onDisk, inMemory } = localCounts(rows)
        const totalBytes = rows.reduce((n, r) => n + r.sizeBytes, 0)
        return (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <HardDrive className="h-5 w-5 text-accent" />
            <h2 className="text-compact font-semibold text-content-primary">Ollama</h2>
            <Badge color={activeBackend === 'ollama' ? 'success' : 'neutral'} size="sm">
              {activeBackend === 'ollama' ? 'Active — serving Nova' : 'Available'}
            </Badge>
            <OllamaStatusBadge status={ollamaStatus.data} />
          </div>

          {/* GPU Stats */}
          {gpuStats.data && <GPUStatsCard />}

          {/* Models on disk / in memory */}
          <Card>
            <button
              className={`w-full px-4 py-3 flex items-center justify-between text-left ${(installedOpen || !ollamaHealthy) ? 'border-b border-border-subtle' : ''}`}
              onClick={() => {
                const v = !installedOpen
                setInstalledOpen(v)
                localStorage.setItem('models.installedOpen', v ? '1' : '0')
              }}
              aria-expanded={installedOpen}
            >
              <span className="flex items-center gap-2">
                {installedOpen
                  ? <ChevronDown className="h-4 w-4 text-content-tertiary" />
                  : <ChevronRight className="h-4 w-4 text-content-tertiary" />}
                <h3 className="text-compact font-medium text-content-primary">Models</h3>
              </span>
              <span className="flex items-center gap-2 font-mono text-caption text-content-tertiary">
                {pulled.data && <span>on disk {onDisk} · in memory {inMemory}</span>}
                {totalBytes > 0 && <Badge color="neutral" size="sm" className="font-mono">{formatBytes(totalBytes)}</Badge>}
              </span>
            </button>
            {/* down-warning outside the collapse so it can't hide or pin-open */}
            {!ollamaHealthy && !pulled.isLoading && (
              <div className="px-4 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-compact text-warning">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Ollama is not running.
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Play className="h-3.5 w-3.5" />}
                  onClick={() => startOllama.mutate()}
                  loading={startOllama.isPending}
                >
                  Start Ollama
                </Button>
              </div>
            )}
            {installedOpen && (
              pulled.isLoading
                ? <div className="p-4"><Skeleton lines={3} /></div>
                : <LocalModelsTable
                    rows={rows}
                    busyIds={new Set([...ollamaBusy, ...deletingModels])}
                    onLoad={ollamaHealthy ? (id) => ollamaLoadUnload(id, true) : undefined}
                    onUnload={ollamaHealthy ? (id) => ollamaLoadUnload(id, false) : undefined}
                    onDelete={ollamaHealthy ? (id) => handleDelete(id) : undefined}
                    emptyText="No models pulled yet. Add one below to get started."
                  />
            )}
          </Card>

          {/* Add models — Ollama pulls from its registry */}
          <Card className="p-4 space-y-4">
            <div>
              <h3 className="text-compact font-medium text-content-primary">Add models</h3>
              <p className="text-caption text-content-tertiary mt-0.5">
                Pull from the Ollama registry by name, or pick a recommendation below.
                Pulled models load into memory automatically on first use.
              </p>
            </div>

            <div className="flex gap-2">
              <div className="flex-1">
                <SearchInput
                  value={pullInput}
                  onChange={setPullInput}
                  placeholder="Model name (e.g. llama3.1:8b)"
                  debounceMs={0}
                />
              </div>
              <Button
                icon={pullingModels.has(pullInput) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                onClick={() => handlePull(pullInput)}
                disabled={!pullInput.trim() || pullingModels.has(pullInput)}
              >
                Pull
              </Button>
            </div>

            {/* Recommended models grid */}
            <div>
              <div className="space-y-2 mb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-caption text-content-tertiary">Recommended models</p>
                    <div className="flex gap-1">
                      {(['popular', 'curated'] as const).map(src => (
                        <button key={src} onClick={() => { setRecSource(src); localStorage.setItem('models.recSource', src) }}>
                          <Badge color={recSource === src ? 'info' : 'neutral'} size="sm" className="cursor-pointer">
                            {src === 'popular' ? 'Popular on Ollama' : 'Curated'}
                          </Badge>
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1 flex-wrap">
                      {['all', 'general', 'reasoning', 'code', 'vision', 'embedding'].map(cat => (
                        <button key={cat} onClick={() => setCategoryFilter(cat)}>
                          <Badge
                            color={categoryFilter === cat ? 'accent' : 'neutral'}
                            size="sm"
                            className="cursor-pointer"
                          >
                            {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
                          </Badge>
                        </button>
                      ))}
                    </div>
                  </div>
                  <a
                    href="https://ollama.com/library"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-caption text-accent hover:underline shrink-0"
                  >
                    Browse all <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                {/* Size filter — default hides models that won't fit this
                    machine (cloud always shown); further-narrow chips below. */}
                <div className="flex items-center gap-2 flex-wrap">
                  <HardDrive className="h-3 w-3 text-content-tertiary" />
                  {machineCapacityGB > 0 && !showAllSizes ? (
                    <span className="text-micro text-content-tertiary">
                      Fits your <span className="font-mono text-content-secondary">{capacityLabel}</span>, plus cloud
                    </span>
                  ) : (
                    <span className="text-micro text-content-tertiary">Max size:</span>
                  )}
                  <div className="flex gap-1">
                    {SIZE_FILTERS
                      .filter(opt => showAllSizes || machineCapacityGB === 0 || opt.value === 0 || opt.value < machineCapacityGB)
                      .map(opt => (
                      <button key={opt.value} onClick={() => setSizeFilter(opt.value)}>
                        <Badge
                          color={sizeFilter === opt.value ? 'warning' : 'neutral'}
                          size="sm"
                          className="cursor-pointer font-mono"
                        >
                          {opt.value === 0 && machineCapacityGB > 0 && !showAllSizes ? 'Any that fit' : opt.label}
                        </Badge>
                      </button>
                    ))}
                  </div>
                  {machineCapacityGB > 0 && (
                    <button
                      onClick={() => setShowAllSizes(v => !v)}
                      className="text-micro text-accent hover:underline font-mono ml-1"
                    >
                      {showAllSizes ? 'fit to machine' : 'show all sizes'}
                    </button>
                  )}
                </div>
              </div>
              {gridQuery.isLoading && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} variant="rect" height="92px" />)}
                </div>
              )}
              {gridQuery.isError && (
                <p className="text-caption text-content-tertiary py-4 text-center">
                  Couldn't load the model catalog from the recovery service — pull by name above, or browse ollama.com/library.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {gridModels
                  .filter(rec => categoryFilter === 'all' || rec.category === categoryFilter)
                  .filter(rec => {
                    if (rec.cloud) return true          // cloud LLMs always shown
                    const size = rec.size_gb ?? 0
                    // hard cap at what the machine can run, unless "show all"
                    const cap = showAllSizes || machineCapacityGB === 0 ? Infinity : machineCapacityGB
                    const userMax = sizeFilter > 0 ? sizeFilter : Infinity
                    return size <= Math.min(cap, userMax)
                  })
                  .map(rec => {
                    const pullName = rec.ollama_id ?? rec.id
                    const sizeGB = rec.size_gb ?? 0
                    const isPulled = pulledNames.has(normalizeOllamaName(pullName))
                    const isPulling = pullingModels.has(pullName)
                    const isDeleting = deletingModels.has(pullName)
                    // Deep link to the source registry: explicit url (popular),
                    // else HF for slash-ids, else the Ollama library page.
                    const modelUrl = rec.url
                      ?? (rec.id.includes('/')
                        ? `https://huggingface.co/${rec.id}`
                        : `https://ollama.com/library/${pullName.split(':')[0]}`)
                    return (
                      <div
                        key={pullName}
                        className={`relative flex min-h-[150px] flex-col rounded-lg border px-3 py-2.5 text-caption transition-colors ${
                          isPulled
                            ? 'border-accent bg-accent-dim/30'
                            : isPulling
                              ? 'border-warning-dim bg-warning-dim/30'
                              : 'border-border-subtle hover:border-border'
                        }`}
                      >
                        {/* line 1: name + registry link + status glyph */}
                        <div className="flex items-center gap-1.5">
                          {rec.cloud && <Cloud className="h-3.5 w-3.5 text-info shrink-0" />}
                          <span className="font-mono font-medium text-content-primary truncate">
                            {pullName}
                          </span>
                          <a
                            href={modelUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            title="View on registry"
                            className="shrink-0 text-content-tertiary hover:text-accent"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          {rec.starter && <Badge color="accent" size="sm">starter</Badge>}
                          {rec.required && <Badge color="warning" size="sm">required</Badge>}
                          <span className="ml-auto shrink-0">
                            {isPulled && <Check className="h-3.5 w-3.5 text-success" />}
                            {isPulling && <Loader2 className="h-3.5 w-3.5 text-warning animate-spin" />}
                          </span>
                        </div>

                        {/* line 2: size (prominent) + params + capability, pulls muted */}
                        <div className="mt-1 flex items-center gap-2">
                          {rec.cloud ? (
                            <span className="font-mono text-content-secondary">Cloud</span>
                          ) : rec.size_gb != null ? (
                            <span className={`font-mono font-medium ${
                              sizeGB <= 2 ? 'text-success' : sizeGB <= 5 ? 'text-accent' : sizeGB <= 10 ? 'text-warning' : 'text-danger'
                            }`}>
                              {sizeGB < 1 ? `${Math.round(sizeGB * 1000)} MB` : `${sizeGB} GB`}
                            </span>
                          ) : null}
                          <span className="text-content-tertiary">{rec.category}</span>
                          {!rec.cloud && rec.min_vram_gb === 0 && (
                            <span className="text-success font-mono">CPU OK</span>
                          )}
                          {!rec.cloud && (rec.min_vram_gb ?? 0) > 0 && detectedVram > 0 && (rec.min_vram_gb ?? 0) > detectedVram && (
                            <Tooltip content={`Needs ~${rec.min_vram_gb} GB VRAM; ${detectedVram} GB detected`}>
                              <span className="text-danger font-mono">&gt; your GPU</span>
                            </Tooltip>
                          )}
                          {rec.pulls && (
                            <span className="ml-auto text-micro text-content-tertiary font-mono">{rec.pulls} pulls</span>
                          )}
                        </div>

                        {/* line 3: parameter variants (popular source) */}
                        {rec.param_sizes && rec.param_sizes.length > 0 && (
                          <div className="mt-1 flex items-center gap-1 text-micro text-content-tertiary font-mono">
                            <span className="text-content-tertiary/70">params</span>
                            <span className="truncate">{rec.param_sizes.join(' · ')}</span>
                          </div>
                        )}

                        {/* description — clamped so every card is the same height */}
                        <p className="mt-1.5 text-content-tertiary leading-tight line-clamp-2">{rec.description}</p>

                        {/* action pinned to the bottom */}
                        <div className="mt-auto pt-2 flex justify-end">
                          {isPulled ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                              onClick={() => handleDelete(pullName)}
                              disabled={isDeleting || rec.required}
                              title={rec.required ? 'Required by Nova' : rec.cloud ? 'Remove cloud model registration' : 'Delete model'}
                              className="text-danger"
                            >
                              {rec.cloud ? 'Remove' : 'Delete'}
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={
                                isPulling
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : rec.cloud
                                    ? <Cloud className="h-3 w-3" />
                                    : <Download className="h-3 w-3" />
                              }
                              onClick={() => handlePull(pullName)}
                              disabled={isPulling}
                              title={rec.cloud ? 'Enable cloud model (no download)' : 'Download model'}
                              className="text-accent"
                            >
                              {rec.cloud ? 'Enable' : 'Pull'}
                            </Button>
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          </Card>
        </section>
        )
      })()}

      {/* vLLM / SGLang — bundled single-model backend (shown only when active) */}
      {(activeBackend === 'vllm' || activeBackend === 'sglang') && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <HardDrive className="h-5 w-5 text-accent" />
            <h2 className="text-compact font-semibold text-content-primary">{activeBackend.toUpperCase()}</h2>
            <Badge color="success" size="sm">Active — serving Nova</Badge>
            <Badge
              color={backendState === 'ready' || backendState === 'running' ? 'success' : backendState === 'switching' || backendState === 'starting' ? 'warning' : 'danger'}
              dot
              size="sm"
            >
              {activeBackend.toUpperCase()} -- {backendState}
            </Badge>
          </div>

          {/* GPU Stats */}
          {gpuStats.data && <GPUStatsCard />}

          {/* Active model status */}
          <Card>
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <div>
                <h3 className="text-compact font-medium text-content-primary">Active Model</h3>
                {backendStatus.data?.active_model && (
                  <p className="text-mono-sm text-content-secondary mt-0.5">{backendStatus.data.active_model}</p>
                )}
              </div>
              <Badge
                color={backendStatus.data?.container_status?.health === 'healthy' ? 'success' : 'warning'}
                size="sm"
              >
                {backendStatus.data?.container_status?.status ?? 'unknown'}
              </Badge>
            </div>
            {isSwitching && backendStatus.data?.switch_progress && (
              <div className="px-4 py-3 bg-warning-dim border-b border-border-subtle">
                <div className="flex items-center gap-2 text-compact text-warning">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  <span className="font-medium">{backendStatus.data.switch_progress.step}</span>
                </div>
                <p className="mt-1 text-caption text-content-secondary ml-6">
                  {backendStatus.data.switch_progress.detail}
                </p>
              </div>
            )}
            {switchModelMutation.isError && (
              <div className="px-4 py-3 bg-danger-dim border-b border-border-subtle">
                <div className="flex items-center gap-2 text-compact text-danger">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>Switch failed: {(switchModelMutation.error as Error)?.message ?? 'Unknown error'}</span>
                </div>
              </div>
            )}
          </Card>

          {/* Search HuggingFace models */}
          <Card className="p-4 space-y-4">
            <h3 className="text-compact font-medium text-content-primary">Search HuggingFace Models</h3>
            <div className="flex gap-2">
              <div className="flex-1">
                <SearchInput
                  value={modelSearchQuery}
                  onChange={setModelSearchQuery}
                  placeholder="Search models (e.g. llama 8b, mistral, qwen)"
                  debounceMs={0}
                />
              </div>
              <Button
                icon={searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                onClick={handleModelSearch}
                disabled={!modelSearchQuery.trim() || searching}
              >
                Search
              </Button>
            </div>

            {/* Search results */}
            {searchResults.length > 0 && (
              <div className="space-y-2">
                <p className="text-caption text-content-tertiary">{searchResults.length} result(s)</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {searchResults.map(result => (
                    <div
                      key={result.id}
                      className="rounded-lg border border-border-subtle px-3 py-2.5 text-caption"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-mono font-medium text-content-primary break-all">
                            {result.id}
                          </span>
                          {result.quantized && (
                            <Badge color="accent" size="sm" className="ml-1.5">quantized</Badge>
                          )}
                        </div>
                      </div>
                      {result.description && (
                        <p className="mt-1 text-content-tertiary leading-tight line-clamp-2">
                          {result.description}
                        </p>
                      )}
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-content-tertiary">
                          <span className="text-micro">{result.downloads.toLocaleString()} downloads</span>
                          {result.vram_estimate_gb != null && (
                            <span className="text-micro font-mono">~{result.vram_estimate_gb} GB VRAM</span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={switchModelMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                          onClick={() => handleSwitchModel(result.id)}
                          disabled={isSwitching || switchModelMutation.isPending}
                        >
                          Load
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Recommended models */}
          {recommended.data && recommended.data.length > 0 && (
            <Card className="p-4 space-y-3">
              <h3 className="text-compact font-medium text-content-primary">Recommended Models</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {recommended.data.map(rec => (
                  <div
                    key={rec.id}
                    className="rounded-lg border border-border-subtle px-3 py-2.5 text-caption"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-medium text-content-primary">
                        {rec.name}
                      </span>
                    </div>
                    <p className="mt-1 text-content-tertiary leading-tight">{rec.description}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Badge color="neutral" size="sm">{rec.category}</Badge>
                        <Badge color="warning" size="sm" className="font-mono">
                          {rec.min_vram_gb} GB+
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={switchModelMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        onClick={() => handleSwitchModel(rec.id)}
                        disabled={isSwitching || switchModelMutation.isPending}
                      >
                        Load
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </section>
      )}

      {/* LM Studio — reachable model store, active or not */}
      {(activeBackend === 'lmstudio' || lmstudioStatus.data?.healthy) && (
        <LMStudioLibrarySection isActive={activeBackend === 'lmstudio'} />
      )}

      {/* No local backend at all (and nothing reachable) */}
      {activeBackend === 'none' && !ollamaHealthy && !lmstudioStatus.data?.healthy && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <HardDrive className="h-5 w-5 text-content-tertiary" />
            <h2 className="text-compact font-semibold text-content-primary">Local Models</h2>
          </div>
          <EmptyState
            icon={Server}
            title="No local inference backend"
            description="No local inference backend is configured. Set one up in Settings to run models locally."
            action={{ label: 'Configure in Settings', onClick: () => navigate('/settings#local-inference') }}
          />
        </section>
      )}

      {/* Routing Stats */}
      <RoutingStatsSection />

      {/* Section B: Cloud Providers */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <Cloud className="h-5 w-5 text-info" />
          <h2 className="text-compact font-semibold text-content-primary">Cloud Providers</h2>
        </div>
        <p className="text-caption text-content-tertiary">Remote AI services accessed via API key — requests are billed per token by the provider.</p>

        {catalog.isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="p-4">
                <Skeleton lines={4} />
              </Card>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {allCloud.map(provider => (
            <ProviderCard key={provider.slug} provider={provider} />
          ))}
        </div>
      </section>
    </div>
  )
}
