import { describe, it, expect } from 'vitest'
import { capPercent, dayBars, gpuMinutes, purposeLabel, tokens, usd } from './spendFormat'
import type { SpendReport } from '../../lib/api'

describe('spendFormat', () => {
  it('never invents a number: null is "not stated", tiny dollars keep their digits', () => {
    expect(usd(null)).toBe('not stated')
    expect(usd(0)).toBe('$0.00')
    expect(usd(0.0004)).toBe('$0.0004')
    expect(usd(12.5)).toBe('$12.50')
    expect(gpuMinutes(null)).toBe('not stated')
    expect(gpuMinutes(90)).toBe('1.5 min')
    expect(tokens(1234)).toBe('1.2K')
    expect(tokens(2_500_000)).toBe('2.5M')
    expect(tokens(null)).toBe('—')
  })

  it('a cap percentage exists only when there is a cap, and clamps', () => {
    expect(capPercent(5, null)).toBeNull()
    expect(capPercent(5, 0)).toBeNull()
    expect(capPercent(5, 20)).toBe(25)
    expect(capPercent(30, 20)).toBe(100)
    expect(capPercent(null, 20)).toBe(0)
  })

  it('pads the days of the window so a quiet day is a zero bar, not a missing one', () => {
    const report = {
      since: '2026-09-01T00:00:00-06:00',
      until: '2026-09-04T10:00:00+00:00',
      by_day: [
        { day: '2026-09-01', usd: 1, calls: 2, gpu_seconds: 0 },
        { day: '2026-09-03', usd: 0, calls: 4, gpu_seconds: 120 },
      ],
    } as unknown as SpendReport
    expect(dayBars(report)).toEqual([
      { day: '2026-09-01', usd: 1, calls: 2, gpu_seconds: 0 },
      { day: '2026-09-02', usd: 0, calls: 0, gpu_seconds: 0 },
      { day: '2026-09-03', usd: 0, calls: 4, gpu_seconds: 120 },
      { day: '2026-09-04', usd: 0, calls: 0, gpu_seconds: 0 },
    ])
  })

  it('names purposes in words and leaves an unknown one as it came', () => {
    expect(purposeLabel('judge')).toBe('Quality judging')
    expect(purposeLabel(null)).toBe('Unattributed')
    expect(purposeLabel('coding')).toBe('coding')
  })
})
