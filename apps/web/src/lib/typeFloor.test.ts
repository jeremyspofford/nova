import { describe, it, expect } from 'vitest'
import resolveConfig from 'tailwindcss/resolveConfig'
// @ts-expect-error -- plain JS config, no declaration file
import tailwindConfig from '../../tailwind.config.js'
import { fontWordSpacing, fontChoices } from './fonts'
import { themeVariables } from '../stores/theme-store'

// 2026-10-11 (UI review R2/R8). Two type facts the eye kept reporting:
// words running together, and 11px carrying real data.

const sizes = resolveConfig(tailwindConfig).theme.fontSize as Record<string, [string, unknown]>
const px = (key: string) => Number(/calc\((\d+)px/.exec(sizes[key][0])![1])

describe('the type floor', () => {
  it('sets no named size under 12px', () => {
    for (const key of Object.keys(sizes)) {
      if (!/calc\(\d+px/.test(sizes[key][0])) continue
      expect(px(key), `text-${key}`).toBeGreaterThanOrEqual(12)
    }
  })
})

describe('word spacing per face', () => {
  // Measured from the shipped woff2 files with fontTools: Plus Jakarta's
  // space glyph is 0.170em; Inter's 0.281, Figtree's 0.250, Source Serif's
  // 0.237. Jakarta alone reads as run-on words, so it alone is opened up,
  // to ~0.25em.
  it('opens up Plus Jakarta only', () => {
    expect(fontWordSpacing('jakarta')).toBe('0.08em')
    for (const key of Object.keys(fontChoices).filter(k => k !== 'jakarta')) {
      expect(fontWordSpacing(key), key).toBe('normal')
    }
  })

  it('an unknown key falls back with the default face, spacing and all', () => {
    expect(fontWordSpacing('no-such-font')).toBe('0.08em')
  })

  it('is published by the theme for the chosen face', () => {
    expect(themeVariables('dark', 'nova', '', 1, 'jakarta')).toContain('--font-word-spacing:0.08em')
    expect(themeVariables('dark', 'nova', '', 1, 'inter')).toContain('--font-word-spacing:normal')
  })

  it('reaches the body, and never code', () => {
    const css = Object.values(
      import.meta.glob('/src/index.css', { query: '?raw', import: 'default', eager: true }),
    )[0] as string
    expect(css.length).toBeGreaterThan(1000)
    expect(css).toMatch(/body\s*\{[^}]*word-spacing:\s*var\(--font-word-spacing,\s*normal\)/)
    expect(css).toMatch(/code,\s*pre,\s*kbd,\s*samp,\s*\.font-mono\s*\{[^}]*word-spacing:\s*normal/)
  })
})
