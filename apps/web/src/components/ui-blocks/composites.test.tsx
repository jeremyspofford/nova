import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LIMITS, validateBlock, type Registry } from './validate'
import type { BlockDef } from './types'
import { block as steps } from './steps'
import { block as layers } from './layers'
import { block as timeline } from './timeline'
import { block as compare } from './compare'
import { block as callout } from './callout'
import { PRIMITIVES } from './node'

const LISTS: BlockDef[] = [steps, layers, timeline]
const ALL: BlockDef[] = [steps, layers, timeline, compare, callout]
const REG: Registry = Object.fromEntries(ALL.map((b) => [b.type, b]))
const ok = (b: BlockDef, v: unknown) => b.schema.safeParse(v).success
const draw = (b: BlockDef, props: Record<string, unknown>) => render(<b.Render {...props} />).container

/** Every string value anywhere in the example except `type`, `icon` and `kind`. */
function shownStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(shownStrings)
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      ['type', 'icon', 'kind'].includes(k) ? [] : typeof x === 'string' ? [x] : shownStrings(x),
    )
  }
  return []
}

const items = (b: BlockDef) => (b.example.items ?? [{}]) as Record<string, unknown>[]
const withItems = (b: BlockDef, list: unknown[]) => ({ ...b.example, items: list })
const nItems = (b: BlockDef, n: number) => withItems(b, Array.from({ length: n }, () => items(b)[0]))

const EXTRAS = [{ style: { color: '#23354D' } }, { color: '#23354D' }, { className: 'x' }, { html: '<b>x</b>' }]
const HTML = '<b>bold</b> <img src=x onerror=alert(1)>'

