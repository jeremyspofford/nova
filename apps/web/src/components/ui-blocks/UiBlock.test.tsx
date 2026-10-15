import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { UI_BLOCKS } from './index'
import { UiBlock } from './UiBlock'
import { UiBlocksContext, type UiBlocksCtx } from './context'
import { validateBlock } from './validate'
import { PRIMITIVES } from './node'
import { block as steps } from './steps'
import { block as layers } from './layers'
import { block as timeline } from './timeline'
import { block as compare } from './compare'
import { block as callout } from './callout'
import { block as choices } from './choices'

// The full vocabulary, built here from the block files themselves, so the
// expected errors below do not depend on the registry under test.
const ALL = [...PRIMITIVES, steps, layers, timeline, compare, callout, choices]
const FULL = Object.fromEntries(ALL.map(b => [b.type, b]))

const CAPTION = /couldn.t draw this block: /

function draw(source: string, ctx: Partial<UiBlocksCtx> = {}) {
  const value: UiBlocksCtx = { onSend: vi.fn(), answered: false, streaming: false, ...ctx }
  return render(
    <UiBlocksContext.Provider value={value}>
      <UiBlock source={source} />
    </UiBlocksContext.Provider>,
  ).container
}

afterEach(cleanup)

describe('T9 — UI_BLOCKS, the registry', () => {
  it('T9-C1 holds exactly the 14 types, each keyed by its own type, every example valid against it', () => {
    expect(Object.keys(UI_BLOCKS).sort()).toEqual(ALL.map(b => b.type).sort())
    expect(Object.keys(UI_BLOCKS)).toHaveLength(14)
    for (const [key, def] of Object.entries(UI_BLOCKS)) {
      expect(def.type).toBe(key)
      expect(validateBlock(JSON.stringify(def.example), UI_BLOCKS)).toEqual({ ok: true, block: def.example })
    }
  })
})

describe('T9 — <UiBlock source>', () => {
  it('T9-C2 a valid block draws its component, not code', () => {
    const c = draw(JSON.stringify(steps.example))
    for (const item of steps.example.items as { title: string }[]) {
      expect(screen.getByText(item.title)).toBeDefined()
    }
    expect(c.querySelector('pre')).toBeNull()
    expect(c.textContent).not.toMatch(CAPTION)
  })

  it.each([
    ['bad JSON', '{"type": "steps", "items": ['],
    ['unknown type', '{"type": "carousel", "slides": []}'],
    ['schema failure', '{"type": "steps", "items": []}'],
  ])('T9-C3 %s -> the original source as code plus the first error, never blank', (_name, source) => {
    const expected = validateBlock(source, FULL)
    expect(expected.ok).toBe(false)
    const c = draw(source)
    const pre = c.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain(source)
    expect(c.textContent).toContain(`couldn't draw this block: ${(expected as { error: string }).error}`)
  })

  it('T9-C6 streaming + unparseable (the fence still arriving) -> code without a caption', () => {
    const partial = '{"type": "steps", "items": [{"title": "Idea'
    const c = draw(partial, { streaming: true })
    expect(c.querySelector('pre')?.textContent).toContain(partial)
    expect(c.textContent).not.toMatch(CAPTION)
  })

  it('T9-C6b streaming + a block that already parses draws the component', () => {
    const c = draw(JSON.stringify(steps.example), { streaming: true })
    expect(screen.getByText('Idea or requirement')).toBeDefined()
    expect(c.querySelector('pre')).toBeNull()
  })
})
