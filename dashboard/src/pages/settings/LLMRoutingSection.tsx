import { useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Save, RotateCcw, Radio, Wifi, WifiOff, Power } from 'lucide-react'
import { getOllamaStatus, discoverModels, resolveModel, testProvider, type PlatformConfigEntry } from '../../api'
import { Section, Button, Input, Select, Toggle, StatusDot, Card, Slider, Badge } from '../../components/ui'
import { ConfigField, useConfigValue, EnvOverrideBadge, ConfigHistoryToggle } from './shared'

// ── LLM Routing section ──────────────────────────────────────────────────────

const ROUTING_STRATEGIES = [
  { value: 'local-first', label: 'Hybrid',     desc: 'Local AI by default; falls back to cloud providers when local is unavailable.' },
  { value: 'local-only',  label: 'Local Only', desc: 'Use the bundled (or external) local AI exclusively. Requests fail if local is offline.' },
  { value: 'cloud-only',  label: 'Cloud Only', desc: 'Skip local entirely. Bundled Ollama service is stopped; only cloud providers are used.' },
  { value: 'cloud-first', label: 'Cloud First (advanced)', desc: 'Prefer cloud; fall back to local if every cloud provider fails.' },
] as const

function CloudFallbackModelPicker({
  value,
  onSave,
  saving,
  override,
}: {
  value: string
  onSave: (key: string, value: string) => void
  saving: boolean
  override?: { var: string; value: string; ignored: boolean }
}) {
  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
  })
  const cloudModels = (providers ?? [])
    .filter(p => p.available && p.type !== 'local')
    .flatMap(p => p.models.filter(m => m.registered).map(m => m.id))

  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(value)
    setDirty(false)
  }, [value])

  const handleChange = (v: string) => {
    setDraft(v)
    setDirty(v !== value)
  }

  const handleSave = () => onSave('llm.cloud_fallback_model', JSON.stringify(draft))
  const handleReset = () => { setDraft(value); setDirty(false) }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <label className="text-caption font-medium text-content-secondary">Cloud Fallback Model</label>
          <EnvOverrideBadge override={override} />
          <ConfigHistoryToggle configKey="llm.cloud_fallback_model" />
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleReset} icon={<RotateCcw size={10} />}>Reset</Button>
            <Button size="sm" onClick={handleSave} loading={saving} icon={<Save size={10} />}>Save</Button>
          </div>
        )}
      </div>

      <select
        value={draft}
        onChange={e => handleChange(e.target.value)}
        className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors appearance-none"
      >
        {draft && !cloudModels.includes(draft) && (
          <option value={draft}>{draft}</option>
        )}
        {cloudModels.map(id => (
          <option key={id} value={id}>{id}</option>
        ))}
        {cloudModels.length === 0 && !draft && (
          <option value="">No cloud models available</option>
        )}
      </select>

      <p className="mt-1 text-caption text-content-tertiary">
        Cloud model used when Ollama is unavailable (local-first/cloud-first strategies).
      </p>
    </div>
  )
}

function DefaultModelPicker({
  onSave,
  saving,
  entries,
}: {
  onSave: (key: string, value: string) => void
  saving: boolean
  entries: PlatformConfigEntry[]
}) {
  const configured = useConfigValue(entries, 'llm.default_chat_model', 'auto')
  const [draft, setDraft] = useState(configured)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(configured)
    setDirty(false)
  }, [configured])

  const { data: resolved } = useQuery({
    queryKey: ['resolved-model'],
    queryFn: resolveModel,
    staleTime: 30_000,
  })

  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
  })
  const allModels = (providers ?? [])
    .filter(p => p.available)
    .flatMap(p => p.models.filter(m => m.registered).map(m => m.id))

  const handleChange = (v: string) => {
    setDraft(v)
    setDirty(v !== configured)
  }

  const handleSave = () => onSave('llm.default_chat_model', JSON.stringify(draft))
  const handleReset = () => { setDraft(configured); setDirty(false) }

  return (
    <div className="border-t border-border-subtle pt-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <label className="text-caption font-medium text-content-secondary">Default Chat Model</label>
          <EnvOverrideBadge override={entries.find(e => e.key === 'llm.default_chat_model')?.env_override} />
          <ConfigHistoryToggle configKey="llm.default_chat_model" />
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleReset} icon={<RotateCcw size={10} />}>Reset</Button>
            <Button size="sm" onClick={handleSave} loading={saving} icon={<Save size={10} />}>Save</Button>
          </div>
        )}
      </div>

      <select
        value={draft}
        onChange={e => handleChange(e.target.value)}
        className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors appearance-none"
      >
        <option value="auto">
          Auto (best available){resolved?.source === 'auto' ? ` \u2014 ${resolved.model}` : ''}
        </option>
        {allModels.map(id => (
          <option key={id} value={id}>{id}</option>
        ))}
        {draft !== 'auto' && !allModels.includes(draft) && (
          <option value={draft}>{draft}</option>
        )}
      </select>

      <p className="mt-1 text-caption text-content-tertiary">
        Model used for chat and pipeline when no override is set. &quot;Auto&quot; picks the best available cloud provider, or the largest local model if no cloud keys are configured.
      </p>
    </div>
  )
}

