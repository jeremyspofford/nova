import { useCallback, useEffect, useState } from 'react'
import { Check, Gauge, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, CopyableId, EmptyState, Select, Skeleton } from '../../components/ui'
import {
  getEvalRuns as apiGetEvalRuns,
  getEvalSuites as apiGetEvalSuites,
  getInstalledModels as apiGetInstalledModels,
  getSuggestion as apiGetSuggestion,
  runEvalSuite as apiRunEvalSuite,
  type EvalCaseResult,
  type EvalRunResult,
  type EvalScoreSummary,
  type EvalSuite,
  type SuggestedModel,
} from '../../lib/api'
import { mergeModels } from '../settings/modelsFormat'
import {
  passRatePercent,
  predicateLabel,
  scoreLine,
  VERDICT_COLOR,
  VERDICT_LABEL,
  verdictOf,
} from './qualityFormat'

/**
 * AI Quality — run an eval suite against a model through the REAL turn funnel
 * and see per-model, per-case scores. The visible surface of Slice 4: the
 * operator picks a suite + a model (the same installed-model catalog the chat
 * model picker uses), runs it, and reads an honest score — overall pass rate
 * plus a per-case table of what each case checked and whether it held.
 *
 * The numbers here are never fabricated. A run's score comes straight from the
 * runner's summary; UNGRADEABLE cases (the turn errored — model missing, gateway
 * down) render as their own grey state and are EXCLUDED from the rate (the
 * denominator is the gradeable set), never scored 0. With no results yet the
 * page shows an empty state, never a 0/0 dressed up as a score.
 *
 * The run is long — a suite is minutes of real turns — so it STREAMS: the API's
 * `runEvalSuite` calls `onCase` as each case genuinely finishes, and the table
 * fills in live. The progress is real completion, never a fabricated percentage.
 *
 * `api` is the dependency-injection seam every page here uses: production takes
 * the real client (DEFAULT_API), a test injects fakes.
 */
export interface QualityApi {
  getEvalSuites: typeof apiGetEvalSuites
  getEvalRuns: typeof apiGetEvalRuns
  runEvalSuite: typeof apiRunEvalSuite
  getInstalledModels: typeof apiGetInstalledModels
  getSuggestion: typeof apiGetSuggestion
}

