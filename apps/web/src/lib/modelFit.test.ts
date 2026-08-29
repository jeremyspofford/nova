import { describe, it, expect } from 'vitest'
import { fitLabel, fitSourceLabel, fitSeverity } from './modelFit'
import type { ModelFit } from './api'

function fit(overrides: Partial<ModelFit> = {}): ModelFit {
  return {
    verdict: 'comfortable',
    needed_gb: 10,
    free_gb: 20,
    total_gb: 24,
    source: 'estimated',
    reason: null,
    ...overrides,
  }
}

describe('fitLabel', () => {
  it('is a bare "fit unknown" when there is no fit object at all (a non-curated entry)', () => {
    expect(fitLabel(null)).toBe('fit unknown')
    expect(fitLabel(undefined)).toBe('fit unknown')
  })

  it('states "fit unknown" for an unknown verdict, never a guessed number', () => {
    expect(fitLabel(fit({ verdict: 'unknown', needed_gb: null, free_gb: null, total_gb: null }))).toBe(
      'fit unknown',
    )
  })

  it('is plainly "comfortable" with no alarming numbers attached', () => {
    expect(fitLabel(fit({ verdict: 'comfortable' }))).toBe('comfortable')
  })

  it('names the needed/total GB for a tight fit, matching the DoD\'s own wording', () => {
    expect(fitLabel(fit({ verdict: 'tight', needed_gb: 22, total_gb: 24 }))).toBe(
      'tight fit — ~22/24 GB',
    )
  })

  it('says it plainly for a model that will not fit', () => {
    expect(fitLabel(fit({ verdict: 'wont_fit', needed_gb: 30, total_gb: 24 }))).toBe(
      "won't fit on this GPU",
    )
  })
})

describe('fitSourceLabel', () => {
  it('distinguishes verified from estimated', () => {
    expect(fitSourceLabel(fit({ source: 'verified' }))).toBe('verified on your hardware')
    expect(fitSourceLabel(fit({ source: 'estimated' }))).toBe('estimated')
  })

  it('has nothing to say when there is no fit at all', () => {
    expect(fitSourceLabel(null)).toBeNull()
  })
})

describe('fitSeverity', () => {
  it('maps each verdict to a distinct visual severity', () => {
    expect(fitSeverity(fit({ verdict: 'comfortable' }))).toBe('success')
    expect(fitSeverity(fit({ verdict: 'tight' }))).toBe('warning')
    expect(fitSeverity(fit({ verdict: 'wont_fit' }))).toBe('danger')
    expect(fitSeverity(fit({ verdict: 'unknown' }))).toBe('neutral')
  })

  it('is neutral when there is no fit object at all', () => {
    expect(fitSeverity(null)).toBe('neutral')
  })
})
