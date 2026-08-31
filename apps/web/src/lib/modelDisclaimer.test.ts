import { describe, it, expect } from 'vitest'
import {
  ACCURACY_DISCLAIMER,
  ACCURACY_DISCLAIMER_CURRENT_IS_SMALLER,
  ACCURACY_DISCLAIMER_SHORT,
} from './modelDisclaimer'

/**
 * The no-fake-numbers rail, pinned at the source rather than only through the
 * components that render these strings: none of the disclaimer copy may ever
 * claim a specific accuracy figure ("40% less accurate", a made-up score) —
 * it stays qualitative until S4's evals produce real, measured numbers.
 */
describe('model accuracy disclaimer copy', () => {
  const strings = [
    ACCURACY_DISCLAIMER,
    ACCURACY_DISCLAIMER_CURRENT_IS_SMALLER,
    ACCURACY_DISCLAIMER_SHORT,
  ]

  it('never states a percentage', () => {
    for (const s of strings) expect(s).not.toMatch(/\d+(\.\d+)?\s*%/)
  })

  it('never states a bare numeric figure standing in for a score', () => {
    // No digits anywhere — a qualitative claim has no reason to contain one.
    for (const s of strings) expect(s).not.toMatch(/\d/)
  })

  it('is honest about what it is: a heads-up, not a measurement', () => {
    expect(ACCURACY_DISCLAIMER).toMatch(/not a measurement/)
  })
})
