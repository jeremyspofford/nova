import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LIMITS, validateBlock, type Registry } from './validate'
import type { BlockDef } from './types'
import { block as text } from './text'
import { block as title } from './title'
import { block as icon } from './icon'
import { block as divider } from './divider'
import { block as badge } from './badge'

const LEAVES: BlockDef[] = [text, title, icon, divider, badge]
const REG: Registry = Object.fromEntries(LEAVES.map((b) => [b.type, b]))
const ok = (b: BlockDef, v: unknown) => b.schema.safeParse(v).success
const draw = (b: BlockDef, props: Record<string, unknown>) => render(<b.Render {...props} />).container

describe('leaf primitives (S54a T3)', () => {
  it('T3-C1 each leaf exports {type, schema, describe, example, Render} named for its file', () => {
    expect(LEAVES.map((b) => b.type)).toEqual(['text', 'title', 'icon', 'divider', 'badge'])
    for (const b of LEAVES) {
      expect(b.describe.trim().length).toBeGreaterThan(0)
      expect(b.describe).not.toMatch(/\n/)
      expect(b.example.type).toBe(b.type)
      expect(typeof b.Render).toBe('function')
    }
  })

  it('T3-C2 each example parses with its own schema and passes validateBlock', () => {
    for (const b of LEAVES) {
      expect(ok(b, b.example)).toBe(true)
      const r = validateBlock(JSON.stringify(b.example), REG)
      expect(r.ok).toBe(true)
    }
  })

  it('T3-C3 each example renders its text (icon an svg, divider a separator)', () => {
    for (const b of [text, title, badge]) {
      const words = String(b.example.text ?? '')
      expect(words.length).toBeGreaterThan(0)
      expect(draw(b, b.example).textContent).toContain(words)
    }
    expect(draw(icon, icon.example).querySelector('svg')).not.toBeNull()
    expect(draw(divider, divider.example).querySelector('hr, [role="separator"]')).not.toBeNull()
  })

  it('T3-C4 over-cap strings are rejected (text long cap, title/badge short cap)', () => {
    const { short, long } = LIMITS.strings
    expect(ok(text, { type: 'text', text: 'a'.repeat(long) })).toBe(true)
    expect(ok(text, { type: 'text', text: 'a'.repeat(long + 1) })).toBe(false)
    expect(ok(title, { type: 'title', text: 'a'.repeat(short) })).toBe(true)
    expect(ok(title, { type: 'title', text: 'a'.repeat(short + 1) })).toBe(false)
    expect(ok(badge, { type: 'badge', text: 'a'.repeat(short + 1) })).toBe(false)
    expect(ok(text, { type: 'text', text: '' })).toBe(false)
  })

  it('T3-C5 props are closed vocabularies: sizes, tones and weights outside the set are rejected', () => {
    expect(ok(text, { type: 'text', text: 'x', size: 'sm', tone: 'secondary', weight: 'semibold' })).toBe(true)
    expect(ok(text, { type: 'text', text: 'x', size: 'xl' })).toBe(false)
    expect(ok(text, { type: 'text', text: 'x', tone: 'accent' })).toBe(false)
    expect(ok(text, { type: 'text', text: 'x', weight: 'black' })).toBe(false)
    expect(ok(title, { type: 'title', text: 'x', size: 'lg' })).toBe(true)
    expect(ok(title, { type: 'title', text: 'x', size: 'xl' })).toBe(false)
    expect(ok(badge, { type: 'badge', text: 'x', tone: 'success' })).toBe(true)
    expect(ok(badge, { type: 'badge', text: 'x', tone: '#23354D' })).toBe(false)
    expect(ok(icon, { type: 'icon', name: 'bot', tone: 'accent' })).toBe(true)
    expect(ok(icon, { type: 'icon', name: '\u{1F916}' })).toBe(false)
    expect(ok(icon, { type: 'icon', name: 'bot', tone: 'rgb(0,0,0)' })).toBe(false)
  })

  it('T3-C6 extra props (style, color, className, html) are rejected, never passed through', () => {
    for (const b of LEAVES) {
      expect(ok(b, b.example)).toBe(true)
      for (const extra of [{ style: { color: '#23354D' } }, { color: '#23354D' }, { className: 'x' }, { html: '<b>x</b>' }]) {
        expect(ok(b, { ...b.example, ...extra })).toBe(false)
      }
    }
  })

  it('T3-C7 raw HTML stays text and no inline style reaches the DOM', () => {
    for (const b of [text, title, badge]) {
      const props = { ...b.example, text: '<b>bold</b> <img src=x onerror=alert(1)>' }
      expect(ok(b, props)).toBe(true)
      const c = draw(b, props)
      expect(c.querySelector('b, img')).toBeNull()
      expect(c.textContent).toContain('<b>bold</b>')
    }
    for (const b of LEAVES) {
      const c = draw(b, b.example)
      expect(c.innerHTML.length).toBeGreaterThan(0)
      expect(c.querySelector('[style]')).toBeNull()
    }
  })
})
