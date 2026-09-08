import { useState } from 'react'
import type { CatalogRow } from '../../lib/api'
import { BENCHMARK_INDICES, benchmarkScore, type BenchmarkKey } from './catalogFormat'

/**
 * The benchmark block, the way a model page shows it: one chart per index
 * (Intelligence, Coding, Agentic), a 0-100 axis, one bar per model with its
 * score on top, the model's name beneath, and a footnote naming the models
 * that have NO data for that index — absent stays absent, never a zero-
 * height bar. Hovering a bar shows that model's three scores together.
 *
 * The numbers are OpenRouter's relay of Artificial Analysis's indices —
 * declared by that provider, third-party, never measured here; the caption
 * says so. Local models carry none and simply do not appear.
 */
const TICKS = [100, 80, 60, 40, 20, 0]
const PALETTE = ['bg-accent', 'bg-info', 'bg-success', 'bg-warning', 'bg-violet-500', 'bg-pink-500', 'bg-teal-500', 'bg-orange-500']

function shortLabel(row: CatalogRow): string {
  const label = row.label || row.model
  return label.length > 22 ? `${label.slice(0, 21)}…` : label
}

export function BenchmarkCharts({ rows }: { rows: CatalogRow[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const scored = rows.filter(r => BENCHMARK_INDICES.some(i => benchmarkScore(r, i.key) !== null))
  if (scored.length === 0) {
    return (
      <p className="text-caption text-content-tertiary" data-testid="benchmarks-empty">
        None of these models carries a benchmark index. Indices come with a cloud provider's listing (OpenRouter relays
        Artificial Analysis); local models have none.
      </p>
    )
  }
  const colour = (row: CatalogRow) => PALETTE[scored.indexOf(row) % PALETTE.length]
  const hovered = hover ? scored.find(r => r.id === hover) ?? null : null
  const source = scored.flatMap(r => BENCHMARK_INDICES.map(i => benchmarkScore(r, i.key)?.source)).find(Boolean)

  return (
    <div data-testid="benchmark-charts">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {BENCHMARK_INDICES.map(index => {
          const withData = scored.filter(r => benchmarkScore(r, index.key) !== null)
          const without = scored.filter(r => benchmarkScore(r, index.key) === null)
          return (
            <div key={index.key} className="min-w-0" data-testid={`benchmark-chart-${index.key}`}>
              <h4 className="mb-3 text-compact font-medium text-content-secondary">{index.label}</h4>
              <div className="flex gap-2">
                <div className="flex h-40 flex-col justify-between text-micro text-content-tertiary" aria-hidden>
                  {TICKS.map(t => (
                    <span key={t} className="leading-none">{t}</span>
                  ))}
                </div>
                <div className="relative flex h-40 flex-1 items-end gap-2 border-b border-l border-line pl-1">
                  {withData.length === 0 ? (
                    <span className="mb-2 text-caption text-content-tertiary">no data</span>
                  ) : (
                    withData.map(row => {
                      const score = benchmarkScore(row, index.key) as NonNullable<ReturnType<typeof benchmarkScore>>
                      const pct = Math.max(0, Math.min(100, score.value))
                      return (
                        <div
                          key={row.id}
                          className="group relative flex h-full flex-1 flex-col items-center justify-end"
                          onMouseEnter={() => setHover(row.id)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(row.id)}
                          onBlur={() => setHover(null)}
                          tabIndex={0}
                          aria-label={`${row.label} ${index.label} ${Math.round(score.value)}`}
                        >
                          <span className="mb-1 text-micro font-medium text-content-primary">{Math.round(score.value)}</span>
                          <div
                            data-testid={`bench-${index.key}-${row.id}`}
                            className={`w-full max-w-[3rem] rounded-t-sm ${colour(row)} ${hover && hover !== row.id ? 'opacity-40' : ''}`}
                            style={{ height: `${pct}%` }}
                            title={`${row.label}: ${index.label} ${Math.round(score.value)} (${score.basis} · ${score.source}${score.note ? ` — ${score.note}` : ''})`}
                          />
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
              <div className="ml-7 mt-1 flex gap-2 pl-1">
                {withData.map(row => (
                  <div key={row.id} className="flex-1 min-w-0 text-micro text-content-tertiary" title={row.id}>
                    <span className={`block truncate ${hover === row.id ? 'text-content-primary' : ''}`}>{shortLabel(row)}</span>
                  </div>
                ))}
              </div>
              {without.length > 0 && (
                <p className="mt-2 text-micro italic text-content-tertiary" data-testid={`benchmark-missing-${index.key}`}>
                  * {without.map(shortLabel).join(', ')} {without.length === 1 ? 'has' : 'have'} no {index.label.toLowerCase()} data
                </p>
              )}
            </div>
          )
        })}
      </div>

      {hovered && (
        <div className="mt-3 inline-block rounded-md border border-line bg-surface-card px-3 py-2 text-caption shadow-sm" data-testid="benchmark-tooltip">
          <div className="mb-1 font-medium text-content-primary">{hovered.label}</div>
          <table className="font-mono text-content-secondary">
            <tbody>
              {BENCHMARK_INDICES.map(i => {
                const score = benchmarkScore(hovered, i.key as BenchmarkKey)
                return (
                  <tr key={i.key}>
                    <td className="pr-4">{i.label}</td>
                    <td className="text-right">{score ? Math.round(score.value) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-caption text-content-tertiary">
        Indices are declared by the provider's listing ({source ?? 'provider-listing'}: Artificial Analysis, third-party), on a 0-100
        scale. Not measured here; the quality page holds what was.
      </p>
    </div>
  )
}
