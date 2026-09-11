import { describe, expect, it } from 'vitest'
import { statusPill, trialWords, usesWords } from './skillsFormat'

describe('statusPill', () => {
  it('draws a file with no row as a file, not as a problem', () => {
    expect(statusPill(null)).toEqual({ label: 'File only', color: 'neutral' })
  })

  it('flags in warning, because it is a raised hand and not a verdict', () => {
    expect(statusPill('flagged').color).toBe('warning')
  })
})

describe('usesWords', () => {
  it('never folds unwatched uses into the clean ones', () => {
    const words = usesWords({ total: 5, watched: 3, rough: 1, unwatched: 2, last_used: null })
    expect(words).toContain('1 of the 3 watched turns went badly')
    expect(words).toContain('2 never watched')
  })

  it('says nothing is known when no use was ever watched', () => {
    const words = usesWords({ total: 2, watched: 0, rough: 0, unwatched: 2, last_used: null })
    expect(words).toContain('nothing is known')
    expect(words).not.toContain('went badly')
  })

  it('distinguishes never read from no row at all', () => {
    expect(usesWords({ total: 0, watched: 0, rough: 0, unwatched: 0, last_used: null })).toBe(
      'Never read',
    )
    expect(usesWords(null)).toContain('No row')
  })
})

describe('trialWords', () => {
  it('says what the runs did and stops there', () => {
    const words = trialWords(2, 5)
    expect(words).toContain('Fewer with it, in this one run each.')
    expect(words).not.toContain('better')
  })

  it('does not invent a comparison when a run did not finish', () => {
    expect(trialWords(null, 5)).toBe('One of the runs did not finish')
  })
})
