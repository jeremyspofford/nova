import { describe, it, expect } from 'vitest'
import { APP_ICONS, DEFAULT_APP_ICON, appIconHref, knownAppIcon, markDataUri } from './app-icon'
import { resolvePalette } from './color-palettes'

/**
 * The tab icon is part of the theme, not a static asset.
 *
 * The first version of this shipped v3's cosmic swirl as a fixed PNG and
 * Jeremy's answer was: wrong icon. The app's own mark is a rounded square in
 * the theme's accent with an N in it — so a FIXED image is wrong twice over,
 * once for being a different visual language and once for not moving when
 * the palette does.
 */

describe('the derived mark', () => {
  it('paints itself from the palette that is on screen', () => {
    const teal = resolvePalette('nova')
    const uri = decodeURIComponent(markDataUri('dark', 'nova', 'teal'))

    expect(uri).toContain(`rgb(${teal.accent[500]})`)
    // The glyph on an accent fill in dark mode is the deepest neutral, the
    // same rule index.css applies to every accent-filled surface.
    expect(uri).toContain(`rgb(${teal.neutral[950]})`)
    expect(uri).toContain('>N<')
  })

  it('moves when the theme does — the whole reason it is not a PNG', () => {
    const nova = markDataUri('dark', 'nova', 'teal')
    const ember = markDataUri('dark', 'ember', 'teal')

    expect(nova).not.toEqual(ember)
    expect(decodeURIComponent(ember)).toContain(`rgb(${resolvePalette('ember').accent[500]})`)
  })

  it('uses white on the accent in light mode, where the fills are deep', () => {
    expect(decodeURIComponent(markDataUri('light', 'nova', 'teal'))).toContain('#ffffff')
  })

  it('is small enough to paint with the page', () => {
    expect(markDataUri('dark', 'nova', 'teal').length).toBeLessThan(1000)
  })
})

describe('the choice', () => {
  it('keeps the v3 swirl available as a fixed alternative', () => {
    const cosmic = APP_ICONS.find(i => i.key === 'cosmic')
    expect(cosmic).toBeTruthy()
    expect(cosmic!.href('dark', 'nova', 'teal')).toBe('/icons/icon-192.png')
    // Fixed means fixed: it ignores the theme, which is exactly why it is
    // not the default.
    expect(cosmic!.href('light', 'ember', 'teal')).toBe('/icons/icon-192.png')
  })

  it('defaults to the derived mark', () => {
    expect(DEFAULT_APP_ICON).toBe('mark')
    expect(appIconHref(DEFAULT_APP_ICON, 'dark', 'nova', 'teal')).toBe(
      markDataUri('dark', 'nova', 'teal'),
    )
  })

  it('an unknown key falls back rather than leaving a broken href', () => {
    expect(knownAppIcon('nope')).toBeNull()
    expect(knownAppIcon(42)).toBeNull()
    expect(appIconHref('nope', 'dark', 'nova', 'teal')).toBe(markDataUri('dark', 'nova', 'teal'))
  })

  it('every choice is selectable by its own key', () => {
    for (const choice of APP_ICONS) {
      expect(knownAppIcon(choice.key)).toBe(choice.key)
    }
  })
})
