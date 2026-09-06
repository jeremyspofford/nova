import { Badge } from '../../components/ui'
import type { CatalogFact, CatalogRow } from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { formatBytes } from '../../lib/pullStream'
import { fitLabel, fitSourceLabel } from '../../lib/modelFit'
import { BASIS_MARK, tagLabel } from './catalogFormat'

/**
 * A row's whole story: every fact with its basis and the source that stated
 * it, the sources with their fetch times, license, probe, drift. Nothing
 * here is composed from two fields with different lifetimes — each line
 * names the one server field it came from.
 */
function factText(key: string, fact: CatalogFact): string {
  const v = fact.value
  if (key === 'size_bytes' && typeof v === 'number') return formatBytes(v)
  if ((key === 'price_prompt' || key === 'price_completion') && typeof v === 'number') {
    return `$${(v * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} per 1M`
  }
  if (key === 'context_length' && typeof v === 'number') return `${v.toLocaleString()} tokens`
  if (key === 'params_b' && typeof v === 'number') return `${v}B params`
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}

export function ModelDetails({ row }: { row: CatalogRow }) {
  const facts = Object.entries(row.facts)
  const caps = Object.entries(row.capabilities)
  const suits = Object.entries(row.suitability)
  return (
    <div className="space-y-4 text-compact" data-testid={`model-details-${row.id}`}>
      <div>
        <p className="font-mono text-content-primary break-all">{row.id}</p>
        <p className="text-caption text-content-tertiary">
          {row.kind}
          {row.installed === true ? ' · installed' : row.installed === false ? ' · not installed' : ''}
        </p>
      </div>

      <section>
        <h4 className="text-caption uppercase tracking-wider text-content-tertiary mb-1">Sources</h4>
        <ul className="space-y-0.5">
          {row.sources.map(s => (
            <li key={s.key} className="text-caption">
              <span className="font-mono">{s.key}</span>
              {s.fetched_at ? ` · fetched ${formatRelativeTime(s.fetched_at)}` : ''}
              {s.cached ? ' (cached)' : ''}
              {s.ok === false ? ` · ${s.note ?? 'failed'}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-caption uppercase tracking-wider text-content-tertiary mb-1">Facts</h4>
        {facts.length === 0 ? (
          <p className="text-caption text-content-tertiary">not stated</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {facts.map(([key, fact]) => (
              <div key={key} className="contents">
                <dt className="text-caption text-content-tertiary">{key.replace(/_/g, ' ')}</dt>
                <dd className="text-caption">
                  {factText(key, fact)}{' '}
                  <span className="text-content-tertiary" title={fact.note ?? ''}>
                    ({fact.basis}
                    {BASIS_MARK[fact.basis] ? ` ${BASIS_MARK[fact.basis]}` : ''} · {fact.source}
                    {fact.at ? ` · ${fact.at.slice(0, 10)}` : ''})
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section>
        <h4 className="text-caption uppercase tracking-wider text-content-tertiary mb-1">Capabilities</h4>
        {caps.length === 0 ? (
          <p className="text-caption text-content-tertiary">not stated</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {caps.map(([key, fact]) => (
              <Badge
                key={key}
                size="sm"
                color={fact.value ? (fact.basis === 'inferred' ? 'warning' : 'success') : 'neutral'}
                dot={false}
              >
                <span title={`${fact.basis} · ${fact.source}${fact.note ? ` · ${fact.note}` : ''}`}>
                  {key}
                  {fact.basis === 'inferred' ? '?' : ''}
                  {!fact.value ? ' no' : ''}
                </span>
              </Badge>
            ))}
          </div>
        )}
      </section>

      <section>
        <h4 className="text-caption uppercase tracking-wider text-content-tertiary mb-1">Suitability</h4>
        {suits.length === 0 ? (
          <p className="text-caption text-content-tertiary">not stated</p>
        ) : (
          <ul className="space-y-0.5">
            {suits.map(([key, fact]) => (
              <li key={key} className="text-caption">
                {tagLabel(key.split(':')[0], fact)}{' '}
                <span className="text-content-tertiary">
                  ({fact.basis} · {fact.source}
                  {fact.note ? ` · ${fact.note}` : ''})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {row.fit && (
        <section>
          <h4 className="text-caption uppercase tracking-wider text-content-tertiary mb-1">Fit</h4>
          <p className="text-caption">
            {fitLabel(row.fit)}
            {fitSourceLabel(row.fit) ? ` · ${fitSourceLabel(row.fit)}` : ''}
          </p>
        </section>
      )}

      {row.probe && (
        <section>
          <h4 className="text-caption uppercase tracking-wider text-content-tertiary mb-1">Last probe</h4>
          <p className="text-caption">
            {row.probe.ok ? 'answered' : 'failed'}
            {row.probe.latency_ms !== null ? ` · ${row.probe.latency_ms} ms` : ''}
            {row.probe.vram_mb !== null ? ` · ${(row.probe.vram_mb / 1024).toFixed(1)} GB VRAM` : ''}
            {` · ${formatRelativeTime(row.probe.created_at)}`}
          </p>
        </section>
      )}

      {row.drift && (
        <section>
          <h4 className="text-caption uppercase tracking-wider text-content-tertiary mb-1">Upstream</h4>
          <p className="text-caption">
            {row.drift.moved === true
              ? `has moved since you pulled (was ${row.drift.installed_digest?.slice(0, 19)}…, now ${row.drift.upstream_digest?.slice(0, 19)}…)`
              : row.drift.moved === false
                ? 'up to date'
                : (row.drift.note ?? 'unknown')}
            {` · checked ${formatRelativeTime(row.drift.checked_at)}`}
          </p>
        </section>
      )}
    </div>
  )
}
