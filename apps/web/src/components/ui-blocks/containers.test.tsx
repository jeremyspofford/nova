import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { validateBlock, type Registry } from './validate'
import type { BlockDef } from './types'
import { block as text } from './text'
import { block as title } from './title'
import { block as icon } from './icon'
import { block as divider } from './divider'
import { block as badge } from './badge'
import { block as stack } from './stack'
import { block as row } from './row'
import { block as card } from './card'
import { PRIMITIVES, RenderNode, nodeSchema } from './node'
import { TONES } from './tokens'

const CONTAINERS: BlockDef[] = [stack, row, card]
const ALL: BlockDef[] = [text, title, icon, divider, badge, stack, row, card]
const REG: Registry = Object.fromEntries(ALL.map((b) => [b.type, b]))
const ok = (b: BlockDef, v: unknown) => b.schema.safeParse(v).success

const T = (s = 'x') => ({ type: 'text', text: s })
const box = (type: string, children: unknown[]) => ({ type, children })

/** Every `text` string on a leaf anywhere in the tree. */
function leafTexts(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(leafTexts)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const own = typeof o.text === 'string' ? [o.text] : []
    return [...own, ...Object.values(o).flatMap(leafTexts)]
  }
  return []
}

describe('container primitives (S54a T4)', () => {
  it('T4-C1 stack/row/card export the block shape; examples nest leaves and validate', () => {
    expect(CONTAINERS.map((b) => b.type)).toEqual(['stack', 'row', 'card'])
    for (const b of CONTAINERS) {
      expect(b.describe.trim().length).toBeGreaterThan(0)
      expect(b.example.type).toBe(b.type)
      expect(Array.isArray(b.example.children)).toBe(true)
      expect(leafTexts(b.example).length).toBeGreaterThan(0)
      expect(ok(b, b.example)).toBe(true)
      expect(validateBlock(JSON.stringify(b.example), REG).ok).toBe(true)
    }
  })

  it('T4-C2 a nested example renders every leaf text', () => {
    for (const b of CONTAINERS) {
      const { container } = render(<b.Render {...b.example} />)
      const words = leafTexts(b.example)
      expect(words.length).toBeGreaterThan(0)
      for (const w of words) expect(container.textContent).toContain(w)
    }
  })

  it('T4-C3 nodeSchema accepts any primitive recursively and rejects unknown or bad children', () => {
    const tree = box('stack', [title.example, box('card', [box('row', [T('a'), icon.example, badge.example])]), divider.example])
    expect(nodeSchema.safeParse(tree).success).toBe(true)
    expect(ok(stack, tree)).toBe(true)
    expect(ok(stack, box('stack', [{ type: 'script', src: 'x' }]))).toBe(false)
    expect(ok(stack, box('stack', [box('row', [{ type: 'text', text: 'x', style: 'color:#fff' }])]))).toBe(false)
    expect(ok(stack, box('stack', []))).toBe(false)
    expect(PRIMITIVES.map((b) => b.type).sort()).toEqual(ALL.map((b) => b.type).sort())
  })

  it('T4-C4 RenderNode draws a mixed tree by type; an unknown type draws nothing', () => {
    const tree = box('stack', [title.example, box('row', [T('left'), T('right')]), box('card', [T('inside')])])
    const { container } = render(<RenderNode node={tree} />)
    for (const w of ['left', 'right', 'inside', String(title.example.text)]) expect(container.textContent).toContain(w)
    const unknown = render(<RenderNode node={{ type: 'script', text: 'boom' }} />)
    expect(unknown.container.textContent).not.toContain('boom')
  })

  it('T4-C5 card tone maps to a theme class, never an inline colour; a hex tone is rejected', () => {
    expect(ok(card, { type: 'card', tone: '#23354D', children: [T()] })).toBe(false)
    for (const t of ['success', 'danger', 'accent'] as const) {
      const node = { type: 'card', tone: t, children: [T('toned')] }
      expect(ok(card, node)).toBe(true)
      const { container } = render(<card.Render {...node} />)
      const el = container.querySelector('[data-block="card"]')
      expect(el).not.toBeNull()
      expect(el!.className).toContain(t)
      expect(container.querySelector('[style]')).toBeNull()
    }
  })

  it('T4-C6 via validateBlock, depth 4 passes but depth 5 fails, 40 nodes pass but 41 fail', () => {
    const d4 = box('stack', [box('card', [box('row', [T()])])])
    expect(validateBlock(JSON.stringify(d4), REG).ok).toBe(true)
    const d5 = box('stack', [box('card', [box('row', [box('stack', [T()])])])])
    const r5 = validateBlock(JSON.stringify(d5), REG)
    expect(r5.ok).toBe(false)
    if (!r5.ok) expect(r5.error).toMatch(/depth/)
    const n40 = box('stack', Array.from({ length: 39 }, () => T()))
    expect(validateBlock(JSON.stringify(n40), REG).ok).toBe(true)
    const n41 = box('stack', Array.from({ length: 40 }, () => T()))
    const r41 = validateBlock(JSON.stringify(n41), REG)
    expect(r41.ok).toBe(false)
    if (!r41.ok) expect(r41.error).toMatch(/nodes/)
  })

  it('T4-C5b every tone (all five) maps to a card class naming it', () => {
    for (const t of TONES) {
      const { container } = render(<card.Render type="card" tone={t} children={[T('toned')]} />)
      expect(container.querySelector('[data-block="card"]')!.className).toContain(t)
    }
  })

  it('T4-C4b a prototype-key type ("constructor") draws nothing and does not crash', () => {
    const { container } = render(<RenderNode node={{ type: 'constructor', text: 'boom' }} />)
    expect(container.textContent).toBe('')
  })
})
