import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Boxes, Check, Columns3, Download, Gauge, RefreshCw, Search, Trash2 } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Input,
  Modal,
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
  checkDrift as apiCheckDrift,
  removeModel as apiRemoveModel,
  probeModel as apiProbeModel,
  pullModel as apiPullModel,
  putSetting as apiPutSetting,
  resolveModel as apiResolveModel,
  searchHf as apiSearchHf,
  settingValue,
  type Catalog,
  type CatalogAction,
  type CatalogRow,
  type HfPage,
  type PullOption,
  type DriftResult,
  type ResolvedRef,
} from '../../lib/api'
import { formatContext, formatParams, formatPrice } from '../../lib/modelFormat'
import { applyPullLine, formatBytes, initialPullState, settlePull, type PullState } from '../../lib/pullStream'
import { Link } from 'react-router-dom'
import { formatRelativeTime } from '../activity/activityFormat'
import { useChatStore } from '../../stores/chat-store'
import {
  BENCHMARK_INDICES,
  CAPABILITY_KEYS,
  EMPTY_FACETS,
  SUITABILITY_KEYS,
  applyFacets,
  benchmarkScore,
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
import { CompareView } from './CompareView'
import { BenchmarkCharts } from './BenchmarkCharts'
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
  checkDrift: typeof apiCheckDrift
  removeModel: typeof apiRemoveModel
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
  checkDrift: apiCheckDrift,
  removeModel: apiRemoveModel,
  pullModel: apiPullModel,
  putSetting: apiPutSetting,
  getSettings: apiGetSettings,
}

const COMPARE_MAX = 5
const BENCH_MAX = 12
const SHORT_INDEX: Record<string, string> = { intelligence: 'Int', coding: 'Cod', agentic: 'Agt' }

/** The rows on screen that carry any index, best intelligence first, capped
 * so the bars stay readable. */