describe('list composites steps/layers/timeline (S54a T5)', () => {
  it('T5-C1 each exports the block shape named for its file; example parses and validates', () => {
    expect(LISTS.map((b) => b.type)).toEqual(['steps', 'layers', 'timeline'])
    for (const b of LISTS) {
      expect(b.describe.trim().length).toBeGreaterThan(0)
      expect(b.describe).not.toMatch(/\n/)
      expect(b.example.type).toBe(b.type)
      expect(items(b).length).toBeGreaterThanOrEqual(2)
      expect(ok(b, b.example)).toBe(true)
      expect(validateBlock(JSON.stringify(b.example), REG).ok).toBe(true)
    }
  })

  it('T5-C2 the example renders every item string; steps number each item; layers draw icons', () => {
    for (const b of LISTS) {
      const words = shownStrings(b.example)
      expect(words.length).toBeGreaterThanOrEqual(items(b).length)
      const c = draw(b, b.example)
      for (const w of words) expect(c.textContent).toContain(w)
    }
    const s = draw(steps, steps.example)
    items(steps).forEach((_, i) => expect(s.textContent).toContain(String(i + 1)))
    expect(s.querySelectorAll('li').length).toBe(items(steps).length)
    expect(items(layers).some((it) => typeof it.icon === 'string')).toBe(true)
    expect(draw(layers, layers.example).querySelector('svg')).not.toBeNull()
  })

  it('T5-C2b steps draw an arrow icon into every step after the first', () => {
    const c = draw(steps, steps.example)
    const arrows = c.querySelectorAll('[data-arrow]')
    expect(arrows.length).toBe(items(steps).length - 1)
    arrows.forEach((a) => expect(a.querySelector('svg')).not.toBeNull())
    expect(c.querySelectorAll('li')[0].querySelector('[data-arrow]')).toBeNull()
  })

  it('T5-C3 empty items rejected; item count capped at 8', () => {
    for (const b of LISTS) {
      expect(ok(b, withItems(b, []))).toBe(false)
      expect(ok(b, { type: b.type })).toBe(false)
      expect(ok(b, nItems(b, 8))).toBe(true)
      expect(ok(b, nItems(b, 9))).toBe(false)
    }
  })

  it('T5-C4 item fields: title required and capped short; body text capped long; icon kebab-case', () => {
    for (const b of LISTS) {
      const first = items(b)[0]
      const { title: _t, ...noTitle } = first
      expect(ok(b, withItems(b, [noTitle]))).toBe(false)
      expect(ok(b, withItems(b, [{ ...first, title: '' }]))).toBe(false)
      expect(ok(b, withItems(b, [{ ...first, title: 'x'.repeat(LIMITS.strings.short) }]))).toBe(true)
      expect(ok(b, withItems(b, [{ ...first, title: 'x'.repeat(LIMITS.strings.short + 1) }]))).toBe(false)
    }
    // the long-text field per composite
    const long = (n: number) => 'y'.repeat(n)
    expect(ok(steps, withItems(steps, [{ title: 'a', caption: long(LIMITS.strings.long) }]))).toBe(true)
    expect(ok(steps, withItems(steps, [{ title: 'a', caption: long(LIMITS.strings.long + 1) }]))).toBe(false)
    expect(ok(layers, withItems(layers, [{ title: 'a', body: long(LIMITS.strings.long + 1) }]))).toBe(false)
    expect(ok(timeline, withItems(timeline, [{ label: 'W1', title: 'a', body: long(LIMITS.strings.long + 1) }]))).toBe(false)
    // timeline needs its label, capped short
    expect(ok(timeline, withItems(timeline, [{ title: 'a' }]))).toBe(false)
    expect(ok(timeline, withItems(timeline, [{ label: 'x'.repeat(LIMITS.strings.short + 1), title: 'a' }]))).toBe(false)
    // icons: kebab-case lucide names only
    for (const b of [steps, layers]) {
      expect(ok(b, withItems(b, [{ title: 'a', icon: 'bot' }]))).toBe(true)
      expect(ok(b, withItems(b, [{ title: 'a', icon: '\u{1F916}' }]))).toBe(false)
      expect(ok(b, withItems(b, [{ title: 'a', icon: 'Bot!' }]))).toBe(false)
    }
  })

  it('T5-C5 strict props: extras rejected on the block and on each item', () => {
    for (const b of LISTS) {
      expect(ok(b, b.example)).toBe(true)
      for (const extra of EXTRAS) {
        expect(ok(b, { ...b.example, ...extra })).toBe(false)
        expect(ok(b, withItems(b, [{ ...items(b)[0], ...extra }]))).toBe(false)
      }
    }
  })

  it('T5-C6 raw HTML in an item stays text; no inline style in any example DOM', () => {
    for (const b of LISTS) {
      const props = withItems(b, [{ ...items(b)[0], title: HTML }])
      expect(ok(b, props)).toBe(true)
      const c = draw(b, props)
      expect(c.querySelector('b, img')).toBeNull()
      expect(c.textContent).toContain('<b>bold</b>')
      const e = draw(b, b.example)
      expect(e.innerHTML.length).toBeGreaterThan(0)
      expect(e.querySelector('[style]')).toBeNull()
    }
  })

  it('T5-C7 composites are top-level blocks, not container children (PRIMITIVES unchanged)', () => {
    expect(PRIMITIVES.map((b) => b.type)).not.toContain('steps')
    expect(PRIMITIVES.length).toBe(8)
    // a composite's untyped items are data, not nesting: depth stays 1
    expect(validateBlock(JSON.stringify(nItems(steps, 8)), REG).ok).toBe(true)
  })
})

