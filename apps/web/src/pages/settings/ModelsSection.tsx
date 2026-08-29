import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Cloud, Cpu, Download, RefreshCw, Server } from 'lucide-react'
import {
  Badge,
  Button,
  DataList,
  ModelFitNotice,
  ProgressBar,
  Section,
  Skeleton,
} from '../../components/ui'
import {
  getBackend as apiGetBackend,
  getInstalledModels as apiGetInstalledModels,
  getSuggestion as apiGetSuggestion,
  pullModel as apiPullModel,
  putSetting as apiPutSetting,
  type BackendConfig,
  type EngineKind,
  type PullLine,
  type Suggestion,
} from '../../lib/api'
import { mergeModels, type MergedModel } from './modelsFormat'

/**
 * `api` is a dependency-injection seam, the same idiom as ActivityPage's and
 * ChatPage's: production uses the real client (DEFAULT_API below); a test
 * swaps in fakes without reaching for module mocking.
 */
interface ModelsApi {
  getInstalledModels: typeof apiGetInstalledModels
  getSuggestion: typeof apiGetSuggestion
  getBackend: typeof apiGetBackend
  putSetting: typeof apiPutSetting
  pullModel: typeof apiPullModel
}

const DEFAULT_API: ModelsApi = {
  getInstalledModels: apiGetInstalledModels,
  getSuggestion: apiGetSuggestion,
  getBackend: apiGetBackend,
  putSetting: apiPutSetting,
  pullModel: apiPullModel,
}

const ENGINE_ICONS: Record<EngineKind, typeof Cpu> = {
  ollama: Cpu,
  remote: Server,
  cloud: Cloud,
}

