import { useEffect, useState } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { AlertTriangle, Cloud, Cpu, Info, RefreshCw, Server } from 'lucide-react'
import { Button, DataList, Section, Skeleton } from '../../components/ui'
import {
  getBackend as apiGetBackend,
  putSetting as apiPutSetting,
  visionModels as apiVisionModels,
  type BackendConfig,
  type EngineKind,
} from '../../lib/api'
import { ACCURACY_DISCLAIMER } from '../../lib/modelDisclaimer'

/**
 * `api` is a dependency-injection seam, the same idiom as ActivityPage's and
 * ChatPage's: production uses the real client (DEFAULT_API below); a test
 * swaps in fakes without reaching for module mocking.
 */
interface ModelsApi {
  getBackend: typeof apiGetBackend
  putSetting: typeof apiPutSetting
  visionModels: typeof apiVisionModels
}

const DEFAULT_API: ModelsApi = {
  getBackend: apiGetBackend,
  putSetting: apiPutSetting,
  visionModels: apiVisionModels,
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

/**
 * The icon and label for an engine kind, INCLUDING one we have never heard
 * of.
 *
 * A bare `ENGINE_ICONS[kind]` returns undefined for an unrecognised kind,
 * and rendering undefined as a component throws — which unmounts the whole
 * of Settings, not just this row. So the day the gateway learns a fourth
 * engine, an operator on an older build would open Settings to a white page
 * and have no way to reach the control that changes the engine back. The
 * unknown kind is worth showing; it is the only clue about what happened.
 */
export function engineDisplay(kind: string | undefined): { Icon: typeof Cpu; label: string } {
  const known = kind !== undefined && Object.prototype.hasOwnProperty.call(ENGINE_ICONS, kind)
  if (!known) return { Icon: Server, label: kind ? `Unknown engine (${kind})` : 'Engine not reported' }
  return { Icon: ENGINE_ICONS[kind as EngineKind], label: ENGINE_LABELS[kind as EngineKind] }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

/**
 * Settings -> Models -> "Models": what is set here and nowhere else — which
 * model reads an image, the engine setup chose and how to re-run setup.
 *
 * It used to carry a second model list with its own Use and Pull (S2e), and
 * a "current chat model" line: the Models page lists every model and pulls
 * them, and Routing below is where chat's order is set, so the copies went
 * (2026-10-05, owner: reduce the duplicated model pages).
 */
export function ModelsSection({
  visionModel = '',
  onVisionChanged,
  onRerunSetup,
  api = DEFAULT_API,
}: {
  /** S28: which model answers a turn carrying an image, when the chat model
   * cannot see one. Empty means she picks a capable one herself. */
  visionModel?: string
  /** What core stored for chat.vision_model — never the chat model: handing
   * it to the chat model's handler made the page and the chat badge name
   * the image model as the chat model until a reload. */
  onVisionChanged: (model: string) => void
  onRerunSetup: () => Promise<void>
  api?: ModelsApi
}) {
  // A Link needs a Router; this section is also rendered bare in its own
  // tests and the gallery, where a plain anchor is the honest fallback.
  const inRouter = useInRouterContext()
  // S28: installed models that can actually SEE, from core — the same list
  // the turn picks within, so this picker cannot offer one she would decline.
  const [seers, setSeers] = useState<string[] | null>(null)
  const [seersReason, setSeersReason] = useState<string | null>(null)
  const [savingVision, setSavingVision] = useState(false)
  const [visionError, setVisionError] = useState<string | null>(null)
  const [backend, setBackend] = useState<BackendConfig | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const [rerunning, setRerunning] = useState(false)
  const [rerunError, setRerunError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      api.getBackend().then(
        b => !cancelled && setBackend(b),
        err => !cancelled && setBackendError(reasonOf(err)),
      ),
      api.visionModels().then(
        got => {
          if (cancelled) return
          // A body that is not the shape promised degrades to "could not
          // tell" rather than being trusted. Rendering `undefined.length`
          // throws, and a throw in here unmounts the WHOLE Settings panel —
          // the same way an unknown backend kind once did (S24). One bad
          // answer must cost this one control, not the page.
          const models = Array.isArray(got?.models) ? got.models : null
          setSeers(models ?? [])
          setSeersReason(
            models === null
              ? 'core did not answer with a list of models'
              : (got.reason ?? null),
          )
        },
        err => {
          if (cancelled) return
          setSeers([])
          setSeersReason(reasonOf(err))
        },
      ),
    ]).then(() => !cancelled && setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [api])

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

  const backendItems = backend
    ? [
        {
          label: 'Engine',
          value: (
            <span className="inline-flex items-center gap-1.5">
              {(() => {
                const { Icon, label } = engineDisplay(backend.kind)
                return (
                  <>
                    <Icon size={13} className="text-content-tertiary" />
                    {label}
                  </>
                )
              })()}
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

  const modelsLink = inRouter ? (
    <Link to="/models" className="text-accent hover:underline">
      Models
    </Link>
  ) : (
    <a href="/models" className="text-accent hover:underline">
      Models
    </a>
  )

  return (
    <Section icon={Cpu} title="Models" description="Which model reads images, and the engine setup chose.">
      {!loaded ? (
        <Skeleton lines={4} />
      ) : (
        <>
          {/* WHICH MODEL LOOKS AT A PICTURE (S28, owner's call).
              The chat model usually cannot: on this box qwen3:8b has tools
              and thinking and no vision at all. So a turn carrying an image
              runs somewhere else, and this is where he says where — or
              leaves it to her, which is the default and the honest one when
              he has no preference. The list is core's, derived from the same
              capability map the turn reads, so this cannot offer a model she
              would then decline. */}
          <div data-testid="vision-model">
            <p className="text-caption text-content-tertiary mb-1">Model that reads images</p>
            {seers === null ? (
              <p className="text-compact text-content-tertiary">checking…</p>
            ) : seers.length === 0 ? (
              <p className="text-compact text-content-secondary" data-testid="no-vision-model">
                {seersReason
                  ? `Could not tell which models can see images — ${seersReason}`
                  : 'No installed model can see images. Nova will say so rather than describing ' +
                    'one; pull a vision model in Models to change that.'}
              </p>
            ) : (
              <>
                <select
                  aria-label="Model that reads images"
                  value={visionModel}
                  disabled={savingVision}
                  onChange={async e => {
                    const picked = e.target.value
                    setSavingVision(true)
                    setVisionError(null)
                    try {
                      const written = await api.putSetting('chat.vision_model', picked)
                      onVisionChanged(String(written.value ?? picked))
                    } catch (err) {
                      // The old value stays showing, and why the new one did
                      // not take is said — a refused pick never looks taken.
                      setVisionError(reasonOf(err))
                    } finally {
                      setSavingVision(false)
                    }
                  }}
                  className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-compact"
                >
                  <option value="">Choose automatically</option>
                  {seers.map(model => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-caption text-content-tertiary">
                  {visionModel
                    ? `Images go to ${visionModel}. She says so in the reply when a turn moves.`
                    : 'She picks one of these when you send an image, and says which in the reply.'}
                </p>
                {visionError && <ErrorLine reason={`Could not save the image model: ${visionError}`} />}
              </>
            )}
          </div>

          <p className="text-caption text-content-tertiary" data-testid="models-catalog-link">
            Which model chat answers with, and what it falls back to, is set under Routing below. Browse
            every model Nova can run or reach, pull one, or compare them in {modelsLink}.
          </p>
          {/* Honest, qualitative accuracy disclaimer (S3 walk-fix round 12) —
              no invented number, just the trade-off stated plainly. The chat
              switcher carries the short form, warmer when the pick is on the
              smaller end of what is on offer. */}
          <div
            data-testid="model-accuracy-disclaimer"
            role="note"
            className="flex items-start gap-2 rounded-sm border border-info/30 bg-info-dim px-3 py-2 text-caption text-content-secondary"
          >
            <Info size={14} className="shrink-0 mt-0.5" />
            <span>{ACCURACY_DISCLAIMER}</span>
          </div>

          <div className="border-t border-border-subtle pt-4 space-y-3">
            <p className="text-caption font-medium text-content-secondary">Engine setup chose</p>
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
