import { useEffect, useState } from 'react'
import { getCatalog as apiGetCatalog, getSystemResources as apiGetSystemResources } from '../../lib/api'
import { ContextPanel } from './ContextPanel'

/**
 * How full the context is — measured, never estimated.
 *
 * THE NUMERATOR is the gateway's own `prompt_tokens` off the usage frame:
 * what the last answered turn actually sent. A client-side estimate would
 * stop matching reality the first time prompt assembly changes — and S24
 * changed it, twice, by prepending a thread's seed — and it would go on
 * looking confident while it did.
 *
 * THE DENOMINATOR is the model's `context_length` as the catalog states it,
 * with the catalog's own provenance behind it (ollama's /api/show, or a
 * declared tag). **When it is unknown there is no ring at all** — only the
 * count. A gauge needs two numbers, and inventing the second one is how a
 * dial ends up showing a comfortable third-full against a window nobody
 * measured. "128K" guessed from a model's name is exactly that guess.
 */

/** Rendered without a ring below this: a fraction of a window we are not
 *  sure of is a picture of a guess. */
export type ContextGaugeProps = {
  /** The gateway's count for the last answered turn, or null. */
  promptTokens: number | null
  /** `provider:model` in play, so the window can be looked up for it. */
  model: string
  /** DI seam — production uses the real catalog. */
  getCatalog?: typeof apiGetCatalog
  /** DI seam for the panel this gauge opens. */
  getResources?: typeof apiGetSystemResources
}

const SIZE = 14
const STROKE = 2.5
const R = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * R

/** 1.2K, 34K, 210K — a token count is read at a glance or not at all. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const thousands = n / 1000
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`
}

/**
 * The window for a model, out of the catalog's facts. null whenever the
 * catalog does not state one — an absent fact, a row that is not there, a
 * catalog that could not be read. Exported pure so the "no ring without a
 * denominator" rule is testable without a network.
 */
export type WindowRow = {
  /** `provider:model`, which is what chat.model holds. */
  id: string
  model?: string
  facts?: Record<string, { value?: unknown } | undefined>
}

export function windowFor(rows: WindowRow[], model: string): number | null {
  // `chat.model` may be bare (`qwen3:8b`) or qualified (`ollama:qwen3:8b`),
  // and the catalog's id is qualified — so the match is tried both ways
  // rather than assuming one shape. No match is a real answer: no ring.
  const row = rows.find(
    r => r.id === model || r.id.endsWith(`:${model}`) || (!!r.model && model.endsWith(`:${r.model}`)),
  )
  const stated = row?.facts?.context_length?.value
  return typeof stated === 'number' && stated > 0 ? stated : null
}

export function ContextGauge({
  promptTokens,
  model,
  getCatalog = apiGetCatalog,
  getResources,
}: ContextGaugeProps) {
  const [window_, setWindow] = useState<number | null>(null)
  const [open, setOpen] = useState(false)

  // Looked up ONCE per model, lazily, and never allowed to fail loudly: a
  // catalog read probes every installed model, so the chat page must not
  // wait on it and must not break when it is slow or refused.
  useEffect(() => {
    if (!model) return
    let live = true
    getCatalog()
      .then(catalog => {
        if (live) setWindow(windowFor(catalog.rows as never, model))
      })
      .catch(() => {
        /* no window stated, so no ring — see the module docstring. */
      })
    return () => {
      live = false
    }
  }, [model, getCatalog])

  if (promptTokens === null) return null

  const fraction = window_ ? Math.min(1, promptTokens / window_) : null
  // Only ever a statement of fact, and the percentage only exists when the
  // window does.
  const title =
    fraction === null
      ? `the last turn sent ${promptTokens.toLocaleString()} prompt tokens; this model's context window is not stated in the catalog, so there is no fraction to show`
      : `the last turn sent ${promptTokens.toLocaleString()} of this model's ${window_!.toLocaleString()}-token context window`

  return (
    <span className="relative inline-flex">
      {open && (
        <ContextPanel
          promptTokens={promptTokens}
          contextWindow={window_}
          onClose={() => setOpen(false)}
          {...(getResources ? { getResources } : {})}
        />
      )}
      {/* A BUTTON, because it opens something. The gauge was a label until
          the owner asked it to open the fuller picture (2026-09-16), and a
          label that reacts to clicks is a control nobody can find. */}
      <button
        type="button"
        data-testid="context-gauge"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        title={title}
        className="inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-micro text-content-tertiary hover:text-content-primary hover:bg-surface-card transition-colors duration-fast font-mono"
      >
      {fraction !== null && (
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0" aria-hidden="true">
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            className="stroke-border"
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            // Filling clockwise from twelve, the way a dial is read.
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            className={fraction > 0.9 ? 'stroke-warning' : 'stroke-accent'}
          />
        </svg>
      )}
        <span data-testid="context-gauge-count">{formatTokens(promptTokens)}</span>
      </button>
    </span>
  )
}