// ── Intelligent Routing sub-section ──────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  general: 'General \u2014 conversation, greetings, opinions',
  code: 'Code \u2014 writing, debugging, reviewing',
  reasoning: 'Reasoning \u2014 math, logic, multi-step analysis',
  creative: 'Creative \u2014 stories, copy, brainstorming',
  quick: 'Quick \u2014 lookups, yes/no, one-word answers',
}

function IntelligentRoutingSection({
  entries,
  onSave,
  saving,
}: {
  entries: PlatformConfigEntry[]
  onSave: (key: string, value: string) => void
  saving: boolean
}) {
  const enabled = useConfigValue(entries, 'llm.intelligent_routing', 'false') === 'true'
  const classifierModel = useConfigValue(entries, 'llm.classifier_model', 'auto')
  const timeoutMs = useConfigValue(entries, 'llm.classifier_timeout_ms', '500')
  const routingMapRaw = useConfigValue(entries, 'llm.model_routing_map', '{}')

  const [expanded, setExpanded] = useState(false)

  let routingMap: Record<string, string[] | null> = {}
  try {
    const parsed = typeof routingMapRaw === 'string' ? JSON.parse(routingMapRaw) : routingMapRaw
    if (typeof parsed === 'object' && parsed !== null) routingMap = parsed
  } catch { /* use empty */ }

  const [classifierDraft, setClassifierDraft] = useState(classifierModel)
  const [classifierDirty, setClassifierDirty] = useState(false)
  useEffect(() => { setClassifierDraft(classifierModel); setClassifierDirty(false) }, [classifierModel])

  const [timeoutDraft, setTimeoutDraft] = useState(Number(timeoutMs))
  const [timeoutDirty, setTimeoutDirty] = useState(false)
  useEffect(() => { setTimeoutDraft(Number(timeoutMs)); setTimeoutDirty(false) }, [timeoutMs])

  const [mapDraft, setMapDraft] = useState<Record<string, string>>({})
  const [mapDirty, setMapDirty] = useState(false)
  useEffect(() => {
    const draft: Record<string, string> = {}
    for (const [cat, models] of Object.entries(routingMap)) {
      draft[cat] = models ? models.join(', ') : ''
    }
    setMapDraft(draft)
    setMapDirty(false)
  }, [routingMapRaw])

  const handleToggle = () => {
    onSave('llm.intelligent_routing', JSON.stringify(!enabled))
  }

  const handleSaveClassifier = () => {
    onSave('llm.classifier_model', JSON.stringify(classifierDraft))
    setClassifierDirty(false)
  }

  const handleSaveTimeout = () => {
    onSave('llm.classifier_timeout_ms', JSON.stringify(String(timeoutDraft)))
    setTimeoutDirty(false)
  }

  const handleSaveMap = () => {
    const result: Record<string, string[] | null> = {}
    for (const [cat, val] of Object.entries(mapDraft)) {
      const trimmed = val.trim()
      result[cat] = trimmed ? trimmed.split(',').map(s => s.trim()).filter(Boolean) : null
    }
    onSave('llm.model_routing_map', JSON.stringify(result))
    setMapDirty(false)
  }

  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
    enabled: expanded && enabled,
  })
  const allModels = (providers ?? [])
    .filter(p => p.available)
    .flatMap(p => p.models.filter(m => m.registered).map(m => m.id))

  return (
    <div className="border-t border-border-subtle pt-4">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-caption font-medium text-content-secondary">Intelligent Model Routing</label>
          <p className="text-caption text-content-tertiary mt-0.5">
            Classifier picks the optimal model per message based on task type.
          </p>
        </div>
        <Toggle checked={enabled} onChange={handleToggle} disabled={saving} />
      </div>

      {enabled && (
        <div className="mt-3 space-y-3 pl-0">
          {/* Classifier model */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-caption font-medium text-content-secondary">Classifier Model</label>
              {classifierDirty && (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setClassifierDraft(classifierModel); setClassifierDirty(false) }} icon={<RotateCcw size={10} />}>Reset</Button>
                  <Button size="sm" onClick={handleSaveClassifier} loading={saving} icon={<Save size={10} />}>Save</Button>
                </div>
              )}
            </div>
            <select
              value={classifierDraft}
              onChange={e => { setClassifierDraft(e.target.value); setClassifierDirty(e.target.value !== classifierModel) }}
              className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors appearance-none"
            >
              <option value="auto">Auto (local-first cascade)</option>
              {allModels.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
            <p className="mt-1 text-caption text-content-tertiary">
              Small fast model used to classify messages. &quot;Auto&quot; tries local Ollama first, then Groq, then Cerebras.
            </p>
          </div>

          {/* Timeout */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-caption font-medium text-content-secondary">
                Classifier Timeout: {timeoutDraft}ms
              </label>
              {timeoutDirty && (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setTimeoutDraft(Number(timeoutMs)); setTimeoutDirty(false) }} icon={<RotateCcw size={10} />}>Reset</Button>
                  <Button size="sm" onClick={handleSaveTimeout} loading={saving} icon={<Save size={10} />}>Save</Button>
                </div>
              )}
            </div>
            <Slider
              min={100}
              max={1000}
              step={50}
              value={timeoutDraft}
              onChange={val => { setTimeoutDraft(val); setTimeoutDirty(val !== Number(timeoutMs)) }}
            />
            <p className="mt-1 text-caption text-content-tertiary">
              Max time to wait for classification. Falls back to default model if exceeded.
            </p>
          </div>

          {/* Category routing map */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(!expanded)}
              >
                Category Model Mapping {expanded ? '\u25BC' : '\u25B6'}
              </Button>
              {mapDirty && (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => {
                    const draft: Record<string, string> = {}
                    for (const [cat, models] of Object.entries(routingMap)) {
                      draft[cat] = models ? models.join(', ') : ''
                    }
                    setMapDraft(draft); setMapDirty(false)
                  }} icon={<RotateCcw size={10} />}>Reset</Button>
                  <Button size="sm" onClick={handleSaveMap} loading={saving} icon={<Save size={10} />}>Save</Button>
                </div>
              )}
            </div>

            {expanded && (
              <div className="space-y-2 mt-2">
                {Object.keys(CATEGORY_LABELS).map(cat => (
                  <div key={cat}>
                    <label className="text-caption text-content-tertiary">{CATEGORY_LABELS[cat]}</label>
                    <Input
                      value={mapDraft[cat] ?? ''}
                      onChange={e => {
                        setMapDraft(prev => ({ ...prev, [cat]: e.target.value }))
                        setMapDirty(true)
                      }}
                      placeholder={cat === 'general' ? '(uses default model)' : 'model-1, model-2, ...'}
                      className="font-mono"
                    />
                  </div>
                ))}
                <p className="text-caption text-content-tertiary">
                  Comma-separated model preference list per category. First available model wins. Leave empty to use default.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Embedding model picker ───────────────────────────────────────────────────

const EMBED_PROVIDERS = [
  { value: 'auto', label: 'Auto (route by model name)' },
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'gemini', label: 'Gemini (free)' },
  { value: 'litellm', label: 'OpenAI / Anthropic (paid)' },
] as const

function EmbeddingModelPicker({
  entries,
  onSave,
  saving,
}: {
  entries: PlatformConfigEntry[]
  onSave: (key: string, value: string) => void
  saving: boolean
}) {
  const provider = useConfigValue(entries, 'llm.embed_provider', 'auto')
  const model = useConfigValue(entries, 'llm.embed_model', '')

  const [providerDraft, setProviderDraft] = useState(provider)
  const [modelDraft, setModelDraft] = useState(model)
  const [providerDirty, setProviderDirty] = useState(false)
  const [modelDirty, setModelDirty] = useState(false)

  useEffect(() => { setProviderDraft(provider); setProviderDirty(false) }, [provider])
  useEffect(() => { setModelDraft(model); setModelDirty(false) }, [model])

  const { data: resolved } = useQuery({
    queryKey: ['resolved-model'],
    queryFn: resolveModel,
    staleTime: 30_000,
  })

  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
  })

  // Suggest models from the chosen provider's discovered catalog (datalist).
  const suggestions: string[] = (() => {
    if (providerDraft === 'auto' || !providers) return []
    // 'litellm' covers OpenAI/Anthropic; discovery exposes them as 'openai'/'anthropic'.
    const slug = providerDraft === 'litellm' ? 'openai' : providerDraft
    const entry = providers.find(p => p.slug === slug)
    if (!entry) return []
    return entry.models.filter(m => m.registered).map(m => m.id)
  })()

  const handleSaveProvider = () => {
    onSave('llm.embed_provider', JSON.stringify(providerDraft))
    setProviderDirty(false)
  }
  const handleSaveModel = () => {
    onSave('llm.embed_model', JSON.stringify(modelDraft))
    setModelDirty(false)
  }

  const isExplicit = providerDraft !== 'auto'

  return (
    <div className="border-t border-border-subtle pt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-caption font-medium text-content-secondary">Embedding Model</label>
        {providerDirty && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setProviderDraft(provider); setProviderDirty(false) }} icon={<RotateCcw size={10} />}>Reset</Button>
            <Button size="sm" onClick={handleSaveProvider} loading={saving} icon={<Save size={10} />}>Save</Button>
          </div>
        )}
      </div>
      <select
        value={providerDraft}
        onChange={e => { setProviderDraft(e.target.value); setProviderDirty(e.target.value !== provider) }}
        className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors appearance-none"
      >
        {EMBED_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>

      {!isExplicit ? (
        <p className="mt-1 text-caption text-content-tertiary">
          Embeddings route by model name (memory-service&rsquo;s EMBEDDING_MODEL, default <code>nomic-embed-text</code>). Pin a provider above to force embeddings through it.
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-caption text-content-tertiary">Model name to send</label>
            {modelDirty && (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setModelDraft(model); setModelDirty(false) }} icon={<RotateCcw size={10} />}>Reset</Button>
                <Button size="sm" onClick={handleSaveModel} loading={saving} icon={<Save size={10} />}>Save</Button>
              </div>
            )}
          </div>
          <input
            type="text"
            value={modelDraft}
            onChange={e => { setModelDraft(e.target.value); setModelDirty(e.target.value !== model) }}
            placeholder={providerDraft === 'lmstudio' ? 'text-embedding-3-small (or a local GGUF embed model)' : 'model-id'}
            list="embed-model-suggestions"
            className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary placeholder:text-content-tertiary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors font-mono"
          />
          <datalist id="embed-model-suggestions">
            {suggestions.map(id => <option key={id} value={id} />)}
          </datalist>
        </div>
      )}

      <div className="mt-2 rounded-sm bg-surface-elevated p-2.5 text-caption text-content-tertiary space-y-1">
        <p>
          <span className="font-medium text-content-secondary">Single-model servers:</span> don&rsquo;t run chat and embeddings on the same LM Studio <em>or</em> Ollama instance &mdash; each embed call evicts the chat model. Put chat and embeddings on different local servers, or use a cloud embed model.
        </p>
        <p>
          <span className="font-medium text-content-secondary">Dimensions:</span> embeddings must match memory-service&rsquo;s EMBEDDING_DIMENSIONS (default 768). Use a 768-dim model (e.g. <code>nomic-embed-text</code>) unless you&rsquo;ve reconfigured memory-service and re-embedded. Effective resolved model: <code>{resolved?.model ?? 'nomic-embed-text'}</code>.
        </p>
      </div>
    </div>
  )
}

