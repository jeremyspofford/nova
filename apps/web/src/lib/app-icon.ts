import { resolvePalette } from './color-palettes'

/**
 * The icon in the browser tab, on the phone's home screen, and in the
 * bookmark bar.
 *
 * ## Why this is not just a PNG in public/
 * The first version of this WAS a PNG — v3's cosmic swirl, carried over
 * wholesale. Jeremy's answer: wrong icon. And looking at the running app
 * makes the reason obvious. Nova's own mark, the one on the sign-in page
 * and in the sidebar, is a rounded square in the theme's accent with an N
 * in it. The swirl belongs to a different visual language, and — worse for
 * a product whose themes are whole palettes — it is FIXED, so picking the
 * Ember theme leaves an unrelated blue-violet mark in the tab.
 *
 * So the default icon is DERIVED from the live palette, exactly like every
 * other colour in the app: same accent, same neutral, same mark. Switch
 * theme and the tab follows.
 *
 * ## The others are kept, as choices
 * The v3 swirl is good art and Jeremy asked for it to stay available. The
 * v2 orb — `dashboard/public/icons/nova-{192,512}.png`, deleted at the v3
 * greenfield start — is the only orb this repo ever carried, and it is the
 * one he remembers. Both live here as options rather than defaults, which
 * is the shape any future icon wants: add an entry, and the picker offers
 * it.
 *
 * The orb is REDRAWN rather than restored, for the same reason the mark is
 * drawn rather than shipped: the original is a fixed teal PNG, and a fixed
 * anything is stranded the moment the palette moves. As an SVG it is the
 * same orb on the Nova theme, and an amber one on Ember.
 */

export interface AppIconChoice {
  key: string
  label: string
  description: string
  /** The href for <link rel="icon">, given the live theme. A fixed asset
   *  ignores its arguments; a derived one paints itself from them. */
  href: (mode: 'light' | 'dark', preset: string, customAccent: string) => string
}

export const DEFAULT_APP_ICON = 'mark'

/** The glyph, as the sidebar draws it: one letter, centred, in the weight
 *  the rest of the app uses for it. Kept in one place so the tab icon and
 *  the sidebar cannot drift apart. */
const GLYPH = 'N'

function rgb(triple: string): string {
  return `rgb(${triple})`
}

/**
 * Nova's mark as an SVG data URI, painted from the palette that is on
 * screen right now.
 *
 * A data URI rather than a file: the colours are not known until a theme is
 * resolved, and there is no build step that could know them. It is small
 * (a few hundred bytes), so the tab paints with the page.
 */
export function markDataUri(
  mode: 'light' | 'dark',
  preset: string,
  customAccent: string,
): string {
  const { accent, neutral } = resolvePalette(preset, customAccent)
  // The fill is the accent step the sidebar's own mark uses, and the glyph
  // is what index.css puts ON an accent fill in this mode: the deepest
  // neutral in dark, white in light. Same two rules, one place.
  const fill = rgb(accent[500])
  const glyph = mode === 'dark' ? rgb(neutral[950]) : '#ffffff'
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `<rect width="64" height="64" rx="16" fill="${fill}"/>`,
    `<text x="32" y="33" fill="${glyph}" font-family="system-ui,-apple-system,`,
    `'Segoe UI',sans-serif" font-size="38" font-weight="600" text-anchor="middle" `,
    `dominant-baseline="central">${GLYPH}</text>`,
    `</svg>`,
  ].join('')
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * The v2 orb: a soft radial glow on near-black, in the theme's accent.
 *
 * Redrawn from `dashboard/public/icons/nova-512.png` (commit 35036c52,
 * 2026-05-15), which was deleted eight weeks later when v3 cleared the v2
 * tree. That original is teal because v2 had one accent; this one takes
 * whichever the theme is using, so the Nova theme gives back the orb as it
 * was and Ember gives a yellow one.
 *
 * The gradient is the whole character of it — a bright core at 300, the
 * body at 500, then a wide soft falloff into the ground — so the stops are
 * palette steps rather than hand-mixed colours, and every theme keeps the
 * same depth.
 */
export function orbDataUri(
  mode: 'light' | 'dark',
  preset: string,
  customAccent: string,
): string {
  const { accent, neutral } = resolvePalette(preset, customAccent)
  // The orb glows, so it wants a dark ground even in light mode — the
  // original sat on v2's near-black and a pale ground washes the falloff
  // out completely.
  const ground = rgb(neutral[950])
  const core = rgb(accent[300])
  const body = rgb(accent[500])
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    // The falloff completes INSIDE the circle, so the sphere has no hard
    // edge and bleeds into the ground — that soft halo is the whole
    // character of the original, and a gradient that finishes at the
    // circle's rim reads as a flat ball instead.
    `<defs><radialGradient id="g" cx="46%" cy="42%" r="50%">`,
    `<stop offset="0%" stop-color="${core}"/>`,
    `<stop offset="38%" stop-color="${body}"/>`,
    `<stop offset="62%" stop-color="${body}" stop-opacity="0.92"/>`,
    `<stop offset="82%" stop-color="${body}" stop-opacity="0.35"/>`,
    `<stop offset="100%" stop-color="${body}" stop-opacity="0"/>`,
    `</radialGradient></defs>`,
    `<rect width="64" height="64" rx="12" fill="${ground}"/>`,
    `<circle cx="32" cy="32" r="32" fill="url(#g)"/>`,
    `</svg>`,
  ].join('')
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export const APP_ICONS: AppIconChoice[] = [
  {
    key: 'mark',
    label: 'Nova mark',
    description: "The app's own N, in whatever accent the current theme uses.",
    href: markDataUri,
  },
  {
    key: 'orb',
    label: 'Orb',
    description: "The v2 orb, redrawn: a soft glow in the theme's accent.",
    href: orbDataUri,
  },
  {
    // Asked for by name, twice. The theme-following orb above gives a
    // yellow one only on the amber themes, and "the yellow orb" should not
    // depend on which theme happens to be on.
    key: 'orb-amber',
    label: 'Orb (amber)',
    description: 'The same orb, pinned to amber whatever the theme is.',
    href: (mode, _preset, _customAccent) => orbDataUri(mode, 'ember', 'amber'),
  },
  {
    key: 'cosmic',
    label: 'Cosmic swirl',
    description: 'The v3 app icon: a swirl of nebula that reads as an N. Fixed colours.',
    href: () => '/icons/icon-192.png',
  },
]

export function knownAppIcon(key: unknown): string | null {
  return typeof key === 'string' && APP_ICONS.some(i => i.key === key) ? key : null
}

export function appIconHref(
  key: string,
  mode: 'light' | 'dark',
  preset: string,
  customAccent: string,
): string {
  const choice = APP_ICONS.find(i => i.key === key) ?? APP_ICONS[0]
  return choice.href(mode, preset, customAccent)
}
