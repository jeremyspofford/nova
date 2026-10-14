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

// T18 (verification 2-7): the label is absolutely positioned in the cell's
// left gutter, so a cell shorter than the label (an empty Tools cell, a
// one-line micro value) lets it spill onto the next line's label.
describe('T18 — a stacked cell is never shorter than its label', () => {
  /** The whole `@media (max-width: 767px)` block that holds the stack rules. */
  function stackBlock(): string {
    const anchor = css.indexOf('.stack-table > thead')
    const start = css.lastIndexOf('@media (max-width: 767px)', anchor)
    let depth = 0
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
    }
    throw new Error('unbalanced stack block')
  }

  /** Every `selector { body }` rule inside a block (one level of nesting). */
  function rules(block: string): { selector: string; body: string }[] {
    const inner = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'))
    const out: { selector: string; body: string }[] = []
    for (const m of inner.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ selector: m[1].trim(), body: m[2] })
    }
    return out
  }

  function rem(body: string, prop: string): number | null {
    const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([0-9.]+)rem`))
    return m ? Number(m[1]) : null
  }

  const CELL_SELECTORS = [
    '.stack-table > tbody > tr > td',
    '.stack-table > tbody > tr > td[data-label]',
  ]

  /** The min-height (rem) the stack block gives every labelled body cell. */
  function cellMinHeight(): number | null {
    for (const r of rules(stackBlock())) {
      const selectors = r.selector.split(',').map(s => s.trim())
      if (selectors.some(s => CELL_SELECTORS.includes(s))) {
        const v = rem(r.body, 'min-height')
        if (v !== null) return v
      }
    }
    return null
  }

  it('C1: every labelled body cell of every stacked table gets a min-height (no :empty, no page class)', () => {
    expect(cellMinHeight(), 'no min-height on .stack-table > tbody > tr > td[data-label] (or td)').not.toBeNull()
  })

  it('C2: that min-height covers the label: >= the ::before top + line-height, read from the stylesheet', () => {
    const label = rules(stackBlock()).find(r => r.selector.endsWith('td[data-label]::before'))
    expect(label, 'the label rule is gone').toBeDefined()
    const top = rem(label!.body, 'top')
    const lineHeight = rem(label!.body, 'line-height')
    expect(top).not.toBeNull()
    expect(lineHeight).not.toBeNull()
    const minHeight = cellMinHeight()
    expect(minHeight, 'no stacked-cell min-height').not.toBeNull()
    expect(minHeight!).toBeGreaterThanOrEqual(top! + lineHeight!)
  })

  it('C3: the min-height lives only in the stacked block: desktop table cells keep their own height', () => {
    expect(cellMinHeight(), 'no stacked-cell min-height').not.toBeNull()
    const block = stackBlock()
    const outside = css.slice(0, css.indexOf(block)) + css.slice(css.indexOf(block) + block.length)
    for (const m of outside.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].includes('stack-table')) expect(m[2]).not.toMatch(/min-height/)
    }
  })
})