export function LLMRoutingSection({
  entries,
  onSave,
  saving,
}: {
  entries: PlatformConfigEntry[]
  onSave: (key: string, value: string) => void
  saving: boolean
}) {
  const strategy = useConfigValue(entries, 'llm.routing_strategy', 'local-first')
  // Ollama URL is now read from inference.url (canonical) — see LocalInferenceSection.
  const cloudFallback = useConfigValue(entries, 'llm.cloud_fallback_model', 'groq/llama-3.3-70b-versatile')
  const wolMac = useConfigValue(entries, 'llm.wol_mac', '')
  const wolBroadcast = useConfigValue(entries, 'llm.wol_broadcast', '255.255.255.255')

  const [strategySaved, setStrategySaved] = useState(false)

  const usesOllama = strategy !== 'cloud-only'
  const usesCloud = strategy !== 'local-only'

  const { data: ollamaStatus } = useQuery({
    queryKey: ['ollama-status'],
    queryFn: getOllamaStatus,
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: usesOllama,
  })

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms: number; error?: string } | null>(null)

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testProvider('ollama')
      setTestResult(result)
    } catch (e) {
      setTestResult({ ok: false, latency_ms: 0, error: String(e) })
    } finally {
      setTesting(false)
    }
  }, [])

  const handleStrategyChange = (value: string) => {
    // Routing strategy is purely a gateway routing preference — it flows to
    // nova:config:llm.routing_strategy and the gateway honors it live. There is
    // no bundled inference container to start/stop; local inference is external.
    onSave('llm.routing_strategy', JSON.stringify(value))
    setStrategySaved(true)
    setTimeout(() => setStrategySaved(false), 1500)
  }

  return (
    <Section
      icon={Radio}
      title="LLM Routing"
      description="Control how requests are routed between local and cloud providers. The local backend itself is configured under Local Inference."
    >
      {/* Strategy selector */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <label className="text-caption font-medium text-content-secondary">Routing Strategy</label>
          <EnvOverrideBadge override={entries.find(e => e.key === 'llm.routing_strategy')?.env_override} />
          <ConfigHistoryToggle configKey="llm.routing_strategy" />
          {strategySaved && (
            <Badge color="success" size="sm">Saved</Badge>
          )}
        </div>
        <div className="inline-flex flex-wrap rounded-sm border border-border p-0.5">
          {ROUTING_STRATEGIES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => handleStrategyChange(value)}
              disabled={saving}
              className={
                'rounded-xs px-3 py-1.5 text-caption font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
                (strategy === value
                  ? 'bg-surface-elevated text-accent'
                  : 'text-content-tertiary hover:text-content-secondary')
              }
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-caption text-content-tertiary">
          {ROUTING_STRATEGIES.find(s => s.value === strategy)?.desc}
        </p>
      </div>

      {/* Ollama settings */}
      {usesOllama && (
        <>
          <Card variant="default" className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusDot status={ollamaStatus == null ? 'neutral' : ollamaStatus.healthy ? 'success' : 'danger'} />
                <span className="text-compact font-medium text-content-primary">
                  Ollama {ollamaStatus == null ? 'Checking...' : ollamaStatus.healthy ? 'Online' : 'Offline'}
                </span>
              </div>
              <span className="text-caption font-mono text-content-tertiary">
                {ollamaStatus?.base_url ?? '...'}
              </span>
            </div>

            {ollamaStatus?.wol_configured && (
              <div className="flex items-center gap-2 text-caption text-content-tertiary">
                <Power size={12} />
                <span>
                  WoL {ollamaStatus.wol_last_sent_seconds_ago != null
                    ? `sent ${ollamaStatus.wol_last_sent_seconds_ago}s ago`
                    : 'ready'}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={handleTest} loading={testing}>
                Test Connection
              </Button>
              {testResult && (
                <span className={`text-caption ${testResult.ok ? 'text-success' : 'text-danger'}`}>
                  {testResult.ok ? `${testResult.latency_ms}ms` : testResult.error ?? 'Failed'}
                </span>
              )}
            </div>
          </Card>

          {/* Ollama URL is configured in the Local Inference section above
              (External target URL field). The legacy llm.ollama_url key has
              been retired — the gateway reads only inference.url now, and
              a startup migration in llm-gateway/app/main.py moves any value
              from the old key over on first run. */}

          {/* Wake-on-LAN config */}
          <div className="border-t border-border-subtle pt-4">
            <label className="mb-2 block text-caption font-medium text-content-secondary">Wake-on-LAN</label>
            <div className="grid gap-3 sm:grid-cols-2">
              <ConfigField
                label="MAC Address"
                configKey="llm.wol_mac"
                value={wolMac}
                placeholder="AA:BB:CC:DD:EE:FF"
                description="MAC of the remote Ollama host."
                onSave={onSave}
                saving={saving}
              />
              <ConfigField
                label="Broadcast IP"
                configKey="llm.wol_broadcast"
                value={wolBroadcast}
                placeholder="192.168.1.255"
                description="LAN broadcast address."
                onSave={onSave}
                saving={saving}
              />
            </div>
          </div>
        </>
      )}

      {/* Cloud fallback model */}
      {usesCloud && (
        <CloudFallbackModelPicker
          value={cloudFallback}
          onSave={onSave}
          saving={saving}
          override={entries.find(e => e.key === 'llm.cloud_fallback_model')?.env_override}
        />
      )}

      {/* Default chat model */}
      <DefaultModelPicker onSave={onSave} saving={saving} entries={entries} />

      {/* Embedding model (chat↔embed provider pairing) */}
      <EmbeddingModelPicker entries={entries} onSave={onSave} saving={saving} />

      {/* Intelligent routing */}
      <IntelligentRoutingSection entries={entries} onSave={onSave} saving={saving} />
    </Section>
  )
}
