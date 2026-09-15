import { describe, it, expect } from 'vitest'
import {
  APP_ICONS,
  DEFAULT_APP_ICON,
  appIconHref,
  knownAppIcon,
  markDataUri,
  orbDataUri,
} from './app-icon'
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
    // Its OWN file, and specifically NOT the manifest's. Both pointed at
    // `/icons/icon-192.png` until 2026-09-15; when that file became the orb,
    // "Cosmic swirl" would have started showing an orb with nothing in the
    // code looking wrong. The property worth pinning is the separation, so
    // it is asserted below as well as the path.
    expect(cosmic!.href('dark', 'nova', 'teal')).toBe('/icons/cosmic-192.png')
    // Fixed means fixed: it ignores the theme, which is exactly why it is
    // not the default.
    expect(cosmic!.href('light', 'ember', 'teal')).toBe('/icons/cosmic-192.png')
    // The home-screen icon is a different picture, and must stay one.
    expect(cosmic!.href('dark', 'nova', 'teal')).not.toBe('/icons/icon-192.png')
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

describe('the v2 orb, redrawn', () => {
  /**
   * `dashboard/public/icons/nova-{192,512}.png`, commit 35036c52
   * (2026-05-15), deleted eight weeks later when v3 cleared the v2 tree.
   * The only orb this repo ever carried, and the one Jeremy remembers.
   */
  it('glows in the theme accent, so Nova gives back the teal orb it was', () => {
    const teal = resolvePalette('nova')
    const uri = decodeURIComponent(orbDataUri('dark', 'nova', 'teal'))

    expect(uri).toContain('radialGradient')
    expect(uri).toContain(`rgb(${teal.accent[500]})`)
    expect(uri).toContain(`rgb(${teal.accent[300]})`)
  })

  it('fades to nothing INSIDE the circle — the halo is the whole character', () => {
    // A gradient that finishes at the rim reads as a flat ball. The last
    // stop must be fully transparent, or the sphere has a hard edge.
    const uri = decodeURIComponent(orbDataUri('dark', 'nova', 'teal'))
    expect(uri).toContain('offset="100%"')
    expect(uri).toMatch(/offset="100%"[^/]*stop-opacity="0"/)
  })

  it('carries no background of its own, so it sits on whatever is there', () => {
    // The v2 original baked v2's near-black into the PNG, which is a
    // background that travels with the icon and fights every surface it
    // lands on — a light browser tab, a dock, a home screen.
    const uri = decodeURIComponent(orbDataUri('dark', 'nova', 'teal'))
    expect(uri).not.toContain('<rect')
    const { neutral } = resolvePalette('nova')
    expect(uri).not.toContain(`rgb(${neutral[950]})`)
  })

  it('looks the same in light and dark, having no ground to flip', () => {
    expect(orbDataUri('light', 'nova', 'teal')).toEqual(orbDataUri('dark', 'nova', 'teal'))
  })

  it('the amber orb holds its colour whatever the theme is', () => {
    // "The yellow orb" should not depend on which theme happens to be on.
    const amber = resolvePalette('ember')
    const choice = APP_ICONS.find(i => i.key === 'orb-amber')!
    for (const preset of ['nova', 'nebula', 'ocean', 'daylight']) {
      expect(decodeURIComponent(choice.href('dark', preset, 'teal'))).toContain(
        `rgb(${amber.accent[500]})`,
      )
    }
  })

  it('the theme-following orb and the pinned one differ off the amber themes', () => {
    const following = APP_ICONS.find(i => i.key === 'orb')!.href('dark', 'nova', 'teal')
    const pinned = APP_ICONS.find(i => i.key === 'orb-amber')!.href('dark', 'nova', 'teal')
    expect(following).not.toEqual(pinned)
  })
})
