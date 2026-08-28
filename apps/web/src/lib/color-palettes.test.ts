import { describe, it, expect } from 'vitest'
import { accentPalettes } from './color-palettes'

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const

describe('accentPalettes', () => {
  it('teal resolves to the custom Nova accent (500 = #19A89E)', () => {
    expect(accentPalettes.teal[500]).toBe('25 168 158')
  })

  it('tailwind-teal preserves the original stock Tailwind teal scale', () => {
    expect(accentPalettes['tailwind-teal']).toBeDefined()
    expect(accentPalettes['tailwind-teal'][500]).toBe('20 184 166')
  })

  it('every accent palette has the full 50..950 scale', () => {
    for (const [name, scale] of Object.entries(accentPalettes)) {
      for (const shade of SHADES) {
        expect(scale[shade], `${name}.${shade} should be a non-empty RGB triplet`).toBeTruthy()
      }
    }
  })
})