describe('compare and callout composites (S54a T6)', () => {
  const options = () => (compare.example.options ?? [{}]) as Record<string, unknown>[]
  const withOptions = (list: unknown[]) => ({ ...compare.example, options: list })

  it('T6-C1 compare/callout export the block shape; examples parse and validate', () => {
    for (const b of [compare, callout]) {
      expect(b.describe.trim().length).toBeGreaterThan(0)
      expect(b.describe).not.toMatch(/\n/)
      expect(b.example.type).toBe(b.type)
      expect(ok(b, b.example)).toBe(true)
      expect(validateBlock(JSON.stringify(b.example), REG).ok).toBe(true)
    }
    expect([compare.type, callout.type]).toEqual(['compare', 'callout'])
  })

  it('T6-C2 compare renders one column per option with every title, pro and con', () => {
    expect(options().length).toBeGreaterThanOrEqual(2)
    expect(options().every((o) => Array.isArray(o.pros) && Array.isArray(o.cons))).toBe(true)
    const c = draw(compare, compare.example)
    for (const w of shownStrings(compare.example)) expect(c.textContent).toContain(w)
    expect(c.querySelectorAll('[data-option]').length).toBe(options().length)
  })

  it('T6-C3 compare holds 2 to 4 options; pros/cons capped at 6; option title required', () => {
    const o = options()[0]
    expect(ok(compare, withOptions([o]))).toBe(false)
    expect(ok(compare, withOptions([o, o, o, o]))).toBe(true)
    expect(ok(compare, withOptions([o, o, o, o, o]))).toBe(false)
    const six = Array.from({ length: 6 }, () => 'p')
    expect(ok(compare, withOptions([{ ...o, pros: six }, o]))).toBe(true)
    expect(ok(compare, withOptions([{ ...o, pros: [...six, 'p'] }, o]))).toBe(false)
    expect(ok(compare, withOptions([{ ...o, cons: [...six, 'c'] }, o]))).toBe(false)
    const { title: _t, ...noTitle } = o
    expect(ok(compare, withOptions([noTitle, o]))).toBe(false)
    expect(ok(compare, withOptions([{ ...o, title: 'x'.repeat(LIMITS.strings.short + 1) }, o]))).toBe(false)
  })

  it('T6-C3b each pro/con string is non-empty and capped short', () => {
    const o = options()[0]
    expect(ok(compare, withOptions([{ ...o, pros: ['p'.repeat(LIMITS.strings.short)] }, o]))).toBe(true)
    expect(ok(compare, withOptions([{ ...o, pros: ['p'.repeat(LIMITS.strings.short + 1)] }, o]))).toBe(false)
    expect(ok(compare, withOptions([{ ...o, cons: [''] }, o]))).toBe(false)
  })

  it('T6-C4 callout kind is note|warning|tip only', () => {
    for (const kind of ['note', 'warning', 'tip']) expect(ok(callout, { ...callout.example, kind })).toBe(true)
    for (const kind of ['danger', 'info', 'Note', '', '#23354D']) expect(ok(callout, { ...callout.example, kind })).toBe(false)
    const { kind: _k, ...noKind } = callout.example
    expect(ok(callout, noKind)).toBe(false)
  })

  it('T6-C5 callout renders its text (and title) and marks its kind with a theme class, never an inline colour', () => {
    expect(String(callout.example.text ?? '').length).toBeGreaterThan(0)
    expect(ok(callout, { ...callout.example, text: '' })).toBe(false)
    expect(ok(callout, { ...callout.example, text: 'x'.repeat(LIMITS.strings.long + 1) })).toBe(false)
    const classes = new Set<string>()
    for (const kind of ['note', 'warning', 'tip']) {
      const props = { ...callout.example, kind }
      const c = draw(callout, props)
      for (const w of shownStrings(props)) expect(c.textContent).toContain(w)
      const el = c.querySelector('[data-block="callout"]')
      expect(el).not.toBeNull()
      expect(el!.getAttribute('data-kind')).toBe(kind)
      expect(c.querySelector('[style]')).toBeNull()
      classes.add(el!.className)
    }
    expect(classes.size).toBe(3)
  })

  it('T6-C6 strict props and raw HTML stays text in compare and callout', () => {
    for (const b of [compare, callout]) {
      for (const extra of EXTRAS) expect(ok(b, { ...b.example, ...extra })).toBe(false)
    }
    for (const extra of EXTRAS) expect(ok(compare, withOptions([{ ...options()[0], ...extra }, options()[0]]))).toBe(false)
    const cmp = withOptions([{ ...options()[0], pros: [HTML] }, options()[0]])
    expect(ok(compare, cmp)).toBe(true)
    const callP = { ...callout.example, text: HTML }
    expect(ok(callout, callP)).toBe(true)
    for (const [b, p] of [[compare, cmp], [callout, callP]] as const) {
      const c = draw(b, p)
      expect(c.querySelector('b, img')).toBeNull()
      expect(c.textContent).toContain('<b>bold</b>')
      expect(c.querySelector('[style]')).toBeNull()
    }
  })
})

describe('callout draws through the shared Banner (S54a G5)', () => {
  it('T6-C5c a callout is a note, never an alert or a live status, in the Banner box', () => {
    for (const kind of ['note', 'warning', 'tip']) {
      const c = draw(callout, { ...callout.example, kind })
      const el = c.querySelector('[data-block="callout"]')!
      expect(el.getAttribute('role')).toBe('note')
      expect(el.className).toContain('rounded-sm border')
    }
  })
})
