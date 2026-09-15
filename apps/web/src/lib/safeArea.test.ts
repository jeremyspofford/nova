import { describe, it, expect } from 'vitest'
import { coversRect, topInset } from './safeArea'

/**
 * The substitution rule, tested without a device.
 *
 * Two real observations on an iPhone 14 Pro drive this, both from
 * 2026-09-15:
 *
 *  - With `status-bar-style: default`, iOS sized the standalone web view as
 *    (screen − status bar) but drew it from the top edge, leaving a
 *    status-bar-height dead band under the fixed tab bar. The owner's
 *    screenshot measured it at ~64pt against a 59pt status bar.
 *  - With `black-translucent` the view is full-bleed and correct at the
 *    bottom — but `env(safe-area-inset-top)` can resolve to 0 anyway, so a
 *    padding that trusts env() puts the first line under the clock. v3 hit
 *    exactly this on 2026-08-04 and left the note this file is ported from.
 *
 * So the app is full-bleed AND pads the top from a measured number. The
 * substitution is deliberately conservative: it only fires when we are an
 * installed app, env() said nothing, and the viewport really does cover the
 * screen. The day iOS reports honestly, it stops firing by itself.
 */

describe('topInset', () => {
  it('trusts a real inset whenever the browser gives one', () => {
    expect(topInset(59, 34, true, true)).toBe(59)
    // Even somewhere the substitution would never apply.
    expect(topInset(47, 0, false, false)).toBe(47)
  })

  it('substitutes a status bar when an installed full-screen app reports 0', () => {
    // THE 2026-08-04/2026-09-15 CASE: drawn under the clock, told there is
    // no inset. A Face ID phone — it reports a home-indicator inset.
    expect(topInset(0, 34, true, true)).toBe(59)
  })

  it('substitutes the classic status bar on a phone with no home indicator', () => {
    // No bottom inset means no home indicator, which means no notch or
    // island either — those always come together.
    expect(topInset(0, 0, true, true)).toBe(20)
  })

  it('substitutes nothing in a browser tab, which has real chrome above it', () => {
    expect(topInset(0, 34, false, true)).toBe(0)
  })

  it('substitutes nothing when the viewport does not cover the screen', () => {
    // Nothing is being drawn over us, so there is nothing to dodge. Split
    // view, or a window that is simply not full-screen.
    expect(topInset(0, 34, true, false)).toBe(0)
  })

  it('never invents room when both conditions are merely half-met', () => {
    expect(topInset(0, 0, false, false)).toBe(0)
  })
})

/**
 * The guard that decides whether anything is drawn over us.
 *
 * It read the LONG edge until 2026-09-15 and got the owner's phone exactly
 * backwards: iOS handed the installed app a view one status bar shorter than
 * the screen and still drew it from the top, so the long edge fell 59px
 * short, `covers` came back false, `topInset` substituted nothing, and the
 * first line of the app sat under the clock. He reported it three times as
 * "I'm missing the top".
 *
 * These drive the pure rule with the numbers a device reports, since
 * `coversScreen()` itself reads window/screen directly.
 */
describe('the covers-screen rule, on short edges', () => {
  const covers = coversRect

  it('says yes when iOS shortened the view but kept it full width', () => {
    // THE 2026-09-15 CASE. iPhone 14 Pro, 393x852 screen, 793-tall view.
    expect(covers(393, 793, 393, 852)).toBe(true)
    // Comparing long edges is what got this wrong: 793 < 848.
    expect(Math.max(393, 793) >= Math.max(393, 852) - 4).toBe(false)
  })

  it('says yes for a genuinely full-bleed view, portrait or landscape', () => {
    expect(covers(393, 852, 393, 852)).toBe(true)
    // Rotated. iOS reports screen dimensions unrotated, so both mins are 393.
    expect(covers(852, 393, 393, 852)).toBe(true)
  })

  it('still says no in a split view, which is what the guard is for', () => {
    // An iPad giving the app half the width. Nothing is drawn over it.
    expect(covers(507, 1366, 1024, 1366)).toBe(false)
  })

  it('says no when the screen reports nothing', () => {
    expect(covers(393, 852, 0, 0)).toBe(false)
  })
})
