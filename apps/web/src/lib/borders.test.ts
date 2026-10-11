import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { themePresets, resolvePalette } from './color-palettes'
import { contrastRatio, themeVariables } from '../stores/theme-store'
import { Checkbox } from '../components/ui/Checkbox'
import { Toggle } from '../components/ui/Toggle'

// UI review R6 (2026-10-06), fixed 2026-10-11: borders and tracks that
// shared a step with the surface under them, so unchecked boxes, unselected
// radios, off toggles and card edges were invisible.

const SHEETS = import.meta.glob(['/src/index.css', '/src/components/ui/*.tsx', '/src/components/Markdown.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function neutralStep(sheet: string, selector: string, name: string): string {
  for (const [, block] of sheet.matchAll(new RegExp(`^${selector.replace('.', '\\.')} \\{([\\s\\S]*?)^\\}`, 'gm'))) {
    const m = new RegExp(`--${name}:\\s*var\\(--neutral-(\\d+)\\)`).exec(block)
    if (m) return m[1]
  }
  throw new Error(`--${name} is not a neutral step under ${selector}`)
}

const tier = (vars: string, name: string) => new RegExp(`--tier-${name}:(\\d+ \\d+ \\d+)`).exec(vars)?.[1]

describe('the control border (checkbox, radio, outline button, off toggle)', () => {
  it('clears 3:1 on the page, the card and an input in every theme and mode', () => {
    for (const preset of Object.keys(themePresets)) {
      for (const mode of ['light', 'dark'] as const) {
        const vars = themeVariables(mode, preset, 'teal', 1)
        const control = tier(vars, 'control')
        expect(control, `${preset}/${mode} publishes --tier-control`).toBeDefined()
        const { neutral, card } = resolvePalette(preset, 'teal')
        const grounds = mode === 'dark' ? [neutral[950], card.dark, neutral[800]] : [neutral[50], card.light, neutral[100]]
        for (const g of grounds) {
          expect(contrastRatio(control!, g), `${preset}/${mode} control on ${g}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('is what an unchecked checkbox and an off toggle draw with', () => {
    const { container } = render(createElement(Checkbox, { checked: false, onChange: () => {}, label: 'x' }))
    expect(container.innerHTML).toContain('border-border-control')
    const t = render(createElement(Toggle, { checked: false, onChange: () => {}, label: 'y' }))
    expect(t.container.innerHTML).toContain('bg-border-control')
  })

  it('is what an unselected radio and an outline button draw with', () => {
    expect(SHEETS['/src/components/ui/Radio.tsx']).toMatch(/: 'border-border-control'/)
    expect(SHEETS['/src/components/ui/Button.tsx']).toMatch(/outline:\s*\n?\s*'border border-border-control/)
  })
})

describe('lines are never the surface they sit on', () => {
  const sheet = SHEETS['/src/index.css']
  it('light: border-subtle is not the page, sidebar or elevated step', () => {
    const subtle = neutralStep(sheet, ':root', 'border-subtle')
    for (const s of ['surface-root', 'surface-sidebar', 'surface-elevated']) {
      expect(subtle, s).not.toBe(neutralStep(sheet, ':root', s))
    }
  })

  it('both modes: border-default is not the elevated step', () => {
    for (const mode of [':root', 'html.dark']) {
      expect(neutralStep(sheet, mode, 'border-default'), mode).not.toBe(neutralStep(sheet, mode, 'surface-elevated'))
    }
  })

  it('a progress track or a pending pipeline stage is not drawn in border-subtle', () => {
    expect(SHEETS['/src/components/ui/ProgressBar.tsx']).not.toMatch(/bg-border-subtle/)
    expect(SHEETS['/src/components/ui/PipelineStages.tsx']).not.toMatch(/bg-border-subtle/)
  })

  it('a code block in a reply has an edge in dark mode (it sat on the same 950 as the page)', () => {
    expect(SHEETS['/src/components/Markdown.tsx']).toMatch(/const PRE_BASE =[^\n]*\n?[^\n]*dark:border/)
  })
})
