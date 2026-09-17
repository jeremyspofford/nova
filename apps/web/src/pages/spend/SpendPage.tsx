import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Coins, RefreshCw } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, Input, Metric, ProgressBar, Table, Tabs, type TableColumn } from '../../components/ui'
import { InlineSave, type SaveMessage } from '../settings/shared'
import {
  deleteOwnerPrice as apiDeleteOwnerPrice,
  getSpend as apiGetSpend,
  getSpendCaps as apiGetSpendCaps,
  getSpendPrices as apiGetSpendPrices,
  putOwnerPrice as apiPutOwnerPrice,
  putSpendCap as apiPutSpendCap,
  type SpendCap,
  type SpendPrice,
  type SpendReport,
  type SpendRollup,
  type SpendWindow,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { BASIS_WORDS, capPercent, dayBars, gpuMinutes, modelKey, purposeLabel, tokens, usd, type ChartMeasure } from './spendFormat'

/**
 * Where the money goes, from the gateway's ledger: one row per model call,
 * each priced on a stated basis or not at all. The page adds nothing of its
 * own — it shows what was recorded and NAMES what was not: unmetered calls,
 * unpriced models, refusals, ledger rows that failed to write. Local GPU
 * time is its own unit, never dollars. Caps are checked against recorded
 * spend before a call is made; a call in flight is not yet counted, and the
 * page says so.
 */
export interface SpendApi {
  getSpend: typeof apiGetSpend
  getSpendCaps: typeof apiGetSpendCaps
  putSpendCap: typeof apiPutSpendCap
  getSpendPrices: typeof apiGetSpendPrices
  putOwnerPrice: typeof apiPutOwnerPrice
  deleteOwnerPrice: typeof apiDeleteOwnerPrice
}

const DEFAULT_API: SpendApi = {
  getSpend: apiGetSpend,
  getSpendCaps: apiGetSpendCaps,
  putSpendCap: apiPutSpendCap,
  getSpendPrices: apiGetSpendPrices,
  putOwnerPrice: apiPutOwnerPrice,
  deleteOwnerPrice: apiDeleteOwnerPrice,
}

const WINDOWS: { id: SpendWindow; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
]

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function SpendPage({ api = DEFAULT_API }: { api?: SpendApi } = {}) {
  const [window, setWindow] = useState<SpendWindow>('month')
  const [report, setReport] = useState<SpendReport | null>(null)
  const [caps, setCaps] = useState<SpendCap[]>([])
  const [prices, setPrices] = useState<SpendPrice[]>([])
  const [error, setError] = useState<string | null>(null)
  // Dollars by default (this is the Spend page); calls so the local models,
  // which never cost dollars, are visible in the same picture.
  const [measure, setMeasure] = useState<ChartMeasure>('usd')

  const load = useCallback(async () => {
    setError(null)
    try {
      const [r, c, p] = await Promise.all([api.getSpend(window), api.getSpendCaps(), api.getSpendPrices()])
      setReport(r)
      setCaps(c.caps)
      setPrices(p.prices)
    } catch (err) {
      setError(reasonOf(err))
    }
  }, [api, window])

  useEffect(() => {
    void load()
  }, [load])

  const totals = report?.totals
  const bars = useMemo(() => (report ? dayBars(report) : []), [report])
  const key = useMemo(() => modelKey(bars, measure), [bars, measure])
  const colourOf = (model: string) => key.find(k => k.key === model)?.colour ?? 'bg-neutral-400'
  const dayTotal = (b: (typeof bars)[number]) => (measure === 'usd' ? b.usd : b.calls)
  const maxDay = Math.max(0, ...bars.map(dayTotal))
  const cloudProviders = (report?.by_provider ?? []).filter(p => !p.local)
  const localProviders = (report?.by_provider ?? []).filter(p => p.local)
  const totalCap = caps.find(c => c.provider === '*') ?? null
  const windowLabel = WINDOWS.find(w => w.id === window)?.label.toLowerCase() ?? window

  return (
    <div className="space-y-6" data-testid="spend-page">
      <PageHeader
        title="Spend"
        description="What Nova's model calls cost, from the gateway's ledger. Every dollar names how it was priced; local GPU time is minutes, not money; what could not be measured is counted, never zeroed."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      {error && (
        <div role="alert" className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger">
          {error}
        </div>
      )}

      <Tabs tabs={WINDOWS.map(w => ({ id: w.id, label: w.label }))} activeTab={window} onChange={id => setWindow(id as SpendWindow)} />

      {report && totals && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="spend-tiles">
            <Metric
              label={`Spent (${windowLabel})`}
              value={usd(totals.usd)}
              icon={<Coins size={16} />}
              tooltip={
                Object.keys(totals.usd_by_basis).length
                  ? Object.entries(totals.usd_by_basis)
                      .map(([basis, v]) => `${usd(v, 4)} ${BASIS_WORDS[basis] ?? basis}`)
                      .join(' · ')
                  : 'no priced calls in this window'
              }
            />
            <Metric
              label="This month vs cap"
              value={totalCap?.monthly_usd != null ? `${usd(totals.month_usd)} / ${usd(totalCap.monthly_usd)}` : usd(totals.month_usd)}
              tooltip={totalCap?.monthly_usd != null ? 'the total cap across every cloud provider' : 'no total cap set'}
            />
            <Metric label="Local GPU time" value={gpuMinutes(totals.gpu_seconds)} tooltip="wall time of local calls, model load included — not money" />
            <Metric label="Calls" value={totals.calls} tooltip={`${totals.probes} probes and ${totals.refusals} refusals besides`} />
          </div>

          {(totals.unmetered > 0 || totals.refusals > 0 || totals.ledger_write_failures > 0 || report.unpriced.length > 0) && (
            <div className="rounded-md border border-warning/40 bg-warning/5 px-4 py-3 text-compact" data-testid="spend-gaps">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle size={14} className="text-warning" /> What the totals leave out
              </div>
              <ul className="mt-1 list-disc pl-5 text-caption text-content-secondary">
                {totals.unmetered > 0 && (
                  <li>{totals.unmetered} call(s) were unmetered — the provider stated no token counts, so they carry no dollars. The totals are a floor.</li>
                )}
                {report.unpriced.length > 0 && (
                  <li>
                    Metered but unpriced (no listed, curated or entered price):{' '}
                    {report.unpriced.map(u => `${u.provider}:${u.model} (${u.calls})`).join(', ')}. Enter a price below.
                  </li>
                )}
                {totals.refusals > 0 && <li>{totals.refusals} call(s) were refused by a provider — recorded, no cost.</li>}
                {totals.ledger_write_failures > 0 && (
                  <li>{totals.ledger_write_failures} call(s) since the gateway started could not be recorded at all.</li>
                )}
              </ul>
            </div>
          )}

          <p className="text-caption text-content-tertiary">{totals.in_flight_note}.</p>

          <section>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h3 className="text-compact font-medium text-content-primary">By day, by model</h3>
              <div className="flex gap-1" role="group" aria-label="chart measure">
                <Button size="sm" variant={measure === 'usd' ? 'primary' : 'ghost'} onClick={() => setMeasure('usd')} aria-pressed={measure === 'usd'}>
                  Dollars
                </Button>
                <Button size="sm" variant={measure === 'calls' ? 'primary' : 'ghost'} onClick={() => setMeasure('calls')} aria-pressed={measure === 'calls'}>
                  Calls
                </Button>
              </div>
              {measure === 'usd' && key.some(k => k.local) && (
                <span className="text-caption text-content-tertiary">local models cost no dollars — switch to Calls to see them</span>
              )}
            </div>
            <div className="flex h-40 items-end gap-1 border-b border-l border-line pl-1" data-testid="spend-days">
              {bars.map(b => {
                const total = dayTotal(b)
                const height = maxDay > 0 ? Math.max(total > 0 ? 3 : 0, Math.round((total / maxDay) * 100)) : 0
                return (
                  <div
                    key={b.day}
                    className="flex h-full flex-1 flex-col items-center justify-end"
                    title={`${b.day}: ${usd(b.usd, 4)}, ${b.calls} calls, ${gpuMinutes(b.gpu_seconds)} local`}
                  >
                    <div data-testid={`spend-day-${b.day}`} className="flex w-full max-w-[2rem] flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${height}%` }}>
                      {b.models
                        .map(m => ({ ...m, share: measure === 'usd' ? m.usd : m.calls }))
                        .filter(m => m.share > 0)
                        .map(m => (
                          <div
                            key={m.key}
                            data-testid={`spend-day-${b.day}-${m.key}`}
                            data-model={m.key}
                            className={`w-full ${colourOf(m.key)}`}
                            style={{ height: `${total > 0 ? (m.share / total) * 100 : 0}%` }}
                            title={`${m.key}: ${measure === 'usd' ? usd(m.usd, 4) : `${m.calls} calls`}${m.local ? ` (local, ${gpuMinutes(m.gpu_seconds)})` : ''}`}
                          />
                        ))}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="mt-1 flex gap-1 pl-1 text-micro text-content-tertiary">
              {bars.map((b, i) => (
                <div key={b.day} className="flex-1 truncate text-center">
                  {i === 0 || i === bars.length - 1 || bars.length <= 8 ? b.day.slice(5) : ''}
                </div>
              ))}
            </div>
            {key.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption" data-testid="spend-key">
                {key.map(k => (
                  <li key={k.key} className="inline-flex items-center gap-1.5" data-testid={`spend-key-${k.key}`}>
                    <span className={`inline-block h-2.5 w-2.5 rounded-sm ${k.colour}`} aria-hidden />
                    <span className="font-mono">{k.key}</span>
                    <span className="text-content-tertiary">
                      {measure === 'usd' ? (k.local ? 'local, no dollars' : usd(k.total, 4)) : `${k.total} calls`}
                    </span>
                  </li>
                ))}
                {key.length > 8 && <li className="text-content-tertiary">more than eight models: colours repeat</li>}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-compact font-medium text-content-primary">By provider, with caps</h3>
            <div className="space-y-3">
              {cloudProviders.map(p => {
                const pct = capPercent(p.month_usd, p.cap_usd)
                return (
                  <div key={p.provider} className="rounded-md border border-line px-4 py-3" data-testid={`spend-provider-${p.provider}`}>
                    <div className="flex flex-wrap items-center gap-2 text-compact">
                      <span className="font-medium">{p.provider}</span>
                      <span>{usd(p.usd, 4)} in this window</span>
                      <span className="text-content-tertiary">
                        · {p.calls} calls{p.unmetered ? `, ${p.unmetered} unmetered` : ''}{p.refusals ? `, ${p.refusals} refused` : ''}
                      </span>
                      <span className="ml-auto text-caption text-content-tertiary">
                        {p.cap_usd != null ? `${usd(p.month_usd)} of ${usd(p.cap_usd)} this month` : `${usd(p.month_usd)} this month, no cap`}
                      </span>
                    </div>
                    {pct !== null && <ProgressBar value={pct} className="mt-2" />}
                    <CapEditor
                      provider={p.provider}
                      cap={caps.find(c => c.provider === p.provider) ?? null}
                      onSave={async v => {
                        await api.putSpendCap(p.provider, v)
                        await load()
                      }}
                    />
                  </div>
                )
              })}
              {localProviders.map(p => (
                <div key={p.provider} className="rounded-md border border-line px-4 py-3 text-compact" data-testid={`spend-provider-${p.provider}`}>
                  <span className="font-medium">{p.provider}</span>{' '}
                  <Badge size="sm" color="neutral">local</Badge>{' '}
                  <span>{gpuMinutes(p.gpu_seconds)} of GPU time over {p.calls} calls — not money</span>
                </div>
              ))}
              <div className="rounded-md border border-line px-4 py-3" data-testid="spend-provider-total">
                <div className="text-compact font-medium">All cloud providers</div>
                <CapEditor
                  provider="*"
                  cap={totalCap}
                  onSave={async v => {
                    await api.putSpendCap('*', v)
                    await load()
                  }}
                />
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <RollupTable title="By model" rows={report.by_model} label={r => r.key ?? 'unknown'} testid="spend-by-model" />
            <RollupTable title="By purpose" rows={report.by_purpose} label={r => purposeLabel(r.key)} testid="spend-by-purpose" />
            <RollupTable
              title="By person"
              rows={report.by_person}
              label={r => r.person?.name ?? (r.key ? '(no longer exists)' : 'no person')}
              testid="spend-by-person"
            />
            <RollupTable title="By role" rows={report.by_role} label={r => r.key ?? 'no role'} testid="spend-by-role" />
          </section>

          {report.recent_refusals.length > 0 && (
            <section>
              <h3 className="mb-2 text-compact font-medium text-content-primary">Recent refusals</h3>
              <ul className="space-y-1 text-caption">
                {report.recent_refusals.map((r, i) => (
                  <li key={i}>
                    <span className="text-content-tertiary">{formatRelativeTime(r.at)}</span> · {r.provider}:{r.model} · {r.status} ·{' '}
                    {purposeLabel(r.purpose)}
                    {r.error ? <span className="text-danger"> — {r.error}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <PriceEditor
            prices={prices}
            unpriced={report.unpriced}
            onSave={async (provider, model, prompt, completion) => {
              await api.putOwnerPrice(provider, model, prompt, completion)
              await load()
            }}
            onDelete={async (provider, model) => {
              await api.deleteOwnerPrice(provider, model)
              await load()
            }}
          />
        </>
      )}
    </div>
  )
}

function RollupTable({ title, rows, label, testid }: { title: string; rows: SpendRollup[]; label: (r: SpendRollup) => string; testid: string }) {
  const columns: TableColumn<SpendRollup>[] = [
    { key: 'key', header: title.replace('By ', ''), render: r => <span className="font-mono text-caption break-all">{label(r)}</span> },
    {
      key: 'usd',
      header: 'Cost',
      render: r => (r.local ? <span className="text-content-tertiary">{gpuMinutes(r.gpu_seconds)} local</span> : usd(r.usd, 4)),
    },
    { key: 'calls', header: 'Calls', render: r => `${r.calls}${r.unmetered ? ` (${r.unmetered} unmetered)` : ''}` },
    { key: 'tokens', header: 'Tokens in / out', render: r => `${tokens(r.prompt_tokens)} / ${tokens(r.completion_tokens)}` },
  ]
  return (
    <div data-testid={testid}>
      <h3 className="mb-2 text-compact font-medium text-content-primary">{title}</h3>
      {rows.length === 0 ? <p className="text-caption text-content-tertiary">nothing in this window</p> : <Table columns={columns} data={rows} />}
    </div>
  )
}

function CapEditor({ provider, cap, onSave }: { provider: string; cap: SpendCap | null; onSave: (value: number | null) => Promise<void> }) {
  const current = cap?.monthly_usd ?? null
  const [draft, setDraft] = useState<string>(current === null ? '' : String(current))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<SaveMessage | null>(null)
  useEffect(() => {
    setDraft(current === null ? '' : String(current))
  }, [current])
  const parsed = draft.trim() === '' ? null : Number(draft)
  const valid = parsed === null || (!Number.isNaN(parsed) && parsed >= 0)
  const dirty = valid && parsed !== current
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-caption">
      <label className="text-content-tertiary" htmlFor={`cap-${provider}`}>
        Monthly cap (USD)
      </label>
      <Input id={`cap-${provider}`} value={draft} onChange={e => setDraft(e.target.value)} placeholder="none" className="w-28" aria-label={`monthly cap ${provider}`} />
      <InlineSave
        dirty={dirty}
        saving={saving}
        onSave={async () => {
          setSaving(true)
          setMessage(null)
          try {
            await onSave(parsed)
            setMessage({ kind: 'ok', text: parsed === null ? 'cap removed' : `cap set to ${usd(parsed)}` })
          } catch (err) {
            setMessage({ kind: 'err', text: reasonOf(err) })
          } finally {
            setSaving(false)
          }
        }}
        onReset={() => setDraft(current === null ? '' : String(current))}
        message={message}
      />
      <span className="text-content-tertiary">past the cap, calls fall back to the next model in the role's chain and say so</span>
    </div>
  )
}

function PriceEditor({
  prices,
  unpriced,
  onSave,
  onDelete,
}: {
  prices: SpendPrice[]
  unpriced: SpendReport['unpriced']
  onSave: (provider: string, model: string, prompt: number, completion: number) => Promise<void>
  onDelete: (provider: string, model: string) => Promise<void>
}) {
  const [target, setTarget] = useState<string>(unpriced[0] ? `${unpriced[0].provider}:${unpriced[0].model}` : '')
  const [promptPerM, setPromptPerM] = useState('')
  const [completionPerM, setCompletionPerM] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const owner = prices.filter(p => p.basis === 'owner')
  const [provider, ...rest] = target.split(':')
  const model = rest.join(':')
  const canSave = Boolean(provider && model) && promptPerM !== '' && completionPerM !== '' && !Number.isNaN(Number(promptPerM)) && !Number.isNaN(Number(completionPerM))
  return (
    <section data-testid="spend-prices">
      <h3 className="mb-2 text-compact font-medium text-content-primary">Prices</h3>
      <p className="mb-2 text-caption text-content-tertiary">
        A call is priced from the provider's own reported cost, else the price you enter here, else the provider's listing, else the dated curated list. Enter a price only for a
        model nothing else prices.
      </p>
      {owner.length > 0 && (
        <ul className="mb-3 space-y-1 text-caption">
          {owner.map(p => (
            <li key={`${p.provider}:${p.model}`} className="flex items-center gap-2">
              <span className="font-mono">
                {p.provider}:{p.model}
              </span>
              <span>
                {usd(p.prompt_usd_per_token * 1e6)} in / {usd(p.completion_usd_per_token * 1e6)} out per 1M (yours, {p.verified_at.slice(0, 10)})
              </span>
              <Button size="sm" variant="ghost" onClick={() => void onDelete(p.provider, p.model)} aria-label={`remove price ${p.provider}:${p.model}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2 text-caption">
        <label className="flex flex-col gap-1">
          <span className="text-content-tertiary">provider:model</span>
          <Input value={target} onChange={e => setTarget(e.target.value)} placeholder="anthropic:claude-opus-5" className="w-64" aria-label="price target" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-content-tertiary">$ per 1M in</span>
          <Input value={promptPerM} onChange={e => setPromptPerM(e.target.value)} className="w-24" aria-label="price per million prompt tokens" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-content-tertiary">$ per 1M out</span>
          <Input value={completionPerM} onChange={e => setCompletionPerM(e.target.value)} className="w-24" aria-label="price per million completion tokens" />
        </label>
        <Button
          size="sm"
          disabled={!canSave}
          onClick={async () => {
            setMessage(null)
            try {
              await onSave(provider, model, Number(promptPerM) / 1e6, Number(completionPerM) / 1e6)
              setMessage(`price saved for ${provider}:${model}`)
            } catch (err) {
              setMessage(reasonOf(err))
            }
          }}
          aria-label="save price"
        >
          Save price
        </Button>
        {message && <span className="text-content-tertiary">{message}</span>}
      </div>
    </section>
  )
}