function benchmarkRows(rows: CatalogRow[]): CatalogRow[] {
  return rows
    .filter(r => BENCHMARK_INDICES.some(i => benchmarkScore(r, i.key) !== null))
    .sort((a, b) => (benchmarkScore(b, 'intelligence')?.value ?? -1) - (benchmarkScore(a, 'intelligence')?.value ?? -1))
    .slice(0, BENCH_MAX)
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A row's actions, tolerating a source that omitted the list: no action is
 * offered, and the table never throws on the row. */
function actionsOf(row: CatalogRow): CatalogAction[] {
  return Array.isArray(row.actions) ? row.actions : []
}

/** Does the re-read catalogue list `target` as installed on the bundled
 * ollama? A pull of `qwen3:4b` shows up as `ollama:qwen3:4b`; a pull of a
 * bare `qwen3` as `qwen3:latest`. */
export function listsInstalled(cat: Catalog, target: string): boolean {
  const wanted = new Set([target, `${target}:latest`])
  return cat.rows.some(r => r.kind === 'local' && r.installed === true && r.provider === 'ollama' && wanted.has(r.model))
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
  // Drift, per row: what the LAST check said (the catalogue rows carry
  // null until S10a-2's check runs; it is opt-in, never on load).
  const [drift, setDrift] = useState<Record<string, DriftResult | 'checking' | { error: string }>>({})
  // Compare: the rows ticked for a side-by-side view (capped so the matrix
  // stays readable), and whether the view is open.
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  // Benchmarks: the charts for the rows on screen that carry an index.
  const [benchOpen, setBenchOpen] = useState(false)
  const [removing, setRemoving] = useState<CatalogRow | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

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

  // The persisted setting is the fact; the chat store's value is a cache of
  // it that may be stale (a switch made elsewhere) — it only fills in
  // before the settings have loaded.
  const chatModel = settingModel || chatState.model || ''

  const load = useCallback(async (): Promise<Catalog | null> => {
    setLoadError(null)
    try {
      const [cat, settings] = await Promise.all([api.getCatalog(), api.getSettings()])
      setCatalog(cat)
      setSettingModel(settingValue(settings, 'chat.model', ''))
      return cat
    } catch (err) {
      setLoadError(reasonOf(err))
      return null
    }
  }, [api])

  // Answers arriving out of order (a slow first query landing after a
  // fast second) must not overwrite the newer list: every search takes a
  // sequence number and only the newest one may publish.
  const searchSeq = useRef(0)

  useEffect(() => {
    void load()
  }, [load])

  const search = useCallback(
    async (query: string, sortKey: string, cursor?: string) => {
      const seq = ++searchSeq.current
      setHfLoading(true)
      setHfError(null)
      try {
        const page = await api.searchHf(query, sortKey, cursor)
        if (seq !== searchSeq.current) return
        setHfPage(page)
        setHfRows(prev => (cursor ? [...prev, ...page.rows] : page.rows))
      } catch (err) {
        if (seq !== searchSeq.current) return
        setHfError(reasonOf(err))
      } finally {
        if (seq === searchSeq.current) setHfLoading(false)
      }
    },
    [api],
  )

  // Keyed on the query and sort only: switching tabs does not re-spend a
  // Hub call (the results simply show on the tabs that list hub rows).
  useEffect(() => {
    if (hfQuery.trim().length < 2) {
      searchSeq.current += 1
      setHfRows([])
      setHfPage(null)
      setHfLoading(false)
      return
    }
    void search(hfQuery.trim(), hfSort)
  }, [hfQuery, hfSort, search])

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

  const toggleCompare = (row: CatalogRow, on: boolean) => {
    setCompareIds(prev => {
      if (!on) return prev.filter(id => id !== row.id)
      if (prev.includes(row.id) || prev.length >= COMPARE_MAX) return prev
      return [...prev, row.id]
    })
  }

  const remove = async (row: CatalogRow) => {
    setRemoveBusy(true)
    setActionError(null)
    try {
      const result = await api.removeModel(row.model)
      if (result.verified !== true) throw new Error(`the gateway did not verify the removal of ${row.model}`)
      setRemoving(null)
      // Installed is what the re-read catalogue says, never the 200.
      await load()
    } catch (err) {
      setActionError(`could not remove ${row.id} — ${reasonOf(err)}`)
      setRemoving(null)
    } finally {
      setRemoveBusy(false)
    }
  }

  const checkUpdate = async (row: CatalogRow) => {
    setDrift(prev => ({ ...prev, [row.id]: 'checking' }))
    try {
      const result = await api.checkDrift(row.model)
      setDrift(prev => ({ ...prev, [row.id]: result }))
    } catch (err) {
      setDrift(prev => ({ ...prev, [row.id]: { error: reasonOf(err) } }))
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
      if (!settled.done) {
        publish(settled)
        return
      }
      // ollama said success; installed is what the CATALOGUE says after the
      // pull, so the panel says "checking" until the re-read lists it.
      publish({ ...state, status: 'ollama reported success — checking the catalogue…' })
      const fresh = await load()
      if (controller.signal.aborted) return
      if (fresh === null) {
        publish({ ...state, error: `ollama reported success but the catalogue could not be re-read — ${target} is not confirmed installed` })
        return
      }
      if (!listsInstalled(fresh, target)) {
        publish({ ...state, error: `ollama reported success but the catalogue does not list ${target} as installed` })
        return
      }
      publish(settled)
    })()
  }

  const loadQuants = async (row: CatalogRow) => {
    const parts = hfParts(row.model)
    if (!parts) return
    if (Array.isArray(quantOptions[row.id])) return // already listed; a re-open is not a re-fetch
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
      key: 'compare',
      header: '',
      width: '2rem',
      render: row => (
        <Checkbox
          checked={compareIds.includes(row.id)}
          onChange={on => toggleCompare(row, on)}
          aria-label={`compare ${row.id}`}
          disabled={!compareIds.includes(row.id) && compareIds.length >= COMPARE_MAX}
        />
      ),
    },
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
        const size = row.facts.size_bytes
        const params = row.facts.params_b?.value
        if (size && typeof size.value === 'number') {
          if (size.basis === 'inferred') {
            // An estimate at the default quant, drawn as one: dashed, ≈, the
            // arithmetic in the title. Never the stated size.
            return (
              <span className="border-b border-dashed border-warning text-warning" title={size.note ?? 'inferred'} data-basis="inferred">
                ≈ {formatBytes(size.value)}
              </span>
            )
          }
          return formatBytes(size.value)
        }
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
                  !chip.value
                    ? 'border border-line text-content-tertiary line-through'
                    : chip.basis === 'inferred'
                      ? 'border border-dashed border-warning text-warning'
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
      key: 'intelligence',
      header: 'Benchmarks',
      sortable: true,
      render: row => {
        const scores = BENCHMARK_INDICES.map(i => ({ ...i, score: benchmarkScore(row, i.key) }))
        if (scores.every(s => s.score === null)) return <span className="text-content-tertiary">—</span>
        return (
          <div className="w-28 space-y-0.5" data-testid={`bench-cell-${row.id}`}>
            {scores.map(s => (
              <div key={s.key} className="flex items-center gap-1 text-micro" title={s.score ? `${s.label} ${Math.round(s.score.value)} — ${s.score.basis} · ${s.score.source}${s.score.note ? ` — ${s.score.note}` : ''}` : `${s.label}: no data`}>
                <span className="w-7 text-content-tertiary">{SHORT_INDEX[s.key]}</span>
                <div className="h-1.5 flex-1 rounded-full bg-neutral-200/60 dark:bg-neutral-700/60">
                  {s.score && <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, s.score.value))}%` }} />}
                </div>
                <span className="w-6 text-right tabular-nums text-content-primary">{s.score ? Math.round(s.score.value) : '—'}</span>
              </div>
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
                    ? 'border border-dashed border-warning text-warning'
                    : fact.basis === 'measured'
                      ? 'bg-info-dim text-blue-700 dark:text-blue-400'
                      : 'bg-neutral-200/60 text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-300'
                }`}
              >
                {fact.basis === 'measured' ? (
                  <Link to="/quality" className="underline decoration-dotted" title="measured by the quality suite — open the runs">
                    {tagLabel(key.split(':')[0], fact)}
                  </Link>
                ) : (
                  tagLabel(key.split(':')[0], fact)
                )}
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
          {actionsOf(row).includes('use') && !isCurrent(row, chatModel) && (
            <Button size="sm" loading={switching === row.id} onClick={() => void use(row)} aria-label={`use ${row.id}`}>
              Use
            </Button>
          )}
          {actionsOf(row).includes('pull') && row.kind === 'hub' && (
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
          {actionsOf(row).includes('pull') && row.kind !== 'hub' && (
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
          {actionsOf(row).includes('probe') && (
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
          {actionsOf(row).includes('check_update') && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={12} />}
              loading={drift[row.id] === 'checking'}
              onClick={() => void checkUpdate(row)}
              aria-label={`check updates ${row.id}`}
              title="compare the installed weights with what the source ships now — never pulls"
            >
              Check for updates
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDetails(row)} aria-label={`details ${row.id}`}>
            Details
          </Button>
          {actionsOf(row).includes('remove') && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={12} />}
              onClick={() => setRemoving(row)}
              aria-label={`remove ${row.id}`}
              title="delete this model from the local ollama (verified against its own list)"
            >
              Remove
            </Button>
          )}
          {probeNote[row.id] && <span className="text-caption text-content-tertiary">{probeNote[row.id]}</span>}
          <DriftNote drift={drift[row.id]} onUpdate={() => startPull(row.model)} rowId={row.id} />
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
          <>
            <Button
              size="sm"
              variant={compareIds.length >= 2 ? 'primary' : 'ghost'}
              icon={<Columns3 size={12} />}
              disabled={compareIds.length < 2}
              onClick={() => setCompareOpen(true)}
              aria-label="compare selected"
              title={compareIds.length < 2 ? `tick two or more rows to compare (up to ${COMPARE_MAX})` : 'side by side'}
            >
              Compare{compareIds.length > 0 ? ` (${compareIds.length})` : ''}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<BarChart3 size={12} />}
              onClick={() => setBenchOpen(true)}
              aria-label="benchmark charts"
              title="Intelligence, Coding and Agentic indices for the models on screen that carry them"
            >
              Benchmarks
            </Button>
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void load()}>
              Refresh
            </Button>
          </>
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

      <Sheet open={details !== null} onClose={() => setDetails(null)} title={details?.label ?? ''} width="half">
        {details && <ModelDetails row={details} />}
      </Sheet>

      <Modal open={compareOpen} onClose={() => setCompareOpen(false)} size="xl" title={`Compare ${compareIds.length} models`}>
        <div className="mb-6">
          <h3 className="mb-3 text-compact font-medium text-content-primary">Benchmarks</h3>
          <BenchmarkCharts rows={compareIds.map(id => allRows.find(r => r.id === id)).filter((r): r is CatalogRow => r !== undefined)} />
        </div>
        <h3 className="mb-3 text-compact font-medium text-content-primary">Every fact, side by side</h3>
        <CompareView rows={compareIds.map(id => allRows.find(r => r.id === id)).filter((r): r is CatalogRow => r !== undefined)} />
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => { setCompareIds([]); setCompareOpen(false) }}>
            Clear selection
          </Button>
        </div>
      </Modal>

      <Modal open={benchOpen} onClose={() => setBenchOpen(false)} size="xl" title="Benchmarks — the models on screen">
        <BenchmarkCharts rows={benchmarkRows(sorted)} />
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => (removeBusy ? undefined : setRemoving(null))}
        title={`Remove ${removing?.model ?? ''}?`}
        description={`Deletes the model and its weights from the local ollama${removing?.facts.size_bytes && typeof removing.facts.size_bytes.value === 'number' ? ` (${formatBytes(removing.facts.size_bytes.value)})` : ''}. It can be pulled again later. Removal is verified against ollama's own list.`}
        confirmLabel={removeBusy ? 'Removing…' : 'Remove'}
        destructive
        onConfirm={() => {
          if (removing && !removeBusy) void remove(removing)
        }}
      />
    </div>
  )
}