const DEFAULT_API: QualityApi = {
  getEvalSuites: apiGetEvalSuites,
  getEvalRuns: apiGetEvalRuns,
  runEvalSuite: apiRunEvalSuite,
  getInstalledModels: apiGetInstalledModels,
  getSuggestion: apiGetSuggestion,
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function AIQualityPage({ api = DEFAULT_API }: { api?: QualityApi } = {}) {
  const [suites, setSuites] = useState<EvalSuite[] | null>(null)
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [curated, setCurated] = useState<SuggestedModel[] | null>(null)
  const [suite, setSuite] = useState('')
  const [model, setModel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Prior stored results for the current (suite, model) — shown before a fresh run.
  const [prior, setPrior] = useState<EvalRunResult | null>(null)
  const [priorLoading, setPriorLoading] = useState(false)
  const [priorError, setPriorError] = useState<string | null>(null)

  // A live or just-finished run, which takes precedence over the stored results.
  const [running, setRunning] = useState(false)
  const [liveCases, setLiveCases] = useState<EvalCaseResult[]>([])
  const [runResult, setRunResult] = useState<EvalRunResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  // Suites + the model catalog, once. Each read degrades on its own — a failed
  // catalog fetch just leaves the model dropdown thinner (mergeModels still
  // surfaces the current pick), never a thrown page.
  useEffect(() => {
    let live = true
    api.getEvalSuites().then(
      list => {
        if (!live) return
        setSuites(list)
        setSuite(prev => prev || list[0]?.suite || '')
      },
      err => {
        if (live) setLoadError(reasonOf(err))
      },
    )
    api.getInstalledModels().then(
      list => live && setInstalled(list),
      () => {},
    )
    api.getSuggestion().then(
      s => live && setCurated(s.models),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])

  const merged = mergeModels(model, installed, curated)

  // Default the model to the first the catalog offers, once one arrives. The
  // operator switches it freely from there — a switch + re-run + compare is the
  // whole point of the page.
  useEffect(() => {
    if (!model && merged.length > 0) setModel(merged[0].slug)
  }, [model, merged])

  // Load the stored results whenever the (suite, model) pair changes, and clear
  // any run from the previous pair so a stale run never shows under a new model.
  useEffect(() => {
    setRunResult(null)
    setLiveCases([])
    setRunError(null)
    if (!suite || !model) {
      setPrior(null)
      return
    }
    let live = true
    setPriorLoading(true)
    setPriorError(null)
    api
      .getEvalRuns(suite, model)
      .then(result => {
        if (live) setPrior(result)
      })
      .catch(err => {
        if (live) {
          setPrior(null)
          setPriorError(reasonOf(err))
        }
      })
      .finally(() => {
        if (live) setPriorLoading(false)
      })
    return () => {
      live = false
    }
  }, [api, suite, model])

  const run = useCallback(async () => {
    if (!suite || !model || running) return
    setRunning(true)
    setRunError(null)
    setRunResult(null)
    setLiveCases([])
    try {
      const result = await api.runEvalSuite(suite, model, c =>
        setLiveCases(prev => [...prev, c]),
      )
      setRunResult(result)
      setPrior(result) // the fresh run becomes the stored view for this pair
    } catch (err) {
      setRunError(reasonOf(err))
    } finally {
      setRunning(false)
    }
  }, [api, suite, model, running])

  const caseCount = suites?.find(s => s.suite === suite)?.case_count ?? null
  const suiteVersion = suites?.find(s => s.suite === suite)?.suite_version ?? null

  const canRun = Boolean(suite) && Boolean(model) && !running

  return (
    <div>
      <PageHeader
        title="AI Quality"
        description="Run an eval suite against a model and read an honest, per-case score — the same real turn path a live chat runs."
      />

      {loadError && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load the eval suites: {loadError}
        </div>
      )}

      {/* Pick a suite + a model, then Run. */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <Select
            label="Suite"
            value={suite}
            disabled={running || suites === null}
            onChange={e => setSuite(e.target.value)}
            data-testid="eval-suite-select"
          >
            {(suites ?? []).map(s => (
              <option key={s.suite} value={s.suite}>
                {s.suite} (v{s.suite_version}, {s.case_count} cases)
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-64">
          <Select
            label="Model"
            value={model}
            disabled={running || merged.length === 0}
            onChange={e => setModel(e.target.value)}
            data-testid="eval-model-select"
          >
            {merged.map(m => (
              <option key={m.slug} value={m.slug}>
                {m.slug}
                {m.installed ? '' : ' (not installed)'}
              </option>
            ))}
          </Select>
        </div>
        <Button
          onClick={run}
          disabled={!canRun}
          loading={running}
          data-testid="eval-run-button"
          icon={running ? undefined : <Gauge size={14} />}
        >
          {running ? 'Running…' : 'Run suite'}
        </Button>
      </div>

      {runError && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          The run failed: {runError}
        </div>
      )}

      <Results
        running={running}
        liveCases={liveCases}
        caseCount={caseCount}
        runResult={runResult}
        prior={prior}
        priorLoading={priorLoading}
        priorError={priorError}
        suiteVersion={suiteVersion}
        model={model}
      />
    </div>
  )
}

function Results({
  running,
  liveCases,
  caseCount,
  runResult,
  prior,
  priorLoading,
  priorError,
  suiteVersion,
  model,
}: {
  running: boolean
  liveCases: EvalCaseResult[]
  caseCount: number | null
  runResult: EvalRunResult | null
  prior: EvalRunResult | null
  priorLoading: boolean
  priorError: string | null
  suiteVersion: number | null
  model: string
}) {
  // A run in progress takes precedence: show the cases that have finished so
  // far with an honest "still running" banner, and NO percentage yet — nothing
  // is scored until every case has landed.
  if (running || (liveCases.length > 0 && runResult === null)) {
    return (
      <div>
        <div
          data-testid="eval-running"
          className="mb-4 flex items-center gap-2 rounded-sm border border-border bg-surface-elevated px-4 py-3 text-compact text-content-secondary"
        >
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span>
            Running {model} on {liveCases.length}
            {caseCount !== null ? ` of ${caseCount}` : ''} case
            {caseCount === 1 ? '' : 's'}… this runs real turns and can take a few minutes.
          </span>
        </div>
        {liveCases.length > 0 && <CaseTable cases={liveCases} />}
      </div>
    )
  }

  // A just-finished run.
  if (runResult !== null) {
    return (
      <div>
        <ScoreHeader
          summary={runResult.summary}
          caption={`Just now · ${runResult.model} · ${runResult.suite} v${runResult.suite_version}`}
        />
        <CaseTable cases={runResult.cases} />
      </div>
    )
  }

  if (priorError) {
    return (
      <div
        role="alert"
        className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
      >
        Could not load prior results: {priorError}
      </div>
    )
  }

  if (priorLoading) {
    return (
      <div data-testid="eval-prior-skeleton">
        <Skeleton lines={5} />
      </div>
    )
  }

  // Stored results from an earlier run of this exact (suite, model).
  if (prior !== null && prior.cases.length > 0) {
    return (
      <div>
        <ScoreHeader
          summary={prior.summary}
          caption={`Latest stored results · ${prior.model} · ${prior.suite} v${prior.suite_version}`}
        />
        <CaseTable cases={prior.cases} />
      </div>
    )
  }

  // Nothing scored yet — an empty state, never a 0/0 shown as a score.
  return (
    <EmptyState
      icon={Gauge}
      title="No results yet"
      description="Pick a suite and a model, then Run to score this model. Switch to a different model and run again to compare."
    />
  )
}

function ScoreHeader({ summary, caption }: { summary: EvalScoreSummary; caption?: string }) {
  const pct = passRatePercent(summary)
  return (
    <div
      data-testid="eval-score"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border glass-card px-5 py-4 dark:border-white/[0.08]"
    >
      <span className="text-h2 text-content-primary">{scoreLine(summary)}</span>
      {pct === null ? (
        <span data-testid="eval-pass-rate-empty" className="text-compact text-content-tertiary">
          No gradeable cases to score
        </span>
      ) : (
        <span data-testid="eval-pass-rate" className="text-body text-content-secondary">
          {pct}% pass rate
        </span>
      )}
      {summary.ungradeable > 0 && (
        <Badge color="neutral" size="sm">
          {summary.ungradeable} ungradeable, excluded
        </Badge>
      )}
      {caption && <span className="text-caption text-content-tertiary">{caption}</span>}
    </div>
  )
}

function CaseTable({ cases }: { cases: EvalCaseResult[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]">
      <table className="w-full text-compact">
        <thead>
          <tr className="bg-surface-elevated">
            {['Case', 'Result', 'What it checked'].map(heading => (
              <th
                key={heading}
                className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {cases.map(c => (
            <CaseRow key={c.case_id} c={c} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CaseRow({ c }: { c: EvalCaseResult }) {
  const verdict = verdictOf(c)
  const ungradeable = verdict === 'ungradeable'
  const predicates = c.detail.predicates ?? []
  return (
    <tr
      data-testid={`eval-case-${c.case_id}`}
      className={clsx(ungradeable && 'bg-surface-elevated/40 text-content-tertiary')}
    >
      <td className="px-4 py-2.5 align-top">
        <div className="text-content-primary">{c.message ?? c.case_id}</div>
        {!ungradeable && c.detail.reply && (
          <p className="mt-1 line-clamp-2 text-micro text-content-tertiary">
            Nova replied: {c.detail.reply}
          </p>
        )}
      </td>
      <td className="px-4 py-2.5 align-top whitespace-nowrap">
        <Badge color={VERDICT_COLOR[verdict]} size="sm">
          {VERDICT_LABEL[verdict]}
        </Badge>
      </td>
      <td className="px-4 py-2.5 align-top">
        {ungradeable ? (
          <span data-testid="eval-ungradeable-reason" className="text-caption italic">
            {c.detail.reason ?? 'the turn could not be scored'}
          </span>
        ) : (
          <div className="flex flex-col gap-1">
            {predicates.map((p, i) => (
              <span
                key={i}
                data-testid="eval-predicate"
                className={clsx(
                  'inline-flex items-center gap-1 font-mono text-micro',
                  p.passed ? 'text-success' : 'text-danger',
                )}
              >
                {p.passed ? <Check size={12} /> : <X size={12} />}
                {predicateLabel(p)}
              </span>
            ))}
          </div>
        )}
        {c.turn_id && (
          <div className="mt-1.5 flex items-center gap-1 text-micro text-content-tertiary">
            <span>trace</span>
            <CopyableId id={c.turn_id} />
          </div>
        )}
      </td>
    </tr>
  )
}
