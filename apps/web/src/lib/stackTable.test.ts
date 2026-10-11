import { describe, it, expect } from 'vitest'

// The CSS half of R4 (the cells' labels are pinned per page by expectStacked).
const css = Object.values(
  import.meta.glob('/src/index.css', { query: '?raw', import: 'default', eager: true }),
)[0] as string

describe('stacked tables (index.css)', () => {
  const block = css.slice(css.indexOf('@media (max-width: 767px)'))

  it('stack below md, and only there', () => {
    expect(css).toContain('@media (max-width: 767px)')
    expect(block).toMatch(/\.stack-table > thead\s*\{\s*display: none/)
    expect(block).toMatch(/\.stack-table > tbody > tr\s*\{\s*display: block/)
  })

  it('label each value with its column', () => {
    expect(block).toMatch(/td\[data-label\]::before\s*\{\s*content: attr\(data-label\)/)
  })

  it('keep a hidden column hidden while stacking the rest', () => {
    expect(block).toMatch(/td\.hidden\s*\{\s*display: none/)
  })
})
