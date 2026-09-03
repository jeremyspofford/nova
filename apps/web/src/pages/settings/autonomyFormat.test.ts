import { describe, it, expect } from 'vitest'
import { masterDisposition } from './autonomyFormat'
import type { AutonomyClass } from '../../lib/api'

function cls(action_class: string, disposition: AutonomyClass['disposition']): AutonomyClass {
  return {
    action_class,
    risk_tier: 'test',
    disposition,
    earned: false,
    consecutive_successes: 0,
    graduation_runs: 5,
    updated_at: '2026-09-03T00:00:00Z',
  }
}

describe('masterDisposition — DERIVED from the live per-class rows, never stored', () => {
  it('is the shared value when every class agrees', () => {
    expect(masterDisposition([cls('a', 'auto'), cls('b', 'auto'), cls('c', 'auto')])).toBe('auto')
    expect(masterDisposition([cls('a', 'consent'), cls('b', 'consent')])).toBe('consent')
    expect(masterDisposition([cls('a', 'deny'), cls('b', 'deny')])).toBe('deny')
  })

  it('a single class is its own master', () => {
    expect(masterDisposition([cls('only', 'deny')])).toBe('deny')
  })

  it('is "mixed" the moment one class disagrees, wherever it sits in the list', () => {
    expect(masterDisposition([cls('a', 'auto'), cls('b', 'consent'), cls('c', 'auto')])).toBe('mixed')
    expect(masterDisposition([cls('a', 'auto'), cls('b', 'auto'), cls('c', 'deny')])).toBe('mixed')
    expect(masterDisposition([cls('a', 'consent'), cls('b', 'auto')])).toBe('mixed')
  })

  it('is null for no classes — nothing to derive from, so no control over nothing', () => {
    expect(masterDisposition([])).toBeNull()
  })

  it('reads disposition only — earned and streak never tip the reading', () => {
    const earned = { ...cls('a', 'auto'), earned: true }
    const streaking = { ...cls('b', 'auto'), consecutive_successes: 4 }
    expect(masterDisposition([earned, streaking])).toBe('auto')
  })
})
