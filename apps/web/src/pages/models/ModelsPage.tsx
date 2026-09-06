import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, Check, Download, Gauge, RefreshCw, Search } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import {
  Badge,
  Button,
  Checkbox,
  Input,
  ModelFitNotice,
  Popover,
  SearchInput,
  Select,
  Sheet,
  Skeleton,
  Table,
  Tabs,
  type TableColumn,
} from '../../components/ui'
import {
  getCatalog as apiGetCatalog,
  getHfRepo as apiGetHfRepo,
  getSettings as apiGetSettings,
  probeModel as apiProbeModel,
  pullModel as apiPullModel,
  putSetting as apiPutSetting,
  resolveModel as apiResolveModel,
  searchHf as apiSearchHf,
  settingValue,
  type CatalogRow,
  type HfPage,
  type PullOption,
  type ResolvedRef,
} from '../../lib/api'
import { formatContext, formatParams, formatPrice } from '../../lib/modelFormat'
import { applyPullLine, formatBytes, initialPullState, settlePull, type PullState } from '../../lib/pullStream'
import { formatRelativeTime } from '../activity/activityFormat'
import { useChatStore } from '../../stores/chat-store'
import {
  CAPABILITY_KEYS,
  EMPTY_FACETS,
  SUITABILITY_KEYS,
  applyFacets,
  capabilityChips,
  isCurrent,
  sortRows,
  suitabilityEntries,
  tagLabel,
  type CapabilityKey,
  type CatalogTab,
  type Facets,
  type SortKey,
} from './catalogFormat'
import { ModelDetails } from './ModelDetails'
import { PullControl } from './PullControl'

/**
 * Models (S10a): every model Nova can run or reach, from live sources, in
 * ONE list — installed local models (ollama's own /api/show facts), the
 * curated picks, Hugging Face GGUF repos (searched live), and every
 * registered provider's listing — filterable and sortable by facts.
 *
 * Every fact on the page came from a server-stated source and carries its
 * basis: plain = declared by the source; dashed `?` = inferred by a
 * heuristic and OFF in filters unless the owner ticks "include inferred";
 * ✓ = a dated human annotation; ● = measured by Nova. Absent = "not stated".
 * A row that lacks a fact a numeric facet is set on is hidden AND counted.
 *
 * Pulls: one at a time (mechanical). A pull is installed only when the
 * literal success line was seen AND the re-fetched catalogue lists it —
 * the stream's own word is never enough.
 *
 * `api` is the same dependency-injection seam every page uses.
 */
interface ModelsApi {
  getCatalog: typeof apiGetCatalog
  searchHf: typeof apiSearchHf
  getHfRepo: typeof apiGetHfRepo
  resolveModel: typeof apiResolveModel
  probeModel: typeof apiProbeModel
  pullModel: typeof apiPullModel
  putSetting: typeof apiPutSetting
  getSettings: typeof apiGetSettings
}

