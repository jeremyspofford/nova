import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AIQualityPage, type QualityApi } from './AIQualityPage'
import type {
  EvalCaseResult,
  EvalRunResult,
  EvalScoreSummary,
  EvalSuite,
  Suggestion,
} from '../../lib/api'

function suite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return { suite: 'agent_quality', suite_version: 1, case_count: 3, ...overrides }
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

function runResult(cases: EvalCaseResult[], summary: EvalScoreSummary): EvalRunResult {
  return { suite: 'agent_quality', suite_version: 1, model: 'qwen3:8b', cases, summary }
}

const EMPTY_SUMMARY: EvalScoreSummary = {
  total: 0,
  gradeable: 0,
  ungradeable: 0,
  passed: 0,
  pass_rate: null,
}

const NO_SUGGESTION: Suggestion = {
  tier: '',
  engine_suggestion: '',
  rationale: '',
  models: [],
}

/** A full fake API, each field overridable per test. Defaults: one suite, one
 * installed model, and no prior runs (so the page settles on an empty state). */
function fakeApi(overrides: Partial<QualityApi> = {}): QualityApi {
  return {
    getEvalSuites: vi.fn(async () => [suite()]),
    getInstalledModels: vi.fn(async () => ['qwen3:8b']),
    getSuggestion: vi.fn(async () => NO_SUGGESTION),
    getEvalRuns: vi.fn(async () => runResult([], EMPTY_SUMMARY)),
    runEvalSuite: vi.fn(async () => runResult([], EMPTY_SUMMARY)),
    ...overrides,
  }
}

describe('AIQualityPage', () => {
  it('lists the suites and the installed models to pick from', async () => {
    render(<AIQualityPage api={fakeApi()} />)
    await waitFor(() => expect(screen.getByText(/agent_quality/)).toBeTruthy())
    // the model catalog (getInstalledModels) drives the model dropdown
    await waitFor(() => expect(screen.getByText('qwen3:8b')).toBeTruthy())
  })

  it('shows an empty state before any run — never a fabricated 0 score', async () => {
    render(<AIQualityPage api={fakeApi()} />)
    await waitFor(() => expect(screen.getByText(/no results yet/i)).toBeTruthy())
    // No score block, and no 0/0 or 0% masquerading as a result anywhere.
    expect(screen.queryByTestId('eval-score')).toBeNull()
    expect(screen.queryByText(/0\s*\/\s*0/)).toBeNull()
    expect(screen.queryByText(/0%/)).toBeNull()
  })

  it('RUN calls the API and renders the per-case table + overall score', async () => {
    const passed = caseResult({ case_id: 'p', message: 'searches the web', passed: true })
    const failed = caseResult({
      case_id: 'f',
      message: 'deflects the question',
      passed: false,
      detail: { predicates: [{ predicate: 'tool_called', arg: 'web_search', passed: false }] },
    })
    const result = runResult([passed, failed], {
      total: 2,
      gradeable: 2,
      ungradeable: 0,
      passed: 1,
      pass_rate: 0.5,
    })
    const runEvalSuite = vi.fn(async (_s: string, _m: string, onCase?: (c: EvalCaseResult) => void) => {
      result.cases.forEach(c => onCase?.(c))
      return result
    })
    render(<AIQualityPage api={fakeApi({ runEvalSuite })} />)

    const runButton = await screen.findByTestId('eval-run-button')
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(runButton)

    await waitFor(() => expect(runEvalSuite).toHaveBeenCalledWith('agent_quality', 'qwen3:8b', expect.any(Function)))
    await waitFor(() => expect(screen.getByTestId('eval-score')).toBeTruthy())
    // Overall score from the response — 1 of 2 gradeable passed.
    expect(screen.getByTestId('eval-score').textContent).toContain('1 / 2 passed')
    expect(screen.getByTestId('eval-pass-rate').textContent).toContain('50%')
    // Both cases rendered, with what each checked.
    expect(screen.getByTestId('eval-case-p')).toBeTruthy()
    expect(screen.getByTestId('eval-case-f')).toBeTruthy()
    expect(screen.getAllByTestId('eval-predicate').length).toBeGreaterThan(0)
  })

  it('renders an ungradeable case distinctly and excludes it from the score', async () => {
    const passed = caseResult({ case_id: 'p', passed: true })
    const ungradeable = caseResult({
      case_id: 'u',
      message: 'model was not installed',
      passed: null,
      ungradeable: true,
      detail: { reason: 'the model qwen3:70b is not installed' },
    })
    // 2 total, 1 gradeable (passed), 1 ungradeable → 1/1, not 1/2.
    const prior = runResult([passed, ungradeable], {
      total: 2,
      gradeable: 1,
      ungradeable: 1,
      passed: 1,
      pass_rate: 1,
    })
    render(<AIQualityPage api={fakeApi({ getEvalRuns: vi.fn(async () => prior) })} />)

    await waitFor(() => expect(screen.getByTestId('eval-score')).toBeTruthy())
    // Denominator is the gradeable set — the ungradeable case is NOT counted.
    expect(screen.getByTestId('eval-score').textContent).toContain('1 / 1 passed')
    expect(screen.getByTestId('eval-pass-rate').textContent).toContain('100%')
    expect(screen.getByTestId('eval-score').textContent).toContain('ungradeable')

    // The ungradeable row is present, distinct (its own grey styling), and shows
    // the turn's reason rather than a PASS/FAIL verdict.
    const row = screen.getByTestId('eval-case-u')
    expect(row.className).toMatch(/text-content-tertiary/)
    expect(screen.getByTestId('eval-ungradeable-reason').textContent).toContain('not installed')
    expect(screen.getByText('Ungradeable')).toBeTruthy()
  })

  it('states the reason when the run fails, and never shows a partial as a score', async () => {
    const runEvalSuite = vi.fn(async () => {
      throw new Error('the run ended before a summary — it did not finish')
    })
    render(<AIQualityPage api={fakeApi({ runEvalSuite })} />)

    const runButton = await screen.findByTestId('eval-run-button')
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(runButton)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('did not finish'),
    )
    expect(screen.queryByTestId('eval-score')).toBeNull()
  })
})
