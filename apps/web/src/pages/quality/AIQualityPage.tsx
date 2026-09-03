import { useCallback, useEffect, useState } from 'react'
import { Check, Gauge, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, CopyableId, EmptyState, Select, Skeleton } from '../../components/ui'
import {
  ApiError,
  getActiveEvalRun as apiGetActiveEvalRun,
  getEvalRun as apiGetEvalRun,
  getEvalRuns as apiGetEvalRuns,
  getEvalSuites as apiGetEvalSuites,
  getInstalledModels as apiGetInstalledModels,
  getSuggestion as apiGetSuggestion,
  startEvalRun as apiStartEvalRun,
  type EvalCaseResult,
  type EvalRunRecord,
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
 * A run is a SERVER-SIDE JOB and this page is a VIEWER of its record. `Run`
 * POSTs once, gets the run's id back at once (202), and polls the record every
 * `pollMs` until it is terminal; the banner's count is the cases the server
 * has genuinely persisted, never a fabricated percentage. Because the truth is
 * the record, not this component: on mount the page asks whether a run is
 * active and re-attaches to it — navigating away and back, reloading, or a
 * second tab all show the same run, with Run disabled — and a 409 from Run
 * (one runs at a time; the GPU is shared) attaches to the active run instead
 * of raising an error. A run that ended 'error' or 'interrupted' states why and
 * shows its partial cases as a partial, never as a score.
 *
 * A failed READ of the record is not a finished run: the job is the server's
 * and keeps going whether or not this page can reach it (a backgrounded PWA
 * resuming, a network blip). So a poll that fails keeps watching — the failure
 * is stated inline in the banner and the next tick is scheduled — and the page
 * detaches only on a 404, the one answer that says the record itself is gone.
 * Detaching on any error re-enabled Run over a live job: the exact state the
 * server-side job was built to end.
 *
 * `api` is the dependency-injection seam every page here uses: production takes
 * the real client (DEFAULT_API), a test injects fakes.
 */
export interface QualityApi {
  getEvalSuites: typeof apiGetEvalSuites
  getEvalRuns: typeof apiGetEvalRuns
  startEvalRun: typeof apiStartEvalRun
  getActiveEvalRun: typeof apiGetActiveEvalRun
  getEvalRun: typeof apiGetEvalRun
  getInstalledModels: typeof apiGetInstalledModels
  getSuggestion: typeof apiGetSuggestion
}

const DEFAULT_API: QualityApi = {
  getEvalSuites: apiGetEvalSuites,
  getEvalRuns: apiGetEvalRuns,
  startEvalRun: apiStartEvalRun,
  getActiveEvalRun: apiGetActiveEvalRun,
  getEvalRun: apiGetEvalRun,
  getInstalledModels: apiGetInstalledModels,
  getSuggestion: apiGetSuggestion,
}

/** How often the live record is re-read while a run is 'running'. */
export const DEFAULT_POLL_MS = 2000

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A finished record's stated reason for not being 'done'. */
function endedReason(record: EvalRunRecord): string {
  const { status, error } = record.run
  if (error) return error
  return status === 'interrupted'
    ? 'the run was interrupted before every case finished'
    : `the run ended with status ${status}`
}

function asStored(record: EvalRunRecord, summary: EvalScoreSummary): EvalRunResult {
  return {
    suite: record.run.suite,
    suite_version: record.run.suite_version,
    model: record.run.model,
    run: record.run,
    cases: record.cases,
    summary,
  }
}

export function AIQualityPage({
  api = DEFAULT_API,
  pollMs = DEFAULT_POLL_MS,
}: { api?: QualityApi; pollMs?: number } = {}) {
  const [suites, setSuites] = useState<EvalSuite[] | null>(null)
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [curated, setCurated] = useState<SuggestedModel[] | null>(null)
  const [suite, setSuite] = useState('')
  const [model, setModel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Prior stored results for the current (suite, model) — the latest COMPLETE
  // run — shown when nothing is running or just finished.
  const [prior, setPrior] = useState<EvalRunResult | null>(null)
  const [priorLoading, setPriorLoading] = useState(false)
  const [priorError, setPriorError] = useState<string | null>(null)

  // The run this page is watching: its id while polling, the record as last
  // read, and — once terminal — the record it finished as. `attaching` is
  // true until the mount-time "is a run active?" read answers, so a click
  // cannot race it into a second POST.
  const [attaching, setAttaching] = useState(true)
  const [watching, setWatching] = useState<string | null>(null)
  const [record, setRecord] = useState<EvalRunRecord | null>(null)
  const [finished, setFinished] = useState<EvalRunRecord | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // The last poll's failure, while still watching — cleared by the next read
  // that lands. Never a reason to stop watching (see the module comment).
  const [pollError, setPollError] = useState<string | null>(null)

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

  // Attach to whatever run is active, from the record — this is what makes
  // navigating away and back (or a reload) show the same run rather than an
  // enabled Run button over a job that is still going.
  useEffect(() => {
    let live = true
    api
      .getActiveEvalRun()
      .then(active => {
        if (!live) return
        if (active) {
          setSuite(active.suite)
          setModel(active.model)
          setWatching(active.id)
        }
      })
      .catch(err => {
        if (live) setRunError(`could not read whether a run is active — ${reasonOf(err)}`)
      })
      .finally(() => {
        if (live) setAttaching(false)
      })
    return () => {
      live = false
    }
  }, [api])

  // Poll the watched run's record until it is terminal. Each read is the
  // server's own row: the cases it has persisted so far, and a summary only
  // once it is 'done'.
  useEffect(() => {
    if (watching === null) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      let next: EvalRunRecord
      try {
        next = await api.getEvalRun(watching)
      } catch (err) {
        if (!live) return
        if (err instanceof ApiError && err.status === 404) {
          // The record itself is gone — there is nothing left to watch.
          setRunError(`the run's record is gone — ${reasonOf(err)}`)
          setPollError(null)
          setWatching(null)
          return
        }
        // Any other failure is this page's, not the run's: keep watching,
        // say the read failed, and read again on the next tick.
        setPollError(reasonOf(err))
        timer = setTimeout(tick, pollMs)
        return
      }
      if (!live) return
      setPollError(null)
      setRecord(next)
      if (next.run.status === 'running') {
        timer = setTimeout(tick, pollMs)
        return
      }
      setWatching(null)
      setFinished(next)
      if (next.run.status === 'done' && next.summary) {
        setPrior(asStored(next, next.summary)) // the fresh run becomes the stored view
      } else {
        setRunError(endedReason(next))
      }
    }
    void tick()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, watching, pollMs])

  const merged = mergeModels(model, installed, curated)

  // Default the model to the first the catalog offers, once one arrives. The
  // operator switches it freely from there — a switch + re-run + compare is the
  // whole point of the page.
  useEffect(() => {
    if (!model && merged.length > 0) setModel(merged[0].slug)
  }, [model, merged])

  // Load the stored results whenever the (suite, model) pair changes, and clear
  // any finished run from the previous pair so a stale run never shows under a
  // new model. A run being WATCHED is not cleared — it is the server's, not
  // this pair's.
  useEffect(() => {
    setFinished(null)
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

  const running = watching !== null

  const run = useCallback(async () => {
    if (!suite || !model || running || attaching) return
    setRunError(null)
    setPollError(null)
    setFinished(null)
    setRecord(null)
    try {
      const started = await api.startEvalRun(suite, model)
      setWatching(started.run_id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // One at a time: another tab, or an earlier click, holds the slot.
        // That run is the fact — attach to it rather than report an error.
        try {
          const active = await api.getActiveEvalRun()
          if (active) {
            setSuite(active.suite)
            setModel(active.model)
            setWatching(active.id)
            return
          }
        } catch {
          // fall through to the refusal's own stated reason
        }
      }
      setRunError(reasonOf(err))
    }
  }, [api, suite, model, running, attaching])

  const caseCount = suites?.find(s => s.suite === suite)?.case_count ?? null

  const canRun = Boolean(suite) && Boolean(model) && !running && !attaching

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
        record={record}
        pollError={pollError}
        finished={finished}
        caseCount={caseCount}
        prior={prior}
        priorLoading={priorLoading}
        priorError={priorError}
        suite={suite}
        model={model}
      />
    </div>
  )
}

function Results({
  running,
  record,
  pollError,
  finished,
  caseCount,
  prior,
  priorLoading,
  priorError,
  suite,
  model,
}: {
  running: boolean
  record: EvalRunRecord | null
  pollError: string | null
  finished: EvalRunRecord | null
  caseCount: number | null
  prior: EvalRunResult | null
  priorLoading: boolean
  priorError: string | null
  suite: string
  model: string
}) {
  // A run in progress takes precedence: the cases the server has persisted so
  // far under an honest "still running" banner, and NO percentage yet —
  // nothing is scored until every case has landed.
  if (running) {
    const done = record?.cases.length ?? 0
    const total = record?.run.case_count ?? caseCount
    return (
      <div>
        <div
          data-testid="eval-running"
          className="mb-4 flex items-center gap-2 rounded-sm border border-border bg-surface-elevated px-4 py-3 text-compact text-content-secondary"
        >
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span>
            Running {record?.run.model ?? model} on {record?.run.suite ?? suite}: {done}
            {total !== null ? ` of ${total}` : ''} case{total === 1 ? '' : 's'} finished… this
            runs real turns and can take a few minutes. It keeps running if you leave this page.
          </span>
        </div>
        {pollError && (
          <div
            data-testid="eval-poll-error"
            className="mb-4 rounded-sm border border-warning/30 bg-warning-dim px-4 py-3 text-compact text-warning"
          >
            Could not read the run's record — {pollError}. The run keeps going on the server;
            reading it again…
          </div>
        )}
        {record && record.cases.length > 0 && <CaseTable cases={record.cases} />}
      </div>
    )
  }

  // A run that finished while this page watched it.
  if (finished !== null) {
    if (finished.run.status === 'done' && finished.summary) {
      return (
        <div>
          <ScoreHeader
            summary={finished.summary}
            caption={`Just now · ${finished.run.model} · ${finished.run.suite} v${finished.run.suite_version}`}
          />
          <CaseTable cases={finished.cases} />
        </div>
      )
    }
    // Ended without finishing: the cases that landed are shown as a PARTIAL —
    // the reason is in the alert above — never rolled up into a score.
    return (
      <div data-testid="eval-partial">
        <div className="mb-4 text-compact text-content-tertiary">
          {finished.cases.length} of {finished.run.case_count} case
          {finished.run.case_count === 1 ? '' : 's'} finished before the run ended{' '}
          {finished.run.status} — no score. Run again to score {finished.run.model}.
        </div>
        {finished.cases.length > 0 && <CaseTable cases={finished.cases} />}
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

  // Stored results: the latest COMPLETE run of this exact (suite, model).
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
