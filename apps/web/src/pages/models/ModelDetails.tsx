import { Badge } from '../../components/ui'
import type { CatalogFact, CatalogRow } from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { formatBytes } from '../../lib/pullStream'
import { fitLabel, fitSourceLabel } from '../../lib/modelFit'
import { BASIS_MARK, capabilityChips, tagLabel } from './catalogFormat'

/**
 * A row's whole story, laid out to be READ: facts in a two-column grid with
 * the value in front and the basis beneath it in small type, capability
 * and suitability chips with their notes, then sources, fit, probe and
 * upstream state. Nothing here is composed from two fields with different
 * lifetimes — each line names the one server field it came from.
 */
function factText(key: string, fact: CatalogFact): string {
  const v = fact.value
  const approx = fact.basis === 'inferred' ? '≈ ' : ''
  if (key === 'size_bytes' && typeof v === 'number') return approx + formatBytes(v)
  if ((key === 'price_prompt' || key === 'price_completion') && typeof v === 'number') {
    return `$${(v * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} per 1M`
  }
  if (key === 'context_length' && typeof v === 'number') return `${v.toLocaleString()} tokens`
  if (key === 'params_b' && typeof v === 'number') return `${v}B`
  if (key === 'vram_gb' && typeof v === 'number') return `${v} GB`
  if (key === 'downloads' && typeof v === 'number') return v.toLocaleString()
  if (key === 'digest' && typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}

const LABELS: Record<string, string> = {
  size_bytes: 'Size on disk',
  params_b: 'Parameters',
  quant: 'Quantisation',
  context_length: 'Context',
  family: 'Family',
  license: 'License',
  digest: 'Digest',
  modified_at: 'Modified',
  price_prompt: 'Price in',
  price_completion: 'Price out',
  max_output_tokens: 'Max output',
  vram_gb: 'VRAM',
  downloads: 'Downloads',
  likes: 'Likes',
  trending: 'Trending',
  last_modified: 'Last modified',
  gated: 'Gated',
  hugging_face_id: 'Hugging Face id',
  description: 'Description',
}

function Basis({ fact }: { fact: CatalogFact }) {
  return (
    <span className="block text-micro text-content-tertiary" title={fact.note ?? ''}>
      {fact.basis}
      {BASIS_MARK[fact.basis] ? ` ${BASIS_MARK[fact.basis]}` : ''} · {fact.source}
      {fact.at ? ` · ${fact.at.slice(0, 10)}` : ''}
      {fact.basis === 'inferred' && fact.note ? ` — ${fact.note}` : ''}
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-caption font-medium uppercase tracking-wider text-content-tertiary">{title}</h4>
      {children}
    </section>
  )
}

export function ModelDetails({ row }: { row: CatalogRow }) {
  const facts = Object.entries(row.facts).filter(([key]) => key !== 'description')
  const description = row.facts.description
  const caps = capabilityChips(row)
  const suits = Object.entries(row.suitability)
  return (
    <div className="space-y-6" data-testid={`model-details-${row.id}`}>
      <div>
        <p className="font-mono text-compact text-content-primary break-all">{row.id}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          <Badge size="sm" color="neutral">{row.kind}</Badge>
          {row.installed === true && <Badge size="sm" color="accent">installed</Badge>}
          {row.installed === false && <Badge size="sm" color="neutral">not installed</Badge>}
          <Badge size="sm" color="neutral">{row.provider}</Badge>
        </div>
        {row.note && <p className="mt-2 text-compact text-content-secondary">{row.note}</p>}
        {description && typeof description.value === 'string' && (
          <p className="mt-2 text-caption text-content-tertiary">{description.value}</p>
        )}
      </div>

      <Section title="Facts">
        {facts.length === 0 ? (
          <p className="text-caption text-content-tertiary">not stated</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {facts.map(([key, fact]) => (
              <div key={key} className="min-w-0">
                <dt className="text-caption text-content-tertiary">{LABELS[key] ?? key.replace(/_/g, ' ')}</dt>
                <dd className={`text-compact break-all ${fact.basis === 'inferred' ? 'text-warning' : 'text-content-primary'}`}>
                  {factText(key, fact)}
                  <Basis fact={fact} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      <Section title="Capabilities">
        {caps.length === 0 ? (
          <p className="text-caption text-content-tertiary">not stated</p>
        ) : (
          <ul className="space-y-1.5">
            {caps.map(chip => (
              <li key={chip.key} className="flex items-start gap-2 text-compact">
                <span
                  data-basis={chip.basis}
                  className={`inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-micro ${
                    !chip.value
                      ? 'border border-line text-content-tertiary line-through'
                      : chip.basis === 'inferred'
                        ? 'border border-dashed border-warning text-warning'
                        : 'bg-success-dim text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {chip.label}
                </span>
                <span className="text-caption text-content-tertiary">
                  {chip.basis}
                  {chip.note ? ` — ${chip.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Suitability">
        {suits.length === 0 ? (
          <p className="text-caption text-content-tertiary">not stated</p>
        ) : (
          <ul className="space-y-1.5">
            {suits.map(([key, fact]) => (
              <li key={key} className="text-compact">
                <span className={fact.basis === 'inferred' ? 'text-warning' : fact.basis === 'measured' ? 'text-blue-700 dark:text-blue-400' : 'text-content-primary'}>
                  {tagLabel(key.split(':')[0], fact)}
                </span>
                <Basis fact={fact} />
                {fact.basis !== 'inferred' && fact.note && <span className="block text-caption text-content-tertiary">{fact.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sources">
        <ul className="space-y-1">
          {row.sources.map(s => (
            <li key={s.key} className="text-caption">
              <span className="font-mono text-content-primary">{s.key}</span>
              {s.fetched_at ? <span className="text-content-tertiary"> · fetched {formatRelativeTime(s.fetched_at)}</span> : ''}
              {s.cached ? <span className="text-content-tertiary"> (cached)</span> : ''}
              {s.ok === false ? <span className="text-danger"> · {s.note ?? 'failed'}</span> : ''}
            </li>
          ))}
        </ul>
      </Section>

      {row.fit && (
        <Section title="Fit on this GPU">
          <p className="text-compact">
            {fitLabel(row.fit)}
            {fitSourceLabel(row.fit) ? <span className="text-content-tertiary"> · {fitSourceLabel(row.fit)}</span> : ''}
          </p>
        </Section>
      )}

      {row.probe && (
        <Section title="Last probe">
          <p className="text-compact">
            {row.probe.ok ? 'answered' : 'failed'}
            {row.probe.latency_ms !== null ? ` · ${row.probe.latency_ms} ms` : ''}
            {row.probe.vram_mb !== null ? ` · ${(row.probe.vram_mb / 1024).toFixed(1)} GB VRAM` : ''}
            <span className="text-content-tertiary"> · {formatRelativeTime(row.probe.created_at)}</span>
          </p>
        </Section>
      )}

      {row.drift && (
        <Section title="Upstream">
          <p className="text-compact">
            {row.drift.moved === true
              ? `has moved since you pulled (was ${row.drift.installed_digest?.slice(0, 19)}…, now ${row.drift.upstream_digest?.slice(0, 19)}…)`
              : row.drift.moved === false
                ? 'up to date'
                : (row.drift.note ?? 'unknown')}
            <span className="text-content-tertiary"> · checked {formatRelativeTime(row.drift.checked_at)}</span>
          </p>
        </Section>
      )}
    </div>
  )
}
