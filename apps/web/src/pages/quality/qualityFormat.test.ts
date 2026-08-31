import { describe, it, expect } from 'vitest'
import type { EvalCaseResult, EvalScoreSummary } from '../../lib/api'
import {
  passRatePercent,
  predicateLabel,
  scoreLine,
  verdictOf,
} from './qualityFormat'

function caseResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    case_id: 'c1',
    message: 'a message',
    passed: true,
    ungradeable: false,
    detail: {},
    turn_id: null,
    ...overrides,
  }
}

function summary(overrides: Partial<EvalScoreSummary> = {}): EvalScoreSummary {
  return { total: 0, gradeable: 0, ungradeable: 0, passed: 0, pass_rate: null, ...overrides }
}

describe('verdictOf', () => {
  it('passed / failed by the boolean', () => {
    expect(verdictOf(caseResult({ passed: true }))).toBe('passed')
    expect(verdictOf(caseResult({ passed: false }))).toBe('failed')
  })

  it('ungradeable is its own verdict, never folded into failed', () => {
    // The turn errored: passed is null, ungradeable true — NOT a fail.
    expect(verdictOf(caseResult({ passed: null, ungradeable: true }))).toBe('ungradeable')
  })
})

describe('scoreLine', () => {
  it('is passed over GRADEABLE, never total — ungradeable never inflates it', () => {
    // 3 total, 1 ungradeable → the denominator is the 2 gradeable, not 3.
    expect(scoreLine(summary({ total: 3, gradeable: 2, ungradeable: 1, passed: 1 }))).toBe(
      '1 / 2 passed',
    )
  })
})

describe('passRatePercent', () => {
  it('rounds a real rate to a whole percent', () => {
    expect(passRatePercent(summary({ pass_rate: 0.5 }))).toBe(50)
    expect(passRatePercent(summary({ pass_rate: 2 / 3 }))).toBe(67)
  })

  it('is null when nothing is gradeable — never a fabricated 0', () => {
    expect(passRatePercent(summary({ pass_rate: null }))).toBeNull()
  })
})

describe('predicateLabel', () => {
  it('renders predicate(arg), or the bare name when argless', () => {
    expect(predicateLabel({ predicate: 'tool_called', arg: 'web_search', passed: true })).toBe(
      'tool_called(web_search)',
    )
    expect(predicateLabel({ predicate: 'consent_card_raised', passed: true })).toBe(
      'consent_card_raised',
    )
  })
})
