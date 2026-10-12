import { describe, it, expect } from 'vitest'
import { neutralPalettes } from './color-palettes'
import { contrastRatio } from '../stores/theme-store'

// 2026-10-11, the light-mode pass. Two things looked fine in dark mode and
// were invisible or unreadable in light.

const SHEETS = import.meta.glob(['/src/index.css', '/src/components/highlight.css'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const css = (path: string) => SHEETS[path] ?? ''

/** `--name: var(--neutral-N)` inside the block that starts at `selector {`. */
function neutralStep(sheet: string, selector: string, name: string): string {
  // index.css opens `:root {` more than once; read every block it opens.
  for (const [, block] of sheet.matchAll(new RegExp(`^${selector.replace('.', '\\.')} \\{([\\s\\S]*?)^\\}`, 'gm'))) {
    const m = new RegExp(`--${name}:\\s*var\\(--neutral-(\\d+)\\)`).exec(block)
    if (m) return m[1]
  }
  throw new Error(`--${name} is not a neutral step under ${selector}`)
}

const withoutComments = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the "you are here" fill', () => {
  it('differs from the sidebar ground in both modes', () => {
    const sheet = css('/src/index.css')
    expect(sheet.length).toBeGreaterThan(1000)
    for (const mode of [':root', 'html.dark']) {
      expect(neutralStep(sheet, mode, 'surface-selected'), mode).not.toBe(neutralStep(sheet, mode, 'surface-sidebar'))
    }
  })
})

describe('the sidebar and drawer separators', () => {
  // border-subtle IS the sidebar's own step in light mode (neutral-100), so
  // a rule drawn with it on the sidebar was invisible there.
  const SOURCES = import.meta.glob(
    ['/src/components/layout/Sidebar.tsx', '/src/components/layout/MobileNav.tsx'],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>

  it('the default border differs from the sidebar ground in both modes', () => {
    const sheet = css('/src/index.css')
    for (const mode of [':root', 'html.dark']) {
      expect(neutralStep(sheet, mode, 'border-default'), mode).not.toBe(neutralStep(sheet, mode, 'surface-sidebar'))
    }
  })

  it('draws no rule on the sidebar or drawer in border-subtle', () => {
    expect(Object.keys(SOURCES)).toHaveLength(2)
    for (const [path, src] of Object.entries(SOURCES)) {
      expect(src, path).not.toMatch(/bg-border-subtle|border-[tb] border-border-subtle/)
    }
  })
})

describe('code colours on the code block', () => {
  // The block is dark in BOTH modes (neutral-900/950), so its token colours
  // must not follow the mode. They used theme('colors.success') etc., which
  // since the status tiers became per-mode resolve to 700-800 shades in
  // light mode: dark green on near-black.
  it('names no mode-flipping status colour', () => {
    const sheet = withoutComments(css('/src/components/highlight.css'))
    expect(sheet.length).toBeGreaterThan(500)
    expect(sheet).not.toMatch(/theme\('colors\.(success|warning|info|danger)/)
    expect(sheet).not.toMatch(/var\(--status-/)
  })

  it('every literal colour reads at 4.5:1 on the block, in every neutral palette', () => {
    const sheet = css('/src/components/highlight.css')
    const literals = [...sheet.matchAll(/color:\s*rgb\((\d+) (\d+) (\d+)\)/g)].map(m => `${m[1]} ${m[2]} ${m[3]}`)
    expect(literals.length).toBeGreaterThan(0)
    for (const [name, scale] of Object.entries(neutralPalettes)) {
      for (const lit of literals) {
        expect(contrastRatio(lit, scale[900]), `${lit} on ${name} 900`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('the inline code pill', () => {
  // In light themes surface-elevated is one step off the page (100 on 50) —
  // the pill behind `code` all but vanished, worst in Daylight (2026-10-11).
  const PILLS = import.meta.glob(
    ['/src/components/Markdown.tsx', '/src/components/ui/Code.tsx', '/src/components/ui/CopyableId.tsx'],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>

  it('sits on surface-selected, two steps off the page in light and unchanged in dark', () => {
    const sheet = css('/src/index.css')
    expect(neutralStep(sheet, ':root', 'surface-selected')).not.toBe(neutralStep(sheet, ':root', 'surface-elevated'))
    expect(neutralStep(sheet, 'html.dark', 'surface-selected')).toBe(neutralStep(sheet, 'html.dark', 'surface-elevated'))
    for (const [path, src] of Object.entries(PILLS)) {
      expect(src, path).toMatch(/'[^']*font-mono text-mono-sm bg-surface-selected/)
    }
  })
})
