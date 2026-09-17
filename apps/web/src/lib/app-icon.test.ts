/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import {
  APP_ICONS,
  DEFAULT_APP_ICON,
  allTouchIcons,
  appIconHref,
  knownAppIcon,
  markDataUri,
  orbDataUri,
  touchIconHref,
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

describe('the home-screen icon', () => {
  /**
   * 2026-09-17. Jeremy: "why isn't my PWA ever updating the Nova icon on my
   * iphone? I need that to change when I change settings."
   *
   * Two things were true at once. The Appearance hint said the choice was
   * "shown ... on a phone's home screen", and the code moved only
   * <link rel="icon">; <link rel="apple-touch-icon"> was a fixed PNG. And
   * iOS copies that PNG ONCE, when the app is added, and never fetches it
   * again — so nothing served later can move an installed icon.
   *
   * What CAN be true: the choice decides which file iOS is handed the next
   * time Nova is added. That takes a real PNG per reachable (choice, theme),
   * because iOS will not take an SVG or a data: URI there, and a matching
   * touch link that follows the choice.
   */
  it('is a file, named for exactly the inputs the picture depends on', () => {
    // The mark: accent fill, glyph from the neutral (dark) or white (light).
    expect(touchIconHref('mark', 'dark', 'nova', 'teal')).toBe('/icons/touch/mark-teal-stone-dark.png')
    expect(touchIconHref('mark', 'light', 'nova', 'teal')).toBe('/icons/touch/mark-teal-stone-light.png')
    expect(touchIconHref('mark', 'dark', 'ember', 'teal')).toBe('/icons/touch/mark-amber-ember-dark.png')
    // A custom theme takes the browser's own accent on the Nova neutrals.
    expect(touchIconHref('mark', 'dark', 'custom', 'rose')).toBe('/icons/touch/mark-rose-stone-dark.png')
    // The orb has no ground to flip, so mode is not in its name.
    expect(touchIconHref('orb', 'dark', 'nova', 'teal')).toBe('/icons/touch/orb-teal.png')
    expect(touchIconHref('orb', 'light', 'nova', 'teal')).toBe('/icons/touch/orb-teal.png')
    expect(touchIconHref('orb', 'dark', 'nebula', 'teal')).toBe('/icons/touch/orb-violet.png')
    // Fixed means fixed.
    expect(touchIconHref('orb-amber', 'light', 'nova', 'teal')).toBe('/icons/touch/orb-amber.png')
    expect(touchIconHref('cosmic', 'dark', 'ember', 'rose')).toBe('/icons/touch/cosmic.png')
    // An unknown key lands on the default's file, like the tab icon does.
    expect(touchIconHref('nope', 'dark', 'nova', 'teal')).toBe(
      touchIconHref(DEFAULT_APP_ICON, 'dark', 'nova', 'teal'),
    )
  })

  it('a theme-following file differs from the fixed amber one off the amber themes', () => {
    expect(touchIconHref('orb', 'dark', 'nova', 'teal')).not.toBe(touchIconHref('orb-amber', 'dark', 'nova', 'teal'))
    expect(touchIconHref('orb', 'dark', 'ember', 'teal')).toBe(touchIconHref('orb-amber', 'dark', 'ember', 'teal'))
  })

  it('every file the app can hand a phone exists, and nothing else is there', () => {
    // The tripwire. A new preset, accent or icon choice widens the set the
    // store can name; the files are committed output of
    // scripts/make-icons.mjs, so this is the line that goes red until it
    // has been re-run — rather than iOS quietly showing a broken image.
    const named = new Set([...allTouchIcons().keys()].map(n => `${n}.png`))
    // vite lists the directory at transform time (the same TOUCH_ICON_DIR,
    // spelled as a literal because a glob has to be one).
    const onDisk = new Set(
      Object.keys(import.meta.glob('../../public/icons/touch/*.png')).map(f => f.split('/').pop()!),
    )
    expect([...named].filter(f => !onDisk.has(f))).toEqual([])
    expect([...onDisk].filter(f => !named.has(f))).toEqual([])
    expect(named.size).toBeGreaterThan(APP_ICONS.length)
  })

  it('the reachable set covers every preset, both modes and every custom accent', () => {
    const all = allTouchIcons()
    expect(all.get('mark-teal-stone-dark')).toEqual({ key: 'mark', mode: 'dark', preset: 'nova', customAccent: 'teal' })
    expect(all.has('mark-teal-stone-light')).toBe(true)
    expect(all.has('mark-rose-stone-light')).toBe(true)
    expect(all.has('orb-rose')).toBe(true)
    expect(all.has('cosmic')).toBe(true)
  })
})
