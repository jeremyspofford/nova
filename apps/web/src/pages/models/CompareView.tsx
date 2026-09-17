import { Badge } from '../../components/ui'
import type { CatalogFact, CatalogRow } from '../../lib/api'
import { formatBytes } from '../../lib/pullStream'
import { formatContext, formatParams } from '../../lib/modelFormat'
import { fitLabel, fitSourceLabel } from '../../lib/modelFit'
import { BASIS_MARK, capabilityChips, tagLabel } from './catalogFormat'

/**
 * Side by side: the same facts, one column per model, so a difference is a
 * glance and not a scroll. Numeric rows draw a bar scaled to the LARGEST
 * value among the compared models (never to an invented ceiling), and every
 * cell keeps its basis: inferred is dashed with a `?`, absent is "not
 * stated". Nothing here is a score of its own — it is the catalogue's rows
 * laid out sideways.
 */
const perMillion = (v: number) => `$${(v * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`

type NumericRow = { key: string; label: string; format: (v: number) => string; lowerIsBetter?: boolean }

const NUMERIC_ROWS: NumericRow[] = [
  { key: 'size_bytes', label: 'Size on disk', format: formatBytes, lowerIsBetter: true },
  { key: 'params_b', label: 'Parameters', format: v => `${formatParams(v)}` },
  { key: 'context_length', label: 'Context', format: v => formatContext({ context_length: v }) ?? String(v) },
  { key: 'price_prompt', label: 'Price in (per 1M)', format: perMillion, lowerIsBetter: true },
  { key: 'price_completion', label: 'Price out (per 1M)', format: perMillion, lowerIsBetter: true },
  { key: 'vram_gb', label: 'VRAM', format: v => `${v} GB`, lowerIsBetter: true },
  { key: 'downloads', label: 'Downloads', format: v => v.toLocaleString() },
]

function numeric(row: CatalogRow, key: string): CatalogFact<number> | null {
  const fact = row.facts[key]
  return fact && typeof fact.value === 'number' ? (fact as CatalogFact<number>) : null
}

