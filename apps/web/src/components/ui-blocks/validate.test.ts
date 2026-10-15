import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { countNodes, depthOf, validateBlock, type Registry } from './validate'

// A fake registry: the real one lands in T9. `leaf` takes one short label;
// `box` takes any children (its own schema does not limit nesting, so the
// depth/node limits are what must catch a deep or wide block).
const leaf = z.object({ type: z.literal('leaf'), label: z.string().max(10) }).strict()
const box = z.object({ type: z.literal('box'), children: z.array(z.any()) }).strict()
const REG: Registry = { leaf: { schema: leaf }, box: { schema: box } }

const L = (label = 'x') => ({ type: 'leaf', label })
const nest = (levels: number): unknown =>
  levels <= 1 ? L() : { type: 'box', children: [nest(levels - 1)] }

describe('countNodes / depthOf', () => {
  it('T1-C1 counts every typed object and measures typed-node nesting', () => {
    const v = { type: 'box', children: [L(), { type: 'box', children: [L(), L()] }] }
    expect(countNodes(v)).toBe(5)
    expect(depthOf(v)).toBe(3)
    expect(depthOf(L())).toBe(1)
    // plain objects without a `type` are not nodes and add no depth
    expect(countNodes({ items: [{ title: 'a' }, { title: 'b' }] })).toBe(0)
    expect(depthOf({ type: 'leaf', meta: { a: { b: 1 } } })).toBe(1)
  })
})

describe('validateBlock', () => {
  it('T1-C2 bad JSON is an error, never a throw', () => {
    const r = validateBlock('{"type": "leaf", ', REG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/json/i)
  })

  it('T1-C3 a non-object JSON value is an error', () => {
    for (const src of ['[1,2]', '"leaf"', '42', 'null']) {
      const r = validateBlock(src, REG)
      expect(r.ok).toBe(false)
    }
  })

  it('T1-C4 a missing type is an error that says type is missing', () => {
    const r = validateBlock('{"label": "x"}', REG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/type/i)
  })

  it('T1-C5 an unknown type is an error naming it', () => {
    const r = validateBlock('{"type": "sparkle", "label": "x"}', REG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('sparkle')
  })

  it('T1-C6 a schema failure reports the first zod issue as one line with its path', () => {
    const r = validateBlock(JSON.stringify({ type: 'leaf', label: 'far too long a label' }), REG)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('label')
      expect(r.error).not.toContain('\n')
      expect(r.error.length).toBeGreaterThan(0)
    }
  })

  it('T1-C7 depth 5 fails and depth 4 passes', () => {
    const ok = validateBlock(JSON.stringify(nest(4)), REG)
    expect(ok.ok).toBe(true)
    const bad = validateBlock(JSON.stringify(nest(5)), REG)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/depth/i)
  })

  it('T1-C8 41 nodes fail and 40 pass', () => {
    const wide = (n: number) => ({ type: 'box', children: Array.from({ length: n - 1 }, () => L()) })
    expect(validateBlock(JSON.stringify(wide(40)), REG).ok).toBe(true)
    const bad = validateBlock(JSON.stringify(wide(41)), REG)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/node/i)
  })

  it('T1-C9 a valid object returns ok with the parsed block', () => {
    const r = validateBlock('{"type": "leaf", "label": "hi"}', REG)
    expect(r).toEqual({ ok: true, block: { type: 'leaf', label: 'hi' } })
  })
})

describe('validateBlock — coverage', () => {
  it('T1-C5b a type naming an Object.prototype key is unknown, not a crash', () => {
    for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = validateBlock(JSON.stringify({ type: t }), REG)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/unknown type/)
    }
  })
})
