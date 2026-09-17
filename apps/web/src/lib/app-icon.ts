import { resolvePalette } from './color-palettes'

/**
 * Nova's marks: the one in the browser tab and the one beside her name in
 * the sidebar.
 *
 * TWO settings over ONE registry (asked for 2026-09-14). They are different
 * jobs — a favicon is a 16px silhouette in a crowded tab strip, a sidebar
 * mark sits at 28px next to a wordmark — and the icon that reads best at
 * one size is often not the one that reads best at the other. Every choice
 * is available to both.
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
  /** Does the art fill its tile edge to edge?
   *
   *  The sidebar gives a filled mark the rounded-square treatment and the
   *  accent glow that go with a solid shape; art that fades to transparency
   *  is left alone, because a glow drawn around a square tile behind a
   *  round orb looks like a mistake. A property rather than a name check,
   *  so a new icon declares what it is instead of the sidebar learning a
   *  list. */
  filled: boolean
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
 * body at 500, then a wide soft falloff to nothing — so the stops are
 * palette steps rather than hand-mixed colours, and every theme keeps the
 * same depth.
 *
 * The ground is TRANSPARENT, unlike the original. v2 baked its own
 * near-black into the PNG, which is a background that travels with the icon
 * and fights every surface it lands on — a light browser tab, a dock, a
 * home screen. Fading to nothing lets the orb sit on whatever is actually
 * there.
 */
export function orbDataUri(
  _mode: 'light' | 'dark',
  preset: string,
  customAccent: string,
): string {
  const { accent } = resolvePalette(preset, customAccent)
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
    // No ground rect: the orb is the icon, and the tile behind it is
    // whatever the browser, the dock or the home screen puts there. The
    // v2 original baked v2's near-black in, which is a background that
    // follows the icon around and fights every surface it lands on.
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
    filled: true,
    href: markDataUri,
  },
  {
    key: 'orb',
    label: 'Orb',
    description: "The v2 orb, redrawn: a soft glow in the theme's accent.",
    filled: false,
    href: orbDataUri,
  },
  {
    // Asked for by name, twice. The theme-following orb above gives a
    // yellow one only on the amber themes, and "the yellow orb" should not
    // depend on which theme happens to be on.
    key: 'orb-amber',
    label: 'Orb (amber)',
    description: 'The same orb, pinned to amber whatever the theme is.',
    filled: false,
    href: (mode, _preset, _customAccent) => orbDataUri(mode, 'ember', 'amber'),
  },
  {
    key: 'cosmic',
    label: 'Cosmic swirl',
    description: 'The v3 app icon: a swirl of nebula that reads as an N. Fixed colours.',
    filled: false,
    // Its OWN file. This read `/icons/icon-192.png` until 2026-09-15, when
    // the home-screen icons became the orb — at which point "Cosmic swirl"
    // would have quietly started showing an orb, and nothing in the code
    // would have looked wrong.
    href: () => '/icons/cosmic-192.png',
  },
]

export function knownAppIcon(key: unknown): string | null {
  return typeof key === 'string' && APP_ICONS.some(i => i.key === key) ? key : null
}

export function appIcon(key: string): AppIconChoice {
  return APP_ICONS.find(i => i.key === key) ?? APP_ICONS[0]
}

export function appIconHref(
  key: string,
  mode: 'light' | 'dark',
  preset: string,
  customAccent: string,
): string {
  return appIcon(key).href(mode, preset, customAccent)
}