function Bar({ value, max, inferred, lowerIsBetter }: { value: number; max: number; inferred: boolean; lowerIsBetter?: boolean }) {
  const pct = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0
  return (
    <div className="mt-1 h-1.5 w-full rounded-full bg-neutral-200/60 dark:bg-neutral-700/60" aria-hidden>
      <div
        className={`h-1.5 rounded-full ${inferred ? 'border border-dashed border-warning bg-transparent' : lowerIsBetter ? 'bg-info' : 'bg-accent'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function Basis({ fact }: { fact: CatalogFact }) {
  return (
    <span className="block text-micro text-content-tertiary" title={fact.note ?? ''}>
      {fact.basis}
      {BASIS_MARK[fact.basis] ? ` ${BASIS_MARK[fact.basis]}` : ''} · {fact.source}
      {fact.at ? ` · ${fact.at.slice(0, 10)}` : ''}
    </span>
  )
}

const NOT_STATED = <span className="text-content-tertiary">not stated</span>

export function CompareView({ rows }: { rows: CatalogRow[] }) {
  const suitabilityNames = Array.from(new Set(rows.flatMap(r => Object.keys(r.suitability).map(k => k.split(':')[0])))).sort()
  const capabilityNames = Array.from(new Set(rows.flatMap(r => Object.keys(r.capabilities)))).sort()
  const headerCell = 'sticky left-0 z-10 bg-surface-card pr-4 text-left align-top text-caption font-medium text-content-secondary'

  return (
    <div className="overflow-x-auto" data-testid="compare-view">
      <table className="w-full border-separate border-spacing-0 text-compact">
        <thead>
          <tr>
            <th className={`${headerCell} pb-3`}>&nbsp;</th>
            {rows.map(row => (
              <th key={row.id} className="min-w-[14rem] pb-3 pr-4 text-left align-top">
                <div className="font-medium text-content-primary">{row.label}</div>
                <div className="font-mono text-caption text-content-tertiary break-all">{row.id}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge size="sm" color="neutral">{row.kind}</Badge>
                  {row.installed === true && <Badge size="sm" color="accent">installed</Badge>}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NUMERIC_ROWS.map(spec => {
            const facts = rows.map(r => numeric(r, spec.key))
            if (facts.every(f => f === null)) return null
            const max = Math.max(...facts.map(f => f?.value ?? 0))
            return (
              <tr key={spec.key} className="border-t border-line">
                <th className={`${headerCell} py-2`}>{spec.label}</th>
                {rows.map((row, i) => {
                  const fact = facts[i]
                  return (
                    <td key={row.id} className="py-2 pr-4 align-top" data-testid={`compare-${spec.key}-${row.id}`}>
                      {fact ? (
                        <>
                          <span className={fact.basis === 'inferred' ? 'text-warning' : ''}>
                            {fact.basis === 'inferred' ? '≈ ' : ''}
                            {spec.format(fact.value)}
                          </span>
                          <Bar value={fact.value} max={max} inferred={fact.basis === 'inferred'} lowerIsBetter={spec.lowerIsBetter} />
                          <Basis fact={fact} />
                        </>
                      ) : (
                        NOT_STATED
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}

          {capabilityNames.length > 0 && (
            <tr>
              <th className={`${headerCell} py-2`}>Capabilities</th>
              {rows.map(row => {
                const chips = capabilityChips(row)
                return (
                  <td key={row.id} className="py-2 pr-4 align-top">
                    {chips.length === 0 ? NOT_STATED : (
                      <div className="flex flex-wrap gap-1">
                        {capabilityNames.map(name => {
                          const chip = chips.find(c => c.key === name)
                          if (!chip) return <span key={name} className="text-micro text-content-tertiary line-through">{name}</span>
                          return (
                            <span
                              key={name}
                              data-basis={chip.basis}
                              title={`${chip.basis}${chip.note ? ` — ${chip.note}` : ''}`}
                              className={`inline-flex h-5 items-center rounded-sm px-1.5 text-micro ${
                                !chip.value
                                  ? 'border border-line text-content-tertiary line-through'
                                  : chip.basis === 'inferred'
                                    ? 'border border-dashed border-warning text-warning'
                                    : 'bg-success-dim text-emerald-700 dark:text-emerald-400'
                              }`}
                            >
                              {chip.label}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          )}

          {suitabilityNames.map(name => {
            const perRow = rows.map(r =>
              Object.entries(r.suitability)
                .filter(([k]) => k === name || k.startsWith(`${name}:`))
                .map(([, f]) => f),
            )
            const numbers = perRow.flat().map(f => (typeof f.value === 'number' ? f.value : null)).filter((v): v is number => v !== null)
            const max = numbers.length ? Math.max(...numbers) : 0
            return (
              <tr key={name}>
                <th className={`${headerCell} py-2`}>{name.replace(/_/g, ' ')}</th>
                {rows.map((row, i) => (
                  <td key={row.id} className="py-2 pr-4 align-top" data-testid={`compare-${name}-${row.id}`}>
                    {perRow[i].length === 0 ? NOT_STATED : perRow[i].map((fact, j) => (
                      <div key={j} className="mb-1">
                        <span className={fact.basis === 'inferred' ? 'text-warning' : fact.basis === 'measured' ? 'text-blue-700 dark:text-blue-400' : ''}>
                          {tagLabel(name, fact)}
                        </span>
                        {typeof fact.value === 'number' && max > 0 && (
                          <Bar value={fact.value} max={max} inferred={fact.basis === 'inferred'} />
                        )}
                        <Basis fact={fact} />
                      </div>
                    ))}
                  </td>
                ))}
              </tr>
            )
          })}

          {rows.some(r => r.fit) && (
            <tr>
              <th className={`${headerCell} py-2`}>Fit on this GPU</th>
              {rows.map(row => (
                <td key={row.id} className="py-2 pr-4 align-top">
                  {row.fit ? (
                    <>
                      {fitLabel(row.fit)}
                      <span className="block text-micro text-content-tertiary">{fitSourceLabel(row.fit) ?? ''}</span>
                    </>
                  ) : (
                    <span className="text-content-tertiary">n/a</span>
                  )}
                </td>
              ))}
            </tr>
          )}

          {rows.some(r => r.probe) && (
            <tr>
              <th className={`${headerCell} py-2`}>Last probe</th>
              {rows.map(row => (
                <td key={row.id} className="py-2 pr-4 align-top">
                  {row.probe
                    ? `${row.probe.ok ? 'answered' : 'failed'}${row.probe.latency_ms !== null ? ` · ${row.probe.latency_ms} ms` : ''}`
                    : <span className="text-content-tertiary">never probed</span>}
                </td>
              ))}
            </tr>
          )}

          {rows.some(r => r.facts.license) && (
            <tr>
              <th className={`${headerCell} py-2`}>License</th>
              {rows.map(row => (
                <td key={row.id} className="py-2 pr-4 align-top">{row.facts.license ? String(row.facts.license.value) : NOT_STATED}</td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-3 text-caption text-content-tertiary">
        Bars are scaled to the largest value among these models. A dashed bar or a ≈ value is inferred, not stated.
        Third-party indices (OpenRouter's Artificial Analysis) are declared by that provider, not measured here.
      </p>
    </div>
  )
}
