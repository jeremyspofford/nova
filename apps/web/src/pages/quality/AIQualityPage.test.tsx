import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AIQualityPage, type QualityApi } from './AIQualityPage'
import {
  ApiError,
  type EvalCaseResult,
  type EvalRunRecord,
  type EvalRunResult,
  type EvalRunStarted,
  type EvalScoreSummary,
  type EvalSuite,
  type EvalSuiteRun,
  type Suggestion,
} from '../../lib/api'

function suite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return { suite: 'agent_quality', suite_version: 1, case_count: 2, ...overrides }
}

function caseResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    case_id: 'c1',
    message: 'what is the latest on the pixel?',
    passed: true,
    ungradeable: false,
    detail: { predicates: [{ predicate: 'tool_called', arg: 'web_search', passed: true }] },
    turn_id: 't-1',
    ...overrides,
  }
}

function suiteRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    id: 'run-1',
    suite: 'agent_quality',
    suite_version: 1,
    model: 'qwen3:8b',
    status: 'running',
    case_count: 2,
    error: null,
    started_at: '2026-09-03T10:00:00+00:00',
    ended_at: null,
    ...overrides,
  }
}

function record(
  run: EvalSuiteRun,
  cases: EvalCaseResult[],
  summary: EvalScoreSummary | null = null,
): EvalRunRecord {
  return { run, cases, summary }
}

function stored(cases: EvalCaseResult[], summary: EvalScoreSummary): EvalRunResult {
  return {
    suite: 'agent_quality',
    suite_version: 1,
    model: 'qwen3:8b',
    run: cases.length
      ? suiteRun({ id: 'run-old', status: 'done', ended_at: '2026-09-03T10:05:00+00:00' })
      : null,
    cases,
    summary,
  }
}

const EMPTY_SUMMARY: EvalScoreSummary = {
  total: 0,
  gradeable: 0,
  ungradeable: 0,
  passed: 0,
  pass_rate: null,
}

const HALF: EvalScoreSummary = { total: 2, gradeable: 2, ungradeable: 0, passed: 1, pass_rate: 0.5 }

const STARTED: EvalRunStarted = {
  run_id: 'run-1',
  status: 'running',
  case_count: 2,
  suite: 'agent_quality',
  suite_version: 1,
  model: 'qwen3:8b',
}

const NO_SUGGESTION: Suggestion = {
  tier: '',
  engine_suggestion: '',
  rationale: '',
  models: [],
}

/** A full fake API, each field overridable per test. Defaults: one suite, one
 * installed model, no active run, no stored results (so the page settles on
 * an empty state), and a record that stays 'running' with nothing landed. */
function fakeApi(overrides: Partial<QualityApi> = {}): QualityApi {
  return {
    getEvalSuites: vi.fn(async () => [suite()]),
    getInstalledModels: vi.fn(async () => ['qwen3:8b']),
    getSuggestion: vi.fn(async () => NO_SUGGESTION),
    getEvalRuns: vi.fn(async () => stored([], EMPTY_SUMMARY)),
    startEvalRun: vi.fn(async () => STARTED),
    getActiveEvalRun: vi.fn(async () => null),
    getEvalRun: vi.fn(async () => record(suiteRun(), [])),
    ...overrides,
  }
}

const PASSED = caseResult({ case_id: 'p', message: 'searches the web', passed: true })
const FAILED = caseResult({
  case_id: 'f',
  message: 'deflects the question',
  passed: false,
  detail: { predicates: [{ predicate: 'tool_called', arg: 'web_search', passed: false }] },
})

async function runButton(): Promise<HTMLButtonElement> {
  const button = (await screen.findByTestId('eval-run-button')) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
}

