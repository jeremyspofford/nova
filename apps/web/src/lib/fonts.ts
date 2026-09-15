/**
 * The interface font, chosen by the operator and SELF-HOSTED.
 *
 * Every face here ships in the bundle via `@fontsource-variable/*`, the same
 * way `geist-mono` already did, rather than through a `<link>` to Google.
 * Two reasons, both of which matter more for this product than for a normal
 * web app: a font request tells Google the IP of every household running a
 * private assistant, and a self-hosted assistant that has to reach the
 * internet to draw its own text is not self-hosted. They are pulled in on
 * DEMAND, so choosing one costs one file and the other families are never
 * downloaded.
 *
 * ON "THE FONT CLAUDE USES": it is Styrene A/B for the interface and Tiempos
 * Text for the serif, both licensed from Commercial Type. They cannot be
 * redistributed in an open-source bundle, so they are not here and nothing
 * below claims to be them. Inter is the closest freely-licensed neo-grotesque
 * and is what the Claude theme is drawn against. If you hold a Styrene
 * licence and have it installed, `custom` takes the family name directly.
 */

export type FontChoice = {
  label: string
  description: string
  /** What `--font-sans` is set to. Always ends in a generic family, so a
   *  face that fails to load still renders as the right KIND of type. */
  stack: string
  /** Pulls the face in on demand. Absent means there is nothing to fetch —
   *  the system stack, or a family the operator already has installed. */
  load?: () => Promise<unknown>
}

export const DEFAULT_FONT = 'jakarta'

export const fontChoices: Record<string, FontChoice> = {
  jakarta: {
    label: 'Plus Jakarta Sans',
    description: "Nova's own. Geometric, slightly rounded, a little warm.",
    stack: '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, -apple-system, sans-serif',
    load: () => import('@fontsource-variable/plus-jakarta-sans'),
  },
  inter: {
    label: 'Inter',
    description: 'A neutral neo-grotesque built for screens — the closest free stand-in for the type Claude uses.',
    stack: '"Inter Variable", Inter, system-ui, -apple-system, sans-serif',
    load: () => import('@fontsource-variable/inter'),
  },
  figtree: {
    label: 'Figtree',
    description: 'Warmer and rounder than Inter, with a large x-height.',
    stack: '"Figtree Variable", Figtree, system-ui, -apple-system, sans-serif',
    load: () => import('@fontsource-variable/figtree'),
  },
  'source-serif': {
    label: 'Source Serif 4',
    description: 'A serif for the whole interface. Reads long-form; unusual for an app.',
    stack: '"Source Serif 4 Variable", "Source Serif 4", Georgia, serif',
    load: () => import('@fontsource-variable/source-serif-4'),
  },
  system: {
    label: 'System',
    description: "Whatever this device uses for its own interface. Nothing to download.",
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  },
  custom: {
    label: 'Installed font',
    description: 'Name a family installed on this device — a licensed face this project cannot ship.',
    stack: '',
    // Nothing to fetch: if it is not installed, the fallback below renders.
  },
}

export function knownFont(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(fontChoices, raw) ? raw : null
}

/**
 * An operator-typed family name, made safe to put in a stylesheet.
 *
 * This value reaches the page inside a `<style>` element's text, so a name
 * carrying `}` or `;` would close the rule and let whatever follows through
 * as CSS — self-inflicted here, but the repo's rule is that a property is
 * held by the code and not by the expectation that nobody types a brace.
 * Letters, digits, spaces, hyphens and underscores are every character a
 * real family name needs; everything else is dropped rather than escaped,
 * because a name that needs escaping is a name nobody meant to type.
 */
export function sanitizeFamily(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 64)
}

/** The value `--font-sans` is published as. */
export function fontStack(key: string, customFamily = ''): string {
  if (key === 'custom') {
    const family = sanitizeFamily(customFamily)
    // An empty or fully-stripped name falls back to the default face rather
    // than publishing a stack that starts with nothing.
    if (!family) return fontChoices[DEFAULT_FONT].stack
    return `"${family}", ${fontChoices[DEFAULT_FONT].stack}`
  }
  return (fontChoices[knownFont(key) ?? DEFAULT_FONT] ?? fontChoices[DEFAULT_FONT]).stack
}

const loaded = new Set<string>()

/** Fetch the chosen face, once per session. Never rejects: a font that fails
 *  to arrive leaves the stack's fallback rendering, which is a worse-looking
 *  page and not a broken one. */
export async function loadFont(key: string): Promise<void> {
  const choice = fontChoices[knownFont(key) ?? DEFAULT_FONT]
  if (!choice?.load || loaded.has(key)) return
  loaded.add(key)
  try {
    await choice.load()
  } catch {
    loaded.delete(key)
  }
}
