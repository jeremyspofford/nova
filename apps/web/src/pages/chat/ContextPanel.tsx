import { useEffect, useRef, useState } from 'react'
import { getSystemResources as apiGetSystemResources, type SystemResources } from '../../lib/api'
import { formatTokens } from './ContextGauge'

/**
 * What is actually available to answer the next question.
 *
 * Opened from the context gauge, the way Claude Code's usage popover opens
 * from its ring — the owner's ask (2026-09-16). The context window is the
 * headline because it is what the gauge showed; underneath it are the
 * facts that decide whether the next turn is fast, slow, or impossible.
 *
 * EVERY FIGURE IS MEASURED, and a figure that could not be measured says
 * so rather than rendering as zero. "No free memory" and "we could not
 * read free memory" are opposite findings.
 *
 * Free VRAM and utilisation both appear because they fail in opposite
 * directions: on 2026-09-16 the card had 16.1 GB free and sat at 99% busy,
 * and a panel showing only the first describes that as healthy.
 *
 * There is no network row. Nobody measures throughput here, and a number
 * nobody measured looks exactly as confident as one somebody did.
 */

/** A labelled bar. `fraction` null draws no bar at all — see ContextGauge
 *  on why a dial without a denominator is a picture of a guess. */
function Row({
  label,
  value,
  fraction,
  tone = 'accent',
  note,
}: {
  label: string
  value: string
  fraction?: number | null
  tone?: 'accent' | 'warning'
  note?: string | null
}) {
  return (
    <div className="py-2.5" data-testid={`panel-row-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      {/* The LABEL carries the weight and the value is monospace and
          secondary — the owner's note (2026-09-16) was that the roles were
          hard to tell apart, because both sides were the same size in the
          same colour at 320px. Wider, and with the two sides doing
          different jobs typographically, the eye lands on the label first
          and reads across. */}
      <div className="flex items-baseline justify-between gap-6">
        <span className="text-compact font-medium text-content-primary whitespace-nowrap">
          {label}
        </span>
        <span className="text-compact text-content-secondary font-mono tabular-nums text-right">
          {value}
        </span>
      </div>
      {fraction !== null && fraction !== undefined && (
        <div
          data-testid="panel-row-bar"
          className="mt-2 h-1.5 w-full rounded-full bg-border/60 overflow-hidden"
        >
          <div
            className={tone === 'warning' ? 'h-full rounded-full bg-warning' : 'h-full rounded-full bg-accent'}
            style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
          />
        </div>
      )}
      {note && <p className="mt-1.5 text-caption text-content-tertiary leading-snug">{note}</p>}
    </div>
  )
}

export function ContextPanel({
  promptTokens,
  contextWindow,
  onClose,
  getResources = apiGetSystemResources,
}: {
  promptTokens: number | null
  /** null when the catalog states no window — the headline then shows the
   *  count without a bar, exactly as the gauge does. */
  contextWindow: number | null
  onClose: () => void
  getResources?: typeof apiGetSystemResources
}) {
  const [data, setData] = useState<SystemResources | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    getResources()
      .then(r => live && setData(r))
      .catch(e => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [getResources])

  // Escape and a click outside, because a popover you cannot dismiss is a
  // modal nobody asked for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // `mousedown` on the NEXT tick: the click that opened this panel is
    // still propagating, and closing on it would make the button inert.
    const id = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      clearTimeout(id)
    }
  }, [onClose])

  const card = data?.card
  const mem = data?.machine?.memory
  const cpu = data?.machine?.cpu
  const disk = data?.machine?.disk
  const rate = data?.throughput

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="What is available right now"
      data-testid="context-panel"
      // Wider than it is tall, like the panel he pointed at. At 320px every
      // row wrapped and the whole thing read as one column of grey.
      //
      // ON A PHONE IT IS PINNED TO THE VIEWPORT, not to the gauge. Anchored
      // `right-0` against a control that sits near the right of a 393px
      // screen, a 361px panel began at x=-102 and lost its left third off
      // the edge — measured, not guessed. Above `md` there is room for it
      // to hang off the gauge, which is where it belongs.
      className="fixed inset-x-3 bottom-20 z-50 md:absolute md:inset-x-auto md:right-0 md:bottom-full md:mb-2 md:w-[26rem] rounded-lg border border-border-subtle bg-surface-elevated shadow-xl px-4 py-2 divide-y divide-border-subtle"
    >
      <Row
        label="Context window"
        value={
          promptTokens === null
            ? 'not measured yet'
            : contextWindow
              ? `${formatTokens(promptTokens)} / ${formatTokens(contextWindow)} (${Math.round((promptTokens / contextWindow) * 100)}%)`
              : formatTokens(promptTokens)
        }
        fraction={promptTokens !== null && contextWindow ? promptTokens / contextWindow : null}
        note={
          promptTokens !== null && !contextWindow
            ? 'this model states no context window in the catalog, so there is no fraction to show'
            : null
        }
      />

      {error && (
        <p role="alert" className="py-2 text-caption text-danger">
          Could not read what is available: {error}
        </p>
      )}

      {card &&
        (card.reason && card.free_gb == null ? (
          <p className="py-2 text-caption text-content-tertiary">The card: {card.reason}</p>
        ) : (
          <>
            <Row
              label="Card memory"
              value={`${card.free_gb?.toFixed(1)} GB free of ${card.total_gb?.toFixed(1)}`}
              fraction={
                card.total_gb && card.used_gb != null ? card.used_gb / card.total_gb : null
              }
              note={
                card.non_ollama_gb != null && card.non_ollama_gb >= 1
                  ? `${card.non_ollama_gb.toFixed(1)} GB is held by something that is not ollama`
                  : null
              }
            />
            {card.utilisation_pct != null && (
              <Row
                label="Card busy"
                value={`${Math.round(card.utilisation_pct)}%`}
                fraction={card.utilisation_pct / 100}
                tone={card.utilisation_pct >= 90 ? 'warning' : 'accent'}
                note={
                  card.utilisation_pct >= 90
                    ? 'the shader cores are saturated — memory being free does not make the card available'
                    : null
                }
              />
            )}
          </>
        ))}

      {rate && rate.recent_tok_per_s != null && (
        <Row
          label="Generating"
          value={`${rate.recent_tok_per_s} tok/s`}
          fraction={null}
          note={
            rate.baseline_tok_per_s
              ? `its usual here is ${rate.baseline_tok_per_s}${rate.ratio && rate.ratio > 1.5 ? ` — ${rate.ratio}x slower than that` : ''}`
              : 'no baseline for this model here yet'
          }
        />
      )}

      {mem &&
        (mem.reason ? (
          <p className="py-2 text-caption text-content-tertiary">Memory: {mem.reason}</p>
        ) : (
          <Row
            label="Memory"
            value={`${((mem.available_mb ?? 0) / 1024).toFixed(1)} GB free of ${((mem.total_mb ?? 0) / 1024).toFixed(0)}`}
            fraction={
              mem.total_mb && mem.available_mb != null
                ? (mem.total_mb - mem.available_mb) / mem.total_mb
                : null
            }
          />
        ))}

      {cpu && cpu.cores != null && cpu.load_1m != null && (
        <Row
          label="CPU"
          value={`${cpu.load_1m} load on ${cpu.cores} cores`}
          fraction={cpu.load_1m / cpu.cores}
          tone={cpu.load_1m > cpu.cores ? 'warning' : 'accent'}
        />
      )}

      {disk && disk.free_gb != null && disk.total_gb != null && (
        <Row
          label="Disk"
          value={`${disk.free_gb.toFixed(0)} GB free of ${disk.total_gb.toFixed(0)}`}
          fraction={(disk.total_gb - disk.free_gb) / disk.total_gb}
        />
      )}

      {!data && !error && (
        <p className="py-2 text-caption text-content-tertiary">Reading the machine…</p>
      )}
    </div>
  )
}