const ENGINE_LABELS: Record<EngineKind, string> = {
  ollama: 'Bundled Ollama',
  remote: 'Remote endpoint',
  cloud: 'Cloud (OpenAI-compatible)',
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const STREAM_ENDED_QUIET =
  'the download stream ended without ollama reporting success — the model is not confirmed installed'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

interface PullState {
  slug: string
  status: string
  completed: number
  total: number
  preflight: string | null
  error: string | null
  done: boolean
}

function ErrorLine({ reason }: { reason: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger"
    >
      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
      <span>{reason}</span>
    </div>
  )
}

function ModelCard({
  model,
  switching,
  pull,
  pullBlocked,
  onSelect,
  onPull,
}: {
  model: MergedModel
  switching: boolean
  pull: PullState | null
  /** Another model's pull is in flight — ollama pulls one at a time, and
   * starting a second here would silently abort it (see handlePull). */
  pullBlocked: boolean
  onSelect: () => void
  onPull: () => void
}) {
  const pulling = pull !== null && !pull.done && !pull.error
  const percent =
    pull && pull.total > 0 ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : null

  return (
    <div
      data-testid={`model-card-${model.slug}`}
      className="rounded-lg border border-border-subtle p-3 space-y-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-compact font-medium text-content-primary truncate">{model.label}</p>
          <p className="font-mono text-micro text-content-tertiary truncate">{model.slug}</p>
          {model.note && <p className="text-caption text-content-secondary mt-1">{model.note}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {model.isCurrent && (
            <Badge color="accent" size="sm">
              Current
            </Badge>
          )}
          {!model.isCurrent && model.installed && (
            <Badge color="success" size="sm">
              Installed
            </Badge>
          )}
          {!model.isCurrent && !model.installed && (
            <Badge color="neutral" size="sm">
              Available to pull
            </Badge>
          )}
          {model.minVramGb !== null && (
            <Badge color="neutral" size="sm">
              {model.minVramGb} GB VRAM
            </Badge>
          )}
        </div>
      </div>

      <ModelFitNotice fit={model.fit} />

      {!model.isCurrent && model.installed && (
        <Button size="sm" variant="secondary" loading={switching} onClick={onSelect}>
          Use this model
        </Button>
      )}

      {/* isCurrent excluded here too: the model the operator is actually
          chatting with must never render as pullable just because
          installed-detection came back false for it (a failed
          getInstalledModels call, or a slug the gateway's list doesn't
          happen to name) — chat.model already proves it is in use. */}
      {!model.isCurrent && !model.installed && !pulling && !pull?.done && (
        <Button
          size="sm"
          variant="outline"
          icon={<Download size={12} />}
          disabled={pullBlocked}
          title={pullBlocked ? 'Another download is already in progress' : undefined}
          onClick={onPull}
        >
          Pull
        </Button>
      )}

      {pull && (
        <div className="space-y-1.5 pt-1">
          {pull.preflight && (
            <p className="text-caption text-content-tertiary">{pull.preflight}</p>
          )}
          {pulling && (
            <>
              <div className="flex items-center gap-2 text-caption text-content-primary">
                <span className="truncate">{pull.status}</span>
              </div>
              <ProgressBar
                size="sm"
                value={percent ?? undefined}
                variant={percent === null ? 'indeterminate' : 'determinate'}
              />
              {pull.total > 0 && (
                <p className="text-micro text-content-tertiary">
                  {formatBytes(pull.completed)} of {formatBytes(pull.total)}
                  {percent === null ? '' : ` (${percent}%)`}
                </p>
              )}
            </>
          )}
          {pull.done && (
            <div className="flex items-center gap-2 text-caption text-success">
              <Check size={13} />
              <span>Installed — pick "Use this model" above.</span>
            </div>
          )}
          {pull.error && <ErrorLine reason={pull.error} />}
        </div>
      )}
    </div>
  )
}

/**
 * Settings -> Models: the operator's only non-curl way to see and change
 * what Nova is running on. Reads three existing endpoints (chat.model is
 * passed in from SettingsPage, which already polls settings), merges
 * installed and curated into one list (modelsFormat.ts), and wires the
 * existing pull-progress and backend surfaces — no new backend concepts,
 * see docs/plans/rebuild/slice-02e-model-surface.md T1.
 */
export function ModelsSection({
  chatModel,
  onModelChanged,
  onRerunSetup,
  api = DEFAULT_API,
}: {
  chatModel: string
  onModelChanged: (model: string) => void
  onRerunSetup: () => Promise<void>
  api?: ModelsApi
}) {
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [backend, setBackend] = useState<BackendConfig | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const [pull, setPull] = useState<PullState | null>(null)
  const pullAbort = useRef<AbortController | null>(null)

  const [rerunning, setRerunning] = useState(false)
  const [rerunError, setRerunError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      api.getInstalledModels().then(
        list => !cancelled && setInstalled(list),
        err => !cancelled && setInstalledError(reasonOf(err)),
      ),
      api.getSuggestion().then(
        s => !cancelled && setSuggestion(s),
        err => !cancelled && setSuggestionError(reasonOf(err)),
      ),
      api.getBackend().then(
        b => !cancelled && setBackend(b),
        err => !cancelled && setBackendError(reasonOf(err)),
      ),
    ]).then(() => !cancelled && setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => () => pullAbort.current?.abort(), [])

  const handleSelect = async (slug: string) => {
    setSwitchError(null)
    setSwitching(slug)
    try {
      await api.putSetting('chat.model', slug)
      onModelChanged(slug)
    } catch (err) {
      setSwitchError(reasonOf(err))
    } finally {
      setSwitching(null)
    }
  }

  const handlePull = (slug: string) => {
    // Mechanical, not just the disabled button: ollama pulls one model at a
    // time, so a second start here would silently abort the first rather
    // than queue behind it.
    if (pull !== null && !pull.done && !pull.error && pull.slug !== slug) return
    pullAbort.current?.abort()
    const controller = new AbortController()
    pullAbort.current = controller
    setPull({ slug, status: 'starting the download…', completed: 0, total: 0, preflight: null, error: null, done: false })

    void (async () => {
      let sawSuccess = false
      let failure: string | null = null
      try {
        for await (const line of api.pullModel(slug, controller.signal)) {
          if (controller.signal.aborted) return
          applyPullLine(line)
          if (line.error) {
            failure = line.error
            break
          }
          if (line.status === 'success') sawSuccess = true
        }
      } catch (err) {
        if (controller.signal.aborted) return
        failure = reasonOf(err)
      }
      if (controller.signal.aborted) return

      if (failure) {
        setPull(p => (p && p.slug === slug ? { ...p, error: failure } : p))
        return
      }
      if (!sawSuccess) {
        setPull(p => (p && p.slug === slug ? { ...p, error: STREAM_ENDED_QUIET } : p))
        return
      }
      setInstalled(prev => (prev ? Array.from(new Set([...prev, slug])) : [slug]))
      setPull(p => (p && p.slug === slug ? { ...p, done: true } : p))
    })()

    function applyPullLine(line: PullLine) {
      setPull(p => {
        if (!p || p.slug !== slug) return p
        if (line.status === 'preflight') {
          const note =
            line.note ??
            (line.ok === false
              ? `${slug} needs about ${line.required_gb} GB and only ${line.free_gb} GB is free — the pull will probably fail.`
              : `${line.required_gb} GB needed, ${line.free_gb} GB free.`)
          return { ...p, preflight: note }
        }
        return {
          ...p,
          status: line.status ?? p.status,
          total: typeof line.total === 'number' ? line.total : p.total,
          completed: typeof line.completed === 'number' ? line.completed : p.completed,
        }
      })
    }
  }

  const handleRerun = async () => {
    setRerunError(null)
    setRerunning(true)
    try {
      await onRerunSetup()
      // A successful re-run flips the app gate to the wizard, which unmounts
      // this section — rerunning is intentionally left true rather than
      // reset, since there is nothing left to show once that happens.
    } catch (err) {
      setRerunError(reasonOf(err))
      setRerunning(false)
    }
  }

  const merged = mergeModels(chatModel, installed, suggestion?.models ?? null)

  const backendItems = backend
    ? [
        {
          label: 'Engine',
          value: (
            <span className="inline-flex items-center gap-1.5">
              {(() => {
                const Icon = ENGINE_ICONS[backend.kind]
                return <Icon size={13} className="text-content-tertiary" />
              })()}
              {ENGINE_LABELS[backend.kind]}
            </span>
          ),
        },
        ...(backend.url ? [{ label: 'URL', value: backend.url }] : []),
        ...(backend.provider ? [{ label: 'Provider', value: backend.provider }] : []),
        // Masked by the gateway (backends.to_public) before it ever reaches
        // the browser — core only proxies; this renders exactly what it was
        // given, never the raw key.
        ...(backend.api_key ? [{ label: 'API key', value: backend.api_key }] : []),
      ]
    : []

  return (
    <Section
      icon={Cpu}
      title="Models"
      description="What Nova answers with, and how to change it."
    >
      {!loaded ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <div>
            <p className="text-caption text-content-tertiary mb-1">Current chat model</p>
            <p
              data-testid="current-chat-model"
              className="text-compact font-mono font-medium text-content-primary"
            >
              {chatModel || 'not set'}
            </p>
          </div>

          {installedError && (
            <ErrorLine
              reason={`Could not confirm which models are installed — showing the curated catalog only: ${installedError}`}
            />
          )}
          {suggestionError && (
            <ErrorLine reason={`Could not load the curated catalog: ${suggestionError}`} />
          )}
          {switchError && <ErrorLine reason={switchError} />}

          <div className="space-y-2">
            {merged.length === 0 ? (
              <p className="text-caption text-content-tertiary">No models to show yet.</p>
            ) : (
              merged.map(model => (
                <ModelCard
                  key={model.slug}
                  model={model}
                  switching={switching === model.slug}
                  pull={pull?.slug === model.slug ? pull : null}
                  pullBlocked={
                    pull !== null && !pull.done && !pull.error && pull.slug !== model.slug
                  }
                  onSelect={() => handleSelect(model.slug)}
                  onPull={() => handlePull(model.slug)}
                />
              ))
            )}
          </div>

          <div className="border-t border-border-subtle pt-4 space-y-3">
            <p className="text-caption font-medium text-content-secondary">Active backend</p>
            {backendError ? (
              <ErrorLine reason={`Could not read the active backend: ${backendError}`} />
            ) : (
              backend && <DataList items={backendItems} />
            )}
            <p className="text-caption text-content-tertiary">
              Changing the engine itself (bundled/remote/cloud) is done through setup.
            </p>
            <Button
              variant="outline"
              size="sm"
              icon={<RefreshCw size={12} />}
              loading={rerunning}
              onClick={handleRerun}
            >
              Re-run setup
            </Button>
            {rerunError && <ErrorLine reason={rerunError} />}
          </div>
        </>
      )}
    </Section>
  )
}
