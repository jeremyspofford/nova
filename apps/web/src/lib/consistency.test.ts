import { describe, it, expect } from 'vitest'

// UI review R10 leftovers (2026-10-11): one control, one look. Routing's
// toggles were the small size while every other settings toggle was the
// default; Spend drew its provider rows as bare bordered divs, not Cards.

const SOURCES = import.meta.glob(['/src/pages/**/*.tsx', '!/src/pages/**/*.test.tsx', '!/src/pages/dev/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('one look per control', () => {
  it('no page draws a small toggle (the gallery shows the size, nothing uses it)', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(30)
    const small = Object.entries(SOURCES)
      .filter(([, src]) => /<Toggle\b[^>]*\bsize="sm"/s.test(src))
      .map(([p]) => p)
    expect(small).toEqual([])
  })

  it('Spend draws its provider rows as Cards', () => {
    const spend = SOURCES['/src/pages/spend/SpendPage.tsx']
    expect(spend).not.toMatch(/<div[^>]*className="rounded-md border border-border px-4 py-3/)
    expect(spend).toMatch(/<Card [^>]*data-testid=\{`spend-provider-/)
  })
})