const DEFAULT_API: ModelsApi = {
  getCatalog: apiGetCatalog,
  searchHf: apiSearchHf,
  getHfRepo: apiGetHfRepo,
  resolveModel: apiResolveModel,
  probeModel: apiProbeModel,
  pullModel: apiPullModel,
  putSetting: apiPutSetting,
  getSettings: apiGetSettings,
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const bannerClass = 'rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger'

const TABS: { id: CatalogTab; label: string }[] = [
  { id: 'installed', label: 'Installed' },
  { id: 'available', label: 'Available' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'all', label: 'All' },
]

const HF_SORTS = [
  { value: 'downloads', label: 'most downloaded' },
  { value: 'likes', label: 'most liked' },
  { value: 'trendingScore', label: 'trending' },
  { value: 'lastModified', label: 'recently updated' },
]

/** `hf.co/org/repo` → [org, repo]; null for anything else. */
function hfParts(model: string): [string, string] | null {
  const m = /^hf\.co\/([^/:]+)\/([^/:]+)/.exec(model)
  return m ? [m[1], m[2]] : null
}

export function ModelsPage({ api = DEFAULT_API }: { api?: ModelsApi } = {}) {
  const { state: chatState, setModel } = useChatStore()
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof apiGetCatalog>> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [settingModel, setSettingModel] = useState<string>('')
  const [facets, setFacets] = useState<Facets>({ ...EMPTY_FACETS, tab: 'installed' })
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [details, setDetails] = useState<CatalogRow | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [probeNote, setProbeNote] = useState<Record<string, string>>({})

  // Hugging Face search (Available tab)
  const [hfQuery, setHfQuery] = useState('')
  const [hfSort, setHfSort] = useState('downloads')
  const [hfRows, setHfRows] = useState<CatalogRow[]>([])
  const [hfPage, setHfPage] = useState<HfPage | null>(null)
  const [hfError, setHfError] = useState<string | null>(null)
  const [hfLoading, setHfLoading] = useState(false)

  // Pull by name
  const [byName, setByName] = useState('')
  const [resolved, setResolved] = useState<ResolvedRef | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  // The one in-flight pull
  const [pull, setPull] = useState<PullState | null>(null)
  const pullAbort = useRef<AbortController | null>(null)
  const [quantOptions, setQuantOptions] = useState<Record<string, PullOption[] | 'loading' | string>>({})

  const chatModel = chatState.model ?? settingModel

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [cat, settings] = await Promise.all([api.getCatalog(), api.getSettings()])
      setCatalog(cat)
      setSettingModel(settingValue(settings, 'chat.model', ''))
    } catch (err) {
      setLoadError(reasonOf(err))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const search = useCallback(
    async (query: string, sortKey: string, cursor?: string) => {
      setHfLoading(true)
      setHfError(null)
      try {
        const page = await api.searchHf(query, sortKey, cursor)
        setHfPage(page)
        setHfRows(prev => (cursor ? [...prev, ...page.rows] : page.rows))
      } catch (err) {
        setHfError(reasonOf(err))
      } finally {
        setHfLoading(false)
      }
    },
    [api],
  )

  useEffect(() => {
    if (facets.tab !== 'available' && facets.tab !== 'all') return
    if (hfQuery.trim().length < 2) {
      setHfRows([])
      setHfPage(null)
      return
    }
    void search(hfQuery.trim(), hfSort)
  }, [hfQuery, hfSort, facets.tab, search])

  const allRows = useMemo(() => {
    const base = catalog?.rows ?? []
    const seen = new Set(base.map(r => r.id))
    return [...base, ...hfRows.filter(r => !seen.has(r.id))]
  }, [catalog, hfRows])

  const { rows: visible, hidden } = useMemo(() => applyFacets(allRows, facets), [allRows, facets])
  const sorted = useMemo(() => (sort ? sortRows(visible, sort.key, sort.dir) : visible), [visible, sort])

  const counts = useMemo(() => {
    const by = (tab: CatalogTab) => applyFacets(allRows, { ...EMPTY_FACETS, tab }).rows.length
    return { installed: by('installed'), available: by('available'), cloud: by('cloud'), all: allRows.length }
  }, [allRows])

  const use = async (row: CatalogRow) => {
    setSwitching(row.id)
    setActionError(null)
    try {
      await api.putSetting('chat.model', row.id)
      setModel(row.id)
      setSettingModel(row.id)
    } catch (err) {
      setActionError(`could not switch to ${row.id} — ${reasonOf(err)}`)
    } finally {
      setSwitching(null)
    }
  }

  const probe = async (row: CatalogRow) => {
    setProbing(row.id)
    setActionError(null)
    try {
      const result = await api.probeModel(row.id)
      setProbeNote(prev => ({
        ...prev,
        [row.id]: result.ok
          ? `${result.latency_ms ?? '?'} ms${result.vram_mb !== null ? ` · ${(result.vram_mb / 1024).toFixed(1)} GB` : ''}`
          : `probe failed — ${result.error ?? 'no reason given'}`,
      }))
      await load()
    } catch (err) {
      setActionError(`could not probe ${row.id} — ${reasonOf(err)}`)
    } finally {
      setProbing(null)
    }
  }

  const startPull = (target: string) => {
    if (pull !== null && !pull.done && !pull.error) {
      setActionError(`a pull of ${pull.target} is still running — one at a time`)
      return
    }
    pullAbort.current?.abort()
    const controller = new AbortController()
    pullAbort.current = controller
    let state = initialPullState(target)
    setPull(state)
    setActionError(null)
    const publish = (next: PullState) => {
      state = next
      setPull(next)
    }
    void (async () => {
      try {
        for await (const line of api.pullModel(target, controller.signal)) {
          if (controller.signal.aborted) return
          publish(applyPullLine(state, line))
          if (line.error) break
        }
      } catch (err) {
        if (controller.signal.aborted) return
        publish({ ...state, error: reasonOf(err) })
      }
      if (controller.signal.aborted) return
      const settled = settlePull(state)
      publish(settled)
      if (settled.done) {
        // Installed is what the catalogue says after the pull, never what
        // the stream said.
        await load()
      }
    })()
  }

  const loadQuants = async (row: CatalogRow) => {
    const parts = hfParts(row.model)
    if (!parts) return
    setQuantOptions(prev => ({ ...prev, [row.id]: 'loading' }))
    try {
      const detail = await api.getHfRepo(parts[0], parts[1])
      setQuantOptions(prev => ({ ...prev, [row.id]: detail.pull?.quants ?? [] }))
    } catch (err) {
      setQuantOptions(prev => ({ ...prev, [row.id]: `could not list quants — ${reasonOf(err)}` }))
    }
  }

  const resolve = async () => {
    const ref = byName.trim()
    if (!ref) return
    setResolving(true)
    setResolveError(null)
    setResolved(null)
    try {
      setResolved(await api.resolveModel(ref))
    } catch (err) {
      setResolveError(reasonOf(err))
    } finally {
      setResolving(false)
    }
  }

  const columns: TableColumn<CatalogRow>[] = [
    {
      key: 'name',
      header: 'Model',
      sortable: true,
      render: row => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-content-primary">{row.label}</span>
            {isCurrent(row, chatModel) && (
              <Badge size="sm" color="success">
                current
              </Badge>
            )}
            {row.installed === true && (
              <Badge size="sm" color="accent">
                installed
              </Badge>
            )}
            <Badge size="sm" color="neutral">
              {row.sources[0]?.key ?? row.provider}
            </Badge>
          </div>
          <div className="font-mono text-caption text-content-tertiary break-all">{row.id}</div>
        </div>
      ),
    },
    {
      key: 'size_bytes',
      header: 'Size',
      sortable: true,
      render: row => {
        const bytes = row.facts.size_bytes?.value
        const params = row.facts.params_b?.value
        if (typeof bytes === 'number') return formatBytes(bytes)
        if (typeof params === 'number') return `${formatParams(params)} params`
        return row.kind === 'hub' ? 'pick a quant' : <span className="text-content-tertiary">not stated</span>
      },
    },
    {
      key: 'context_length',
      header: 'Context',
      sortable: true,
      render: row => {
        const ctx = row.facts.context_length?.value
        return typeof ctx === 'number' ? formatContext({ context_length: ctx }) : <span className="text-content-tertiary">not stated</span>
      },
    },
    {
      key: 'price_prompt',
      header: 'Price',
      sortable: true,
      render: row => {
        const p = row.facts.price_prompt?.value
        const c = row.facts.price_completion?.value
        const text = formatPrice({
          pricing: {
            prompt: typeof p === 'number' ? p : undefined,
            completion: typeof c === 'number' ? c : undefined,
          },
        })
        return text ?? <span className="text-content-tertiary">{row.kind === 'cloud' ? 'not stated' : '—'}</span>
      },
    },
    {
      key: 'capabilities',
      header: 'Capabilities',
      render: row => {
        const chips = capabilityChips(row)
        if (chips.length === 0) return <span className="text-content-tertiary">not stated</span>
        return (
          <div className="flex flex-wrap gap-1">
            {chips.map(chip => (
              <span
                key={chip.key}
                title={`${chip.basis}${chip.note ? ` — ${chip.note}` : ''}`}
                data-basis={chip.basis}
                className={`inline-flex h-5 items-center rounded-sm px-1.5 text-micro ${
                  chip.basis === 'inferred'
                    ? 'border border-dashed border-amber-500 text-amber-700 dark:text-amber-400'
                    : 'bg-success-dim text-emerald-700 dark:text-emerald-400'
                }`}
              >
                {chip.label}
              </span>
            ))}
          </div>
        )
      },
    },
    {
      key: 'coding',
      header: 'Suitability',
      sortable: true,
      render: row => {
        const entries = Object.entries(row.suitability)
        if (entries.length === 0) return <span className="text-content-tertiary">not stated</span>
        return (
          <div className="flex flex-wrap gap-1">
            {entries.map(([key, fact]) => (
              <span
                key={key}
                title={`${fact.basis} — ${fact.source}${fact.note ? ` — ${fact.note}` : ''}`}
                data-basis={fact.basis}
                className={`inline-flex h-5 items-center rounded-sm px-1.5 text-micro ${
                  fact.basis === 'inferred'
                    ? 'border border-dashed border-amber-500 text-amber-700 dark:text-amber-400'
                    : fact.basis === 'measured'
                      ? 'bg-info-dim text-blue-700 dark:text-blue-400'
                      : 'bg-neutral-200/60 text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-300'
                }`}
              >
                {tagLabel(key.split(':')[0], fact)}
              </span>
            ))}
          </div>
        )
      },
    },
    {
      key: 'fit',
      header: 'Fit',
      render: row => (row.kind === 'local' ? <ModelFitNotice fit={row.fit ?? null} /> : null),
    },
    {
      key: 'actions',
      header: '',
      render: row => (
        <div className="flex flex-wrap items-center gap-1 justify-end">
          {row.actions.includes('use') && !isCurrent(row, chatModel) && (
            <Button size="sm" loading={switching === row.id} onClick={() => void use(row)} aria-label={`use ${row.id}`}>
              Use
            </Button>
          )}
          {row.actions.includes('pull') && row.kind === 'hub' && (
            <Popover
              trigger={
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Download size={12} />}
                  onClick={() => void loadQuants(row)}
                  aria-label={`pull ${row.id}`}
                >
                  Pull
                </Button>
              }
            >
              <QuantMenu options={quantOptions[row.id]} onPick={tag => startPull(`${row.model}:${tag}`)} />
            </Popover>
          )}
          {row.actions.includes('pull') && row.kind !== 'hub' && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Download size={12} />}
              onClick={() => startPull(row.model)}
              aria-label={`pull ${row.id}`}
            >
              Pull
            </Button>
          )}
          {row.actions.includes('probe') && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Gauge size={12} />}
              loading={probing === row.id}
              onClick={() => void probe(row)}
              aria-label={`probe ${row.id}`}
              title="run a 1-token completion and record how much VRAM the model really takes"
            >
              Probe
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDetails(row)} aria-label={`details ${row.id}`}>
            Details
          </Button>
          {probeNote[row.id] && <span className="text-caption text-content-tertiary">{probeNote[row.id]}</span>}
        </div>
      ),
    },
  ]

  const hiddenNotes = [
    hidden.noSize && `${hidden.noSize} rows have no stated size and are hidden by the size filter`,
    hidden.noParams && `${hidden.noParams} rows have no stated parameter count and are hidden by the params filter`,
    hidden.noContext && `${hidden.noContext} rows have no stated context and are hidden by the context filter`,
    hidden.noPrice && `${hidden.noPrice} rows have no stated price and are hidden by the price filter`,
  ].filter(Boolean) as string[]

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PageHeader
        title="Models"
        description="Every model Nova can run or reach, from live sources. Facts are labelled with where they came from; a dashed ? tag is inferred, not stated."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      {loadError && (
        <div role="alert" className={bannerClass}>
          Could not read the catalogue: {loadError}
        </div>
      )}
      {actionError && (
        <div role="alert" className={bannerClass}>
          {actionError}
        </div>
      )}

      {catalog && (
        <div className="flex flex-wrap gap-1.5" data-testid="catalog-sources">
          {catalog.sources.map(s => (
            <Badge key={s.key} size="sm" color={s.ok === false ? 'warning' : 'neutral'}>
              <span title={s.note ?? ''}>
                {s.key}
                {typeof s.rows === 'number' ? ` · ${s.rows}` : ''}
                {s.fetched_at ? ` · ${formatRelativeTime(s.fetched_at)}` : ''}
                {s.ok === false ? ` · ${s.note ?? 'failed'}` : ''}
              </span>
            </Badge>
          ))}
        </div>
      )}

      {pull && (
        <PullControl
          pull={pull}
          onCancel={() => {
            pullAbort.current?.abort()
            setPull(p => (p ? { ...p, error: 'cancelled' } : p))
          }}
          onDismiss={() => setPull(null)}
        />
      )}

      <Tabs
        tabs={TABS.map(t => ({ id: t.id, label: t.label, badge: counts[t.id] }))}
        activeTab={facets.tab}
        onChange={id => setFacets(f => ({ ...f, tab: id as CatalogTab }))}
      />

      <div className="flex flex-wrap items-end gap-2" data-testid="facets">
        <div className="min-w-[14rem] flex-1">
          <SearchInput value={facets.text} onChange={text => setFacets(f => ({ ...f, text }))} placeholder="filter by id, label, family" />
        </div>
        <Select
          label="Capability"
          value={facets.capability ?? ''}
          onChange={e => setFacets(f => ({ ...f, capability: (e.target.value || null) as CapabilityKey | null }))}
          items={[{ value: '', label: 'any' }, ...CAPABILITY_KEYS.map(k => ({ value: k, label: k }))]}
        />
        <Select
          label="Suitability"
          value={facets.suitability ?? ''}
          onChange={e => setFacets(f => ({ ...f, suitability: e.target.value || null }))}
          items={[{ value: '', label: 'any' }, ...SUITABILITY_KEYS.map(k => ({ value: k, label: k.replace('_', ' ') }))]}
        />
        <Checkbox
          label="include inferred (?)"
          checked={facets.includeInferred}
          onChange={checked => setFacets(f => ({ ...f, includeInferred: checked }))}
        />
        <Input
          label="Size ≤ GB"
          type="number"
          min={0}
          value={facets.maxSizeGb ?? ''}
          onChange={e => setFacets(f => ({ ...f, maxSizeGb: e.target.value === '' ? null : Number(e.target.value) }))}
        />
        <Input
          label="Params ≤ B"
          type="number"
          min={0}
          value={facets.maxParamsB ?? ''}
          onChange={e => setFacets(f => ({ ...f, maxParamsB: e.target.value === '' ? null : Number(e.target.value) }))}
        />
        <Input
          label="Context ≥ K"
          type="number"
          min={0}
          value={facets.minContextK ?? ''}
          onChange={e => setFacets(f => ({ ...f, minContextK: e.target.value === '' ? null : Number(e.target.value) }))}
        />
        <Input
          label="Price ≤ $/1M prompt"
          type="number"
          min={0}
          step="0.1"
          value={facets.maxPricePerM ?? ''}
          onChange={e => setFacets(f => ({ ...f, maxPricePerM: e.target.value === '' ? null : Number(e.target.value) }))}
        />
      </div>
      {hiddenNotes.length > 0 && (
        <p className="text-caption text-content-tertiary" data-testid="hidden-counts">
          {hiddenNotes.join(' · ')}
        </p>
      )}

      {(facets.tab === 'available' || facets.tab === 'all') && (
        <div className="grid gap-3 md:grid-cols-2" data-testid="available-tools">
          <div className="rounded-md border border-line p-3 space-y-2">
            <p className="text-compact font-medium">Search Hugging Face (GGUF)</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1">
                <SearchInput value={hfQuery} onChange={setHfQuery} placeholder="e.g. qwen coder" />
              </div>
              <Select value={hfSort} onChange={e => setHfSort(e.target.value)} items={HF_SORTS} label="Sort" />
            </div>
            {hfLoading && <Skeleton lines={2} />}
            {hfError && (
              <div role="alert" className={bannerClass}>
                {hfError}
              </div>
            )}
            {hfPage && (
              <p className="text-caption text-content-tertiary">
                {hfRows.length} repos from huggingface.co, fetched {formatRelativeTime(hfPage.fetched_at)}
                {hfPage.cached ? ' (cached)' : ''}
                {hfPage.budget ? ` · ${hfPage.budget.remaining} anonymous requests left this window` : ''}
                {hfPage.next_cursor && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-2"
                    onClick={() => void search(hfQuery.trim(), hfSort, hfPage.next_cursor ?? undefined)}
                  >
                    Load more
                  </Button>
                )}
              </p>
            )}
          </div>
          <div className="rounded-md border border-line p-3 space-y-2">
            <p className="text-compact font-medium">Pull by name</p>
            <p className="text-caption text-content-tertiary">
              Ollama's library has no search API — type a name:tag from ollama.com (or hf.co/org/repo[:quant]) and it is
              resolved live before pulling.
            </p>
            <form
              className="flex items-end gap-2"
              onSubmit={e => {
                e.preventDefault()
                void resolve()
              }}
            >
              <Input
                label="Model"
                value={byName}
                onChange={e => setByName(e.target.value)}
                placeholder="qwen3:4b"
              />
              <Button type="submit" size="sm" variant="secondary" icon={<Search size={12} />} loading={resolving} disabled={!byName.trim()}>
                Resolve
              </Button>
            </form>
            {resolveError && (
              <div role="alert" className={bannerClass}>
                {resolveError}
              </div>
            )}
            {resolved && (
              <div className="text-caption" data-testid="resolved-preview">
                <span className="font-mono">{resolved.model}</span>
                {' — '}
                {Object.entries(resolved.facts)
                  .map(([k, f]) => {
                    if (k === 'size_bytes' && typeof f.value === 'number') return formatBytes(f.value)
                    if (k === 'params_b' && typeof f.value === 'number') return `${formatParams(f.value)} params`
                    return `${k.replace(/_/g, ' ')} ${String(f.value)}`
                  })
                  .join(' · ')}
                <span className="text-content-tertiary"> ({resolved.source})</span>
                {resolved.note && <span className="text-content-tertiary"> — {resolved.note}</span>}
                {resolved.pull?.quants?.length ? (
                  <span className="ml-2 inline-flex flex-wrap gap-1">
                    {resolved.pull.quants.map(q => (
                      <Button key={q.tag} size="sm" variant={q.is_default ? 'primary' : 'ghost'} onClick={() => startPull(`${resolved.pull!.target}:${q.tag}`)}>
                        {q.tag} · {formatBytes(q.size_bytes)}
                      </Button>
                    ))}
                  </span>
                ) : (
                  <Button size="sm" className="ml-2" icon={<Download size={12} />} onClick={() => startPull(resolved.model)}>
                    Pull
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {catalog === null && !loadError ? (
        <Skeleton lines={6} />
      ) : (
        <Table<CatalogRow>
          columns={columns}
          data={sorted as unknown as CatalogRow[]}
          onSort={(key, dir) => setSort({ key: key as SortKey, dir })}
          emptyMessage={
            allRows.length === 0
              ? 'nothing reachable — no local models installed and no provider answered'
              : 'no models match the current filters'
          }
        />
      )}

      <Sheet open={details !== null} onClose={() => setDetails(null)} title={details?.label ?? ''}>
        {details && <ModelDetails row={details} />}
      </Sheet>
    </div>
  )
}

function QuantMenu({ options, onPick }: { options: PullOption[] | 'loading' | string | undefined; onPick: (tag: string) => void }) {
  if (options === undefined || options === 'loading') return <Skeleton lines={2} />
  if (typeof options === 'string') return <p className="text-caption text-danger p-2">{options}</p>
  if (options.length === 0) return <p className="text-caption text-content-tertiary p-2">this repo lists no GGUF files</p>
  return (
    <ul className="min-w-[16rem] divide-y divide-line" data-testid="quant-menu">
      {options.map(o => (
        <li key={o.tag}>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption hover:bg-surface-elevated"
            onClick={() => onPick(o.tag)}
          >
            <span className="font-mono">{o.tag}</span>
            <span className="text-content-tertiary">{formatBytes(o.size_bytes)}</span>
            {o.mmproj_bytes ? <span className="text-content-tertiary">+ {formatBytes(o.mmproj_bytes)} projector</span> : null}
            {o.is_default && (
              <Badge size="sm" color="accent">
                <Check size={10} /> default
              </Badge>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

export const MODELS_NAV = { to: '/models', label: 'Models', icon: Boxes }
