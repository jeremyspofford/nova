import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  FlaskConical,
  Trophy,
  Clock,
  Hash,
  TrendingUp,
  TrendingDown,
  Minus,
  Activity,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
  Trash2,
  GitBranch,
} from 'lucide-react'
import { apiFetch } from '../api'
import { LoopsTab } from './quality/LoopsTab'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, EmptyState, Tabs, Button, Badge, Select } from '../components/ui'
import clsx from 'clsx'

// ── Types ────────────────────────────────────────────────────────────────────

type QualitySummary = {
  period_days: number
  dimensions: Record<string, { avg: number; count: number; trend: number }>
  composite: number
}

type BenchmarkRun = {
  id: string
  started_at: string | null
  completed_at: string | null
  status: string
  composite_score: number | null   /* 0-100 scale */
  dimension_scores: Record<string, number>   /* 0-1 per dimension */
  category_scores: Record<string, number>    /* legacy, retained for old rows */
  case_results: Array<{
    name: string
    category: string
    scores: Record<string, number>
    composite: number
    error?: string
  }>
  config_snapshot_id?: string | null
  error_summary?: string | null
  metadata: Record<string, unknown>
}

// Memory benchmark types (from existing Benchmarks page)
type QueryTypeBreakdown = {
  precision_at_5: number
  mrr: number
  avg_latency_ms: number
  n: number
}

type MemBenchmarkSummary = {
  type: 'summary'
  provider: string
  precision_at_5: number
  mrr: number
  avg_latency_ms: number
  total_tokens: number
  by_query_type: Record<string, QueryTypeBreakdown>
}

type MemBenchmarkRun = {
  file: string
  summaries: MemBenchmarkSummary[]
  per_query: unknown[]
}

type MemBenchmarkResponse = {
  runs: MemBenchmarkRun[]
  latest: MemBenchmarkRun | null
}

// ── Constants ────────────────────────────────────────────────────────────────

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
] as const

const DIMENSION_LABELS: Record<string, string> = {
  memory_relevance:        'Memory Relevance',
  memory_recall:           'Memory Recall',
  memory_usage:            'Memory Usage',
  tool_accuracy:           'Tool Accuracy',
  response_coherence:      'Response Coherence',
  task_completion:         'Task Completion',
  instruction_adherence:   'Instruction Adherence',
  safety_compliance:       'Safety Compliance',
}

const PROVIDER_COLORS: Record<string, { bg: string; text: string; bar: string }> = {
  okf:      { bg: 'bg-teal-500/15',    text: 'text-teal-700 dark:text-teal-400',    bar: 'bg-teal-500' },
  pgvector: { bg: 'bg-stone-500/15',   text: 'text-stone-700 dark:text-stone-400',  bar: 'bg-stone-500' },
  mem0:     { bg: 'bg-amber-500/15',   text: 'text-amber-700 dark:text-amber-400',  bar: 'bg-amber-500' },
  markdown: { bg: 'bg-emerald-500/15', text: 'text-emerald-700 dark:text-emerald-400', bar: 'bg-emerald-500' },
}

const DEFAULT_COLOR = { bg: 'bg-blue-500/15', text: 'text-blue-700 dark:text-blue-400', bar: 'bg-blue-500' }

function getProviderColor(name: string) {
  return PROVIDER_COLORS[name.toLowerCase()] ?? DEFAULT_COLOR
}

const QUERY_TYPE_LABELS: Record<string, string> = {
  factual: 'Factual',
  preference: 'Preference',
  multi_session: 'Multi-Session',
  temporal: 'Temporal',
}

const HELP_ENTRIES = [
  { term: 'Composite Score', definition: 'Weighted average across all quality dimensions, scaled 0-100. Higher is better.' },
  { term: 'Trend', definition: 'Direction of score change compared to the previous period of equal length.' },
  { term: 'Dimensions', definition: 'Individual quality axes: memory relevance, tool accuracy, instruction adherence, response coherence, context utilization, etc.' },
  { term: 'Benchmark Run', definition: 'An automated evaluation against a fixed set of test cases, producing repeatable quality scores.' },
  { term: 'Precision@5', definition: 'Fraction of the top 5 retrieved results that are relevant. Higher is better (max 1.0).' },
  { term: 'MRR', definition: 'Mean Reciprocal Rank — measures how early the first relevant result appears. 1.0 means it is always first.' },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 0.7) return 'text-success'
  if (score >= 0.4) return 'text-warning'
  return 'text-danger'
}