describe('AIQualityPage', () => {
  it('lists the suites and the installed models to pick from', async () => {
    render(<AIQualityPage api={fakeApi()} pollMs={10} />)
    await waitFor(() => expect(screen.getByText(/agent_quality/)).toBeTruthy())
    // the model catalog (getInstalledModels) drives the model dropdown
    await waitFor(() => expect(screen.getByText('qwen3:8b')).toBeTruthy())
  })

  it('shows an empty state before any run — never a fabricated 0 score', async () => {
    render(<AIQualityPage api={fakeApi()} pollMs={10} />)
    await waitFor(() => expect(screen.getByText(/no results yet/i)).toBeTruthy())
    // No score block, and no 0/0 or 0% masquerading as a result anywhere.
    expect(screen.queryByTestId('eval-score')).toBeNull()
    expect(screen.queryByText(/0\s*\/\s*0/)).toBeNull()
    expect(screen.queryByText(/0%/)).toBeNull()
  })

  it('mounting while a run is active attaches to it: progress shown, Run disabled, no POST', async () => {
    const api = fakeApi({
      getActiveEvalRun: vi.fn(async () => suiteRun({ model: 'qwen3:27b' })),
      getEvalRun: vi.fn(async () => record(suiteRun({ model: 'qwen3:27b' }), [PASSED])),
    })
    render(<AIQualityPage api={api} pollMs={10} />)

    // The record's own facts: the model it runs and the cases it has persisted
    // (the banner shows the moment the page attaches; the count lands with the
    // first poll of the record).
    await waitFor(() =>
      expect(screen.getByTestId('eval-running').textContent).toContain('1 of 2'),
    )
    expect(screen.getByTestId('eval-running').textContent).toContain('qwen3:27b')
    expect(screen.getByTestId('eval-case-p')).toBeTruthy()
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(true)
    expect(api.startEvalRun).not.toHaveBeenCalled()
    expect(api.getEvalRun).toHaveBeenCalledWith('run-1')
    // A partial is never a score.
    expect(screen.queryByTestId('eval-score')).toBeNull()
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('Run starts a server-side job, polls its record until done, then shows the score', async () => {
    let reads = 0
    const api = fakeApi({
      getEvalRun: vi.fn(async () => {
        reads += 1
        return reads < 3
          ? record(suiteRun(), [PASSED])
          : record(
              suiteRun({ status: 'done', ended_at: '2026-09-03T10:06:00+00:00' }),
              [PASSED, FAILED],
              HALF,
            )
      }),
    })
    render(<AIQualityPage api={api} pollMs={10} />)

    fireEvent.click(await runButton())

    await waitFor(() => expect(api.startEvalRun).toHaveBeenCalledWith('agent_quality', 'qwen3:8b'))
    await waitFor(() => expect(screen.getByTestId('eval-running')).toBeTruthy())
    // Polling the record the POST named, until it is terminal.
    await waitFor(() => expect(screen.getByTestId('eval-score')).toBeTruthy())
    expect(api.getEvalRun).toHaveBeenCalledWith('run-1')
    expect(reads).toBeGreaterThanOrEqual(3)
    // Overall score from the record's own summary — 1 of 2 gradeable passed.
    expect(screen.getByTestId('eval-score').textContent).toContain('1 / 2 passed')
    expect(screen.getByTestId('eval-pass-rate').textContent).toContain('50%')
    expect(screen.getByTestId('eval-score').textContent).toContain('Just now')
    expect(screen.getByTestId('eval-case-p')).toBeTruthy()
    expect(screen.getByTestId('eval-case-f')).toBeTruthy()
    expect(screen.getAllByTestId('eval-predicate').length).toBeGreaterThan(0)
    // Finished: Run is available again, and exactly one POST was ever sent.
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(false)
    expect(api.startEvalRun).toHaveBeenCalledTimes(1)
  })

  it('a 409 attaches to the run that holds the slot instead of showing an error', async () => {
    let active: EvalSuiteRun | null = null
    const api = fakeApi({
      startEvalRun: vi.fn(async () => {
        active = suiteRun({ id: 'run-9', model: 'other:1b' })
        throw new ApiError(409, 'a suite run is already running: agent_quality v1 on other:1b')
      }),
      getActiveEvalRun: vi.fn(async () => active),
      getEvalRun: vi.fn(async () => record(suiteRun({ id: 'run-9', model: 'other:1b' }), [])),
    })
    render(<AIQualityPage api={api} pollMs={10} />)

    fireEvent.click(await runButton())

    const banner = await screen.findByTestId('eval-running')
    expect(banner.textContent).toContain('other:1b')
    await waitFor(() => expect(api.getEvalRun).toHaveBeenCalledWith('run-9'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('unmounting and remounting mid-run re-attaches without a second POST', async () => {
    let active: EvalSuiteRun | null = null
    const api = fakeApi({
      startEvalRun: vi.fn(async () => {
        active = suiteRun()
        return STARTED
      }),
      getActiveEvalRun: vi.fn(async () => active),
      getEvalRun: vi.fn(async () => record(suiteRun(), [PASSED])),
    })
    const first = render(<AIQualityPage api={api} pollMs={10} />)
    fireEvent.click(await runButton())
    await waitFor(() => expect(screen.getByTestId('eval-running')).toBeTruthy())
    expect(api.startEvalRun).toHaveBeenCalledTimes(1)

    first.unmount() // navigate away — the job is the server's, it keeps going

    render(<AIQualityPage api={api} pollMs={10} />)
    await waitFor(() =>
      expect(screen.getByTestId('eval-running').textContent).toContain('1 of 2'),
    )
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(true)
    expect(api.startEvalRun).toHaveBeenCalledTimes(1) // never a second run
  })

  it('a failed poll keeps watching and retries — the job is the server\'s, not this page\'s', async () => {
    // The motivating path: a backgrounded PWA resumes and its in-flight read
    // is killed, or the network blips. The run has not stopped; the page must
    // not act as if it had (detaching re-enabled Run over a live job).
    let release!: () => void
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    let reads = 0
    const api = fakeApi({
      getActiveEvalRun: vi.fn(async () => suiteRun()),
      getEvalRun: vi.fn(async () => {
        reads += 1
        if (reads === 1) throw new ApiError(0, 'could not reach Nova — connection refused')
        await released
        return record(suiteRun(), [PASSED])
      }),
    })
    render(<AIQualityPage api={api} pollMs={10} />)

    // The failure is stated inline, under a banner that is still there.
    const note = await screen.findByTestId('eval-poll-error')
    expect(note.textContent).toContain('could not reach Nova')
    expect(screen.getByTestId('eval-running')).toBeTruthy()
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull() // not "the run failed"
    // ...and the next tick was scheduled: the read is retried.
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))

    release()
    await waitFor(() =>
      expect(screen.getByTestId('eval-running').textContent).toContain('1 of 2'),
    )
    expect(screen.queryByTestId('eval-poll-error')).toBeNull() // a read landed: cleared
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(true)
    expect(api.startEvalRun).not.toHaveBeenCalled()
  })

  it('a 404 on the record is the one poll failure that detaches: the record is gone', async () => {
    const api = fakeApi({
      getActiveEvalRun: vi.fn(async () => suiteRun()),
      getEvalRun: vi.fn(async () => {
        throw new ApiError(404, 'no such run')
      }),
    })
    render(<AIQualityPage api={api} pollMs={10} />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('record is gone'))
    expect(screen.queryByTestId('eval-running')).toBeNull()
    expect(screen.queryByTestId('eval-poll-error')).toBeNull()
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(false)
    expect(api.getEvalRun).toHaveBeenCalledTimes(1) // no retry against a record that is gone
    expect(api.startEvalRun).not.toHaveBeenCalled()
  })

  it('a run that ended interrupted states why and never shows its partial as a score', async () => {
    const cutOff = suiteRun({
      status: 'interrupted',
      error: 'the core process running this suite exited before every case finished',
      ended_at: '2026-09-03T10:02:00+00:00',
    })
    const api = fakeApi({
      getActiveEvalRun: vi.fn(async () => suiteRun()),
      getEvalRun: vi.fn(async () => record(cutOff, [PASSED])),
    })
    render(<AIQualityPage api={api} pollMs={10} />)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('exited before every case'),
    )
    expect(screen.queryByTestId('eval-score')).toBeNull()
    expect(screen.queryByText(/%/)).toBeNull()
    const partial = screen.getByTestId('eval-partial')
    expect(partial.textContent).toContain('1 of 2')
    expect(partial.textContent).toContain('no score')
    expect(screen.getByTestId('eval-case-p')).toBeTruthy()
    expect((screen.getByTestId('eval-run-button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders an ungradeable case distinctly and excludes it from the stored score', async () => {
    const passed = caseResult({ case_id: 'p', passed: true })
    const ungradeable = caseResult({
      case_id: 'u',
      message: 'model was not installed',
      passed: null,
      ungradeable: true,
      detail: { reason: 'the model qwen3:70b is not installed' },
    })
    // 2 total, 1 gradeable (passed), 1 ungradeable → 1/1, not 1/2.
    const prior = stored([passed, ungradeable], {
      total: 2,
      gradeable: 1,
      ungradeable: 1,
      passed: 1,
      pass_rate: 1,
    })
    render(
      <AIQualityPage api={fakeApi({ getEvalRuns: vi.fn(async () => prior) })} pollMs={10} />,
    )

    await waitFor(() => expect(screen.getByTestId('eval-score')).toBeTruthy())
    // Denominator is the gradeable set — the ungradeable case is NOT counted.
    expect(screen.getByTestId('eval-score').textContent).toContain('1 / 1 passed')
    expect(screen.getByTestId('eval-pass-rate').textContent).toContain('100%')
    expect(screen.getByTestId('eval-score').textContent).toContain('ungradeable')
    expect(screen.getByTestId('eval-score').textContent).toContain('Latest stored results')

    // The ungradeable row is present, distinct (its own grey styling), and shows
    // the turn's reason rather than a PASS/FAIL verdict.
    const row = screen.getByTestId('eval-case-u')
    expect(row.className).toMatch(/text-content-tertiary/)
    expect(screen.getByTestId('eval-ungradeable-reason').textContent).toContain('not installed')
    expect(screen.getByText('Ungradeable')).toBeTruthy()
  })

  it('states the reason when the run cannot be started, and shows no score', async () => {
    const startEvalRun = vi.fn(async () => {
      throw new ApiError(0, 'could not reach Nova — connection refused')
    })
    render(<AIQualityPage api={fakeApi({ startEvalRun })} pollMs={10} />)

    fireEvent.click(await runButton())

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not reach Nova'),
    )
    expect(screen.queryByTestId('eval-score')).toBeNull()
    expect(screen.queryByTestId('eval-running')).toBeNull()
  })
})
