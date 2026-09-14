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
 * ## The swirl is kept, as a choice
 * It is a good piece of art and Jeremy asked for it to stay available. It
 * lives here as an option rather than as the default, which is also the
 * shape any future icon wants: add an entry, and the picker offers it.
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

export const APP_ICONS: AppIconChoice[] = [
  {
    key: 'mark',
    label: 'Nova mark',
    description: "The app's own N, in whatever accent the current theme uses.",
    href: markDataUri,
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