/** What the last update check said, in the server's terms: up to date, moved
 * (with the one action that follows — a re-pull of the same name), or why it
 * could not tell. Nothing here is composed from the stream or the row. */
function DriftNote({ drift, onUpdate, rowId }: { drift: DriftResult | 'checking' | { error: string } | undefined; onUpdate: () => void; rowId: string }) {
  if (drift === undefined || drift === 'checking') return null
  if ('error' in drift) return <span className="text-caption text-danger" data-testid={`drift-${rowId}`}>{drift.error}</span>
  if (drift.moved === true) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-warning" data-testid={`drift-${rowId}`}>
        update available ({drift.source ?? 'source'} ships {drift.upstream_digest?.slice(0, 19)}…)
        <Button size="sm" variant="secondary" icon={<Download size={12} />} onClick={onUpdate} aria-label={`update ${rowId}`}>
          Update
        </Button>
      </span>
    )
  }
  if (drift.moved === false) {
    return (
      <span className="text-caption text-content-tertiary" data-testid={`drift-${rowId}`}>
        up to date · checked {formatRelativeTime(drift.checked_at)}
      </span>
    )
  }
  return (
    <span className="text-caption text-content-tertiary" data-testid={`drift-${rowId}`}>
      could not tell: {drift.note ?? 'no reason given'}
    </span>
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