function compositeColor(score: number): string {
  if (score >= 70) return 'text-success'
  if (score >= 40) return 'text-warning'
  return 'text-danger'
}

function TrendIcon({ trend }: { trend: number }) {
  if (trend > 0.01) return <TrendingUp size={14} className="text-success" />
  if (trend < -0.01) return <TrendingDown size={14} className="text-danger" />
  return <Minus size={14} className="text-content-tertiary" />
}

function formatDimension(key: string): string {
  return DIMENSION_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatDate(iso: string | null): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusBadgeColor(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'completed': return 'success'
    case 'running': return 'warning'
    case 'failed': return 'danger'
    default: return 'neutral'
  }
}

// ── Live Scores Tab ─────────────────────────────────────────────────────────

function LiveScoresTab() {
  const [period, setPeriod] = useState<string>('7d')

  const { data, isLoading, error } = useQuery({
    queryKey: ['quality-summary', period],
    queryFn: () => apiFetch<QualitySummary>(`/api/v1/quality/summary?period=${period}`),
    refetchInterval: 30_000,
  })

  const dimensions = data?.dimensions ?? {}
  const dimensionKeys = Object.keys(dimensions).sort()

  return (
    <div className="space-y-6 mt-6">
      {/* Period selector */}
      <div className="flex gap-1.5">
        {PERIODS.map(p => (
          <button
            key={p.value}
            type="button"
            onClick={() => setPeriod(p.value)}
            className={clsx(
              'px-3 py-1.5 text-caption font-medium rounded-sm transition-colors duration-fast',
              period === p.value
                ? 'bg-accent text-neutral-950 dark:shadow-[0_0_12px_rgb(var(--accent-500)/0.2)]'
                : 'text-content-secondary hover:text-content-primary hover:bg-surface-elevated',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <Card className="p-8">
          <p className="text-center text-compact text-content-tertiary">Loading quality scores...</p>
        </Card>
      )}

      {error && (
        <Card className="p-8">
          <p className="text-center text-compact text-danger">
            Failed to load quality data: {String(error)}
          </p>
        </Card>
      )}

      {!isLoading && !error && data && (
        <>
          {/* Composite Score */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-1">
              <Activity size={16} className="text-accent" />
              <span className="text-caption font-medium text-content-tertiary uppercase tracking-wider">
                Composite Score
              </span>
            </div>
            <div className="flex items-baseline gap-3 mt-2">
              <span className={clsx('font-mono text-[48px] font-bold leading-none tracking-tight', compositeColor(data.composite))}>
                {Math.round(data.composite)}
              </span>
              <span className="text-compact text-content-tertiary">/ 100</span>
            </div>
            <p className="text-caption text-content-tertiary mt-2">
              Based on {Object.values(dimensions).reduce((sum, d) => sum + d.count, 0)} scored interactions over the last {PERIODS.find(p => p.value === period)?.label}
            </p>
          </Card>

          {/* Dimension cards */}
          {dimensionKeys.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {dimensionKeys.map(key => {
                const dim = dimensions[key]
                return (
                  <Card key={key} className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-compact font-medium text-content-primary">
                        {formatDimension(key)}
                      </span>
                      <TrendIcon trend={dim.trend} />
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className={clsx('font-mono text-[28px] font-bold leading-none', scoreColor(dim.avg))}>
                        {dim.avg.toFixed(2)}
                      </span>
                      <span className="text-micro text-content-tertiary">/ 1.0</span>
                    </div>
                    {/* Score bar */}
                    <div className="mt-3 h-1.5 w-full rounded-full bg-surface-elevated overflow-hidden">
                      <div
                        className={clsx(
                          'h-full rounded-full transition-all duration-500',
                          dim.avg >= 0.7 ? 'bg-success' : dim.avg >= 0.4 ? 'bg-warning' : 'bg-danger',
                        )}
                        style={{ width: `${Math.min(dim.avg * 100, 100)}%` }}
                      />
                    </div>
                    <p className="text-micro text-content-tertiary mt-2">
                      {dim.count} interaction{dim.count !== 1 ? 's' : ''} scored
                    </p>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={Activity}
                title="No scores yet"
                description="Quality scores appear after AI interactions are evaluated. Send some messages to get started."
              />
            </Card>
          )}
        </>
      )}
    </div>
  )
}

// ── Benchmarks Tab ──────────────────────────────────────────────────────────

function BenchmarksTab() {
  const queryClient = useQueryClient()
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [selectedMemRun, setSelectedMemRun] = useState(0)
  const [diffOpen, setDiffOpen] = useState<{from: string; to: string} | null>(null)

  // Quality benchmark runs
  const { data: qualityRuns, isLoading: qualityLoading } = useQuery({
    queryKey: ['quality-benchmark-results'],
    queryFn: () => apiFetch<BenchmarkRun[]>('/api/v1/quality/benchmarks/runs'),
  })

  // Memory benchmark runs (existing)
  const { data: memData, isLoading: memLoading } = useQuery({
    queryKey: ['benchmark-results'],
    queryFn: () => apiFetch<MemBenchmarkResponse>('/api/v1/benchmarks/results'),
  })

  // Run benchmark mutation
  const runBenchmark = useMutation({
    mutationFn: () => apiFetch<BenchmarkRun>('/api/v1/benchmarks/run-quality', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quality-benchmark-results'] })
    },
  })

  // Clear all mutation
  const clearAll = useMutation({
    mutationFn: () => apiFetch('/api/v1/benchmarks/quality-results', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quality-benchmark-results'] })
      queryClient.invalidateQueries({ queryKey: ['quality-scores'] })
    },
  })

  const runs = qualityRuns ?? []
  const memRuns = memData?.runs ?? []
  const currentMemRun = memRuns[selectedMemRun] ?? null
  const memSummaries = currentMemRun?.summaries ?? []

  // Find the winner (highest precision@5) for memory benchmarks
  const winnerProvider = memSummaries.length > 0
    ? memSummaries.reduce((best, s) => s.precision_at_5 > best.precision_at_5 ? s : best).provider
    : null

  // All query types across memory benchmark summaries
  const allQueryTypes = Array.from(
    new Set(memSummaries.flatMap(s => Object.keys(s.by_query_type))),
  ).sort()

  const maxPrecision = Math.max(
    ...memSummaries.flatMap(s =>
      Object.values(s.by_query_type).map(qt => qt.precision_at_5),
    ),
    0.01,
  )

  return (
    <div className="space-y-8 mt-6">
      {/* ── Quality Benchmarks ─────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-h2 text-content-primary">Quality Benchmarks</h2>
          <div className="flex gap-2">
            {runs.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={clearAll.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                onClick={() => clearAll.mutate()}
                disabled={clearAll.isPending}
              >
                Clear All
              </Button>
            )}
            <Button
              size="sm"
              icon={runBenchmark.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              loading={runBenchmark.isPending}
              onClick={() => runBenchmark.mutate()}
              disabled={runBenchmark.isPending}
            >
              Run Benchmark
            </Button>
          </div>
        </div>

        {runBenchmark.isError && (
          <Card className="p-4">
            <p className="text-compact text-danger">
              Benchmark failed: {String(runBenchmark.error)}
            </p>
          </Card>
        )}

        {qualityLoading && (
          <Card className="p-8">
            <p className="text-center text-compact text-content-tertiary">Loading benchmark results...</p>
          </Card>
        )}

        {!qualityLoading && runs.length === 0 && (
          <Card>
            <EmptyState
              icon={FlaskConical}
              title="No quality benchmark runs yet"
              description="Click 'Run Benchmark' to evaluate AI quality against a fixed set of test cases."
            />
          </Card>
        )}

        {!qualityLoading && runs.length > 0 && (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-compact">
                <thead>
                  <tr className="bg-surface-elevated">
                    <th className="w-8 px-3 py-3" />
                    <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-caption font-medium text-content-tertiary uppercase tracking-wider">
                      Composite
                    </th>
                    <th className="px-4 py-3 text-right text-caption font-medium text-content-tertiary uppercase tracking-wider">
                      Delta
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {runs.map((run, idx) => {
                    const prevRun = runs[idx + 1]
                    const delta = run.composite_score != null && prevRun?.composite_score != null
                      ? run.composite_score - prevRun.composite_score
                      : null
                    const isExpanded = expandedRunId === run.id

                    return (
                      <>
                        <BenchmarkRunRow
                          key={run.id}
                          run={run}
                          delta={delta}
                          isExpanded={isExpanded}
                          onToggle={() => setExpandedRunId(isExpanded ? null : run.id)}
                        />
                        {idx > 0 && runs[idx - 1]?.config_snapshot_id && run.config_snapshot_id &&
                         runs[idx - 1].config_snapshot_id !== run.config_snapshot_id && (
                          <tr key={`diff-${run.id}`}>
                            <td colSpan={5} className="bg-surface-elevated px-4 py-2 text-caption text-content-secondary">
                              <button
                                type="button"
                                onClick={() => setDiffOpen({from: runs[idx - 1].config_snapshot_id!, to: run.config_snapshot_id!})}
                                className="underline hover:text-content-primary"
                              >
                                Show config diff with previous run
                              </button>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      {/* ── Memory Retrieval Benchmarks ────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-h2 text-content-primary">Memory Retrieval</h2>
          {memRuns.length > 1 && (
            <Select
              label=""
              value={String(selectedMemRun)}
              onChange={(e) => setSelectedMemRun(Number(e.target.value))}
              items={memRuns.map((r, i) => ({
                value: String(i),
                label: r.file.replace('.jsonl', '').replace('benchmark-', 'Run '),
              }))}
              className="w-48"
            />
          )}
        </div>

        {memLoading && (
          <Card className="p-8">
            <p className="text-center text-compact text-content-tertiary">Loading memory benchmark results...</p>
          </Card>
        )}

        {!memLoading && memSummaries.length === 0 && (
          <Card>
            <EmptyState
              icon={FlaskConical}
              title="No memory benchmark results yet"
              description="Run the benchmark harness to compare memory providers. Results will appear here automatically."
            />
            <div className="px-6 pb-6 -mt-4">
              <div className="mx-auto max-w-lg rounded-sm border border-border bg-surface-elevated p-4">
                <p className="text-caption font-medium text-content-secondary mb-2">How to run benchmarks:</p>
                <pre className="text-mono-sm text-content-tertiary overflow-x-auto whitespace-pre-wrap">{[
                  'python -m benchmarks.benchmark \\',
                  '  --providers "okf=http://localhost:8002" \\',
                  '  --test-cases benchmarks/test_cases.jsonl \\',
                  `  --output benchmarks/results/benchmark-${new Date().toISOString().slice(0, 10)}.jsonl \\`,
                  '  --llm-gateway http://localhost:8001',
                ].join('\n')}</pre>
              </div>
            </div>
          </Card>
        )}

        {/* Provider comparison table */}
        {memSummaries.length > 0 && (
          <>
            <Card className="overflow-hidden">
              <div className="border-b border-border-subtle px-4 py-3 flex items-center gap-2">
                <Trophy size={16} className="text-accent" />
                <p className="text-caption font-medium text-content-tertiary uppercase tracking-wider">
                  Provider Comparison
                </p>
                {currentMemRun && (
                  <span className="ml-auto text-caption text-content-tertiary">
                    {currentMemRun.file}
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-compact">
                  <thead>
                    <tr className="bg-surface-elevated">
                      <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">
                        Provider
                      </th>
                      <th className="px-4 py-3 text-right text-caption font-medium text-content-tertiary uppercase tracking-wider">
                        Precision@5
                      </th>
                      <th className="px-4 py-3 text-right text-caption font-medium text-content-tertiary uppercase tracking-wider">
                        MRR
                      </th>
                      <th className="px-4 py-3 text-right text-caption font-medium text-content-tertiary uppercase tracking-wider">
                        <span className="inline-flex items-center gap-1">
                          <Clock size={12} /> Latency
                        </span>
                      </th>
                      <th className="px-4 py-3 text-right text-caption font-medium text-content-tertiary uppercase tracking-wider">
                        <span className="inline-flex items-center gap-1">
                          <Hash size={12} /> Tokens
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {memSummaries.map((s) => {
                      const isWinner = s.provider === winnerProvider
                      const colors = getProviderColor(s.provider)
                      return (
                        <tr
                          key={s.provider}
                          className={clsx(
                            'transition-colors',
                            isWinner
                              ? 'bg-teal-500/5 dark:bg-teal-500/10'
                              : 'hover:bg-surface-card-hover',
                          )}
                        >
                          <td className="px-4 py-3">
                            <span className={clsx(
                              'inline-flex items-center gap-1.5 rounded-xs px-2 py-0.5 text-caption font-medium',
                              colors.bg, colors.text,
                            )}>
                              {isWinner && <Trophy size={12} />}
                              {s.provider}
                            </span>
                          </td>
                          <td className={clsx(
                            'px-4 py-3 text-right font-mono text-mono-sm',
                            isWinner ? 'text-accent font-bold' : 'text-content-primary',
                          )}>
                            {s.precision_at_5.toFixed(4)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-mono-sm text-content-primary">
                            {s.mrr.toFixed(4)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-mono-sm text-content-secondary">
                            {s.avg_latency_ms.toFixed(1)}ms
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-mono-sm text-content-secondary">
                            {s.total_tokens.toLocaleString()}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Per-query-type breakdown */}
            {allQueryTypes.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-h3 text-content-primary">By Query Type</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {allQueryTypes.map(qt => (
                    <Card key={qt} className="overflow-hidden">
                      <div className="border-b border-border-subtle px-4 py-3">
                        <p className="text-caption font-medium text-content-primary">
                          {QUERY_TYPE_LABELS[qt] ?? qt}
                        </p>
                        <p className="text-micro text-content-tertiary mt-0.5">
                          Precision@5 comparison
                        </p>
                      </div>
                      <div className="p-4 space-y-3">
                        {memSummaries.map(s => {
                          const qtData = s.by_query_type[qt]
                          if (!qtData) return null
                          const pct = Math.max((qtData.precision_at_5 / maxPrecision) * 100, 2)
                          const colors = getProviderColor(s.provider)
                          return (
                            <div key={s.provider} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className={clsx(
                                  'inline-flex items-center rounded-xs px-1.5 py-0.5 text-micro font-medium',
                                  colors.bg, colors.text,
                                )}>
                                  {s.provider}
                                </span>
                                <div className="flex items-center gap-3 text-micro text-content-tertiary">
                                  <span>P@5: <span className="text-content-primary font-mono">{qtData.precision_at_5.toFixed(4)}</span></span>
                                  <span>MRR: <span className="text-content-primary font-mono">{qtData.mrr.toFixed(4)}</span></span>
                                  <span>{qtData.avg_latency_ms.toFixed(0)}ms</span>
                                </div>
                              </div>
                              <div className="h-6 w-full rounded-xs bg-surface-elevated overflow-hidden">
                                <div
                                  className={clsx('h-full rounded-xs transition-all duration-500', colors.bar)}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <DiffModal open={diffOpen} onClose={() => setDiffOpen(null)} />
    </div>
  )
}

// ── Benchmark Run Row ───────────────────────────────────────────────────────

function BenchmarkRunRow({
  run,
  delta,
  isExpanded,
  onToggle,
}: {
  run: BenchmarkRun
  delta: number | null
  isExpanded: boolean
  onToggle: () => void
}) {
  const hasCaseResults = run.case_results && run.case_results.length > 0

  return (
    <>
      <tr
        className={clsx(
          'transition-colors',
          hasCaseResults ? 'cursor-pointer hover:bg-surface-card-hover' : '',
          isExpanded && 'bg-surface-elevated',
        )}
        onClick={hasCaseResults ? onToggle : undefined}
      >
        <td className="px-3 py-3">
          {hasCaseResults && (
            isExpanded
              ? <ChevronDown size={14} className="text-content-tertiary" />
              : <ChevronRight size={14} className="text-content-tertiary" />
          )}
        </td>
        <td className="px-4 py-3 text-compact text-content-primary">
          {formatDate(run.completed_at ?? run.started_at)}
        </td>
        <td className="px-4 py-3">
          <Badge color={statusBadgeColor(run.status)}>
            {run.status}
          </Badge>
        </td>
        <td className={clsx(
          'px-4 py-3 text-right font-mono text-mono-sm',
          run.composite_score != null ? compositeColor(run.composite_score) : 'text-content-tertiary',
        )}>
          {run.composite_score != null ? Math.round(run.composite_score) : '--'}
        </td>
        <td className="px-4 py-3 text-right font-mono text-mono-sm">
          {delta != null ? (
            <span className={clsx(
              delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-content-tertiary',
            )}>
              {delta > 0 ? '+' : ''}{Math.round(delta)}
            </span>
          ) : (
            <span className="text-content-tertiary">--</span>
          )}
        </td>
      </tr>

      {/* Error summary banner */}
      {run.error_summary ? (
        <tr>
          <td colSpan={5} className="bg-danger/5 px-4 py-2 text-caption text-danger">
            <strong>Errors:</strong> {run.error_summary}
          </td>
        </tr>
      ) : null}

      {/* Expanded case results */}
      {isExpanded && hasCaseResults && (
        <tr>
          <td colSpan={5} className="p-0">
            <div className="bg-surface-elevated border-t border-border-subtle px-8 py-4">
              <p className="text-caption font-medium text-content-tertiary uppercase tracking-wider mb-3">
                Test Case Results
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {run.case_results.map((c, i) => (
                  <div
                    key={i}
                    className="rounded-md border border-border-subtle bg-surface-card p-3 glass-card dark:border-white/[0.08]"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="min-w-0 text-caption font-medium text-content-primary truncate" title={c.name}>
                        {c.name}
                      </span>
                      <span className={clsx('font-mono text-caption font-bold', compositeColor(c.composite))}>
                        {Math.round(c.composite)}
                      </span>
                    </div>
                    <span className="text-micro text-content-tertiary">{c.category}</span>
                    {Object.keys(c.scores).length > 0 && (
                      <div className="mt-2 space-y-1">
                        {Object.entries(c.scores).map(([dim, score]) => (
                          <div key={dim} className="flex items-center justify-between">
                            <span className="min-w-0 text-micro text-content-tertiary truncate mr-2">
                              {formatDimension(dim)}
                            </span>
                            <span className={clsx('font-mono text-micro', scoreColor(score))}>
                              {score.toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Diff Modal ──────────────────────────────────────────────────────────────

function DiffModal({open, onClose}: {open: {from: string; to: string} | null; onClose: () => void}) {
  const { data, isLoading } = useQuery({
    queryKey: ['snapshot-diff', open?.from, open?.to],
    queryFn: () => apiFetch<{changed_keys: Array<{key: string; from: unknown; to: unknown}>}>(
      `/api/v1/quality/snapshots/diff?from=${open!.from}&to=${open!.to}`
    ),
    enabled: !!open,
  })
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-surface-card border border-border-subtle rounded-md p-6 max-w-2xl w-full mx-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-h3 text-content-primary mb-4">Config diff</h3>
        {isLoading && <p className="text-caption text-content-tertiary">Loading…</p>}
        {data && data.changed_keys.length === 0 && (
          <p className="text-caption text-content-tertiary">No differences (snapshots are equal).</p>
        )}
        {data && data.changed_keys.length > 0 && (
          <table className="w-full text-compact">
            <thead>
              <tr>
                <th className="text-left text-caption text-content-tertiary py-1">Key</th>
                <th className="text-left text-caption text-content-tertiary py-1">From</th>
                <th className="text-left text-caption text-content-tertiary py-1">To</th>
              </tr>
            </thead>
            <tbody>
              {data.changed_keys.map(c => (
                <tr key={c.key} className="border-t border-border-subtle">
                  <td className="py-2 font-mono text-mono-sm">{c.key}</td>
                  <td className="py-2 font-mono text-mono-sm text-content-tertiary">{JSON.stringify(c.from)}</td>
                  <td className="py-2 font-mono text-mono-sm">{JSON.stringify(c.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button onClick={onClose} className="mt-4 text-caption text-content-tertiary underline">Close</button>
      </div>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

const TABS = [
  { id: 'live', label: 'Live Scores', icon: Activity },
  { id: 'benchmarks', label: 'Benchmarks', icon: FlaskConical },
  { id: 'loops', label: 'Loops', icon: GitBranch },
]

export function AIQuality() {
  const [activeTab, setActiveTab] = useState('live')

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Quality"
        description="Monitor response quality scores and run structured benchmarks."
        helpEntries={HELP_ENTRIES}
      />

      <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'live' && <LiveScoresTab />}
      {activeTab === 'benchmarks' && <BenchmarksTab />}
      {activeTab === 'loops' && <LoopsTab />}
    </div>
  )
}
