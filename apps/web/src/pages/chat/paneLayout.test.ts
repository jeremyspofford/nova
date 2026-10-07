import { describe, expect, it } from 'vitest'
import { MAIN_SLOT } from '../../stores/chat-store'
import {
  closeMain,
  insertPane,
  MAX_PANES,
  removePane,
  resize,
  sanitize,
  setLocation,
  singlePane,
  type Pane,
} from './paneLayout'

const pane = (id: string, sessionId: string | null = id): Pane => ({ id, sessionId, threadId: null })

describe('paneLayout', () => {
  it('starts as the main pane alone, and anything malformed is that', () => {
    expect(singlePane().order).toEqual([MAIN_SLOT])
    expect(sanitize(null)).toEqual(singlePane())
    expect(sanitize('nonsense')).toEqual(singlePane())
    expect(sanitize({ order: [1, 2], extra: 'x' })).toEqual(singlePane())
  })

  it('keeps the main pane in a stored layout, drops unknown panes and caps the row', () => {
    const stored = {
      order: ['a', 'ghost', 'b', 'c', 'd', 'e'],
      extra: { a: pane('a'), b: pane('b'), c: pane('c'), d: pane('d'), e: pane('e'), main: pane('main') },
      weights: { a: 2, b: -1, ghost: 3 },
      focused: 'ghost',
    }
    const layout = sanitize(stored)
    expect(layout.order).toHaveLength(MAX_PANES)
    expect(layout.order).toContain(MAIN_SLOT)
    expect(layout.order).not.toContain('ghost')
    expect(Object.keys(layout.extra).sort()).toEqual(layout.order.filter(id => id !== MAIN_SLOT).sort())
    expect(layout.weights).toEqual({ a: 2 })
    expect(layout.focused).toBe(MAIN_SLOT)
  })

  it('inserts beside the target on the side it was dropped, and focuses the new pane', () => {
    let layout = insertPane(singlePane(), pane('a'), MAIN_SLOT, 'right')
    expect(layout.order).toEqual([MAIN_SLOT, 'a'])
    expect(layout.focused).toBe('a')
    layout = insertPane(layout, pane('b'), MAIN_SLOT, 'left')
    expect(layout.order).toEqual(['b', MAIN_SLOT, 'a'])
  })

  it('does nothing past the cap', () => {
    let layout = singlePane()
    for (const id of ['a', 'b', 'c']) layout = insertPane(layout, pane(id), MAIN_SLOT, 'right')
    expect(layout.order).toHaveLength(MAX_PANES)
    expect(insertPane(layout, pane('d'), MAIN_SLOT, 'right')).toBe(layout)
  })

  it('removes a side pane and moves focus to its neighbour; never the main pane', () => {
    let layout = insertPane(singlePane(), pane('a'), MAIN_SLOT, 'right')
    layout = insertPane(layout, pane('b'), 'a', 'right')
    const without = removePane(layout, 'b')
    expect(without.order).toEqual([MAIN_SLOT, 'a'])
    expect(without.focused).toBe('a')
    expect(removePane(layout, MAIN_SLOT)).toBe(layout)
  })

  it('closing the main pane takes its neighbour’s session into it, where the neighbour stood', () => {
    let layout = insertPane(singlePane(), pane('a', 's-a'), MAIN_SLOT, 'right')
    layout = insertPane(layout, pane('b', 's-b'), 'a', 'right')
    const closed = closeMain(layout)!
    expect(closed.location).toEqual({ sessionId: 's-a', threadId: null })
    expect(closed.removed).toBe('a')
    expect(closed.layout.order).toEqual([MAIN_SLOT, 'b'])
    expect(closed.layout.extra).not.toHaveProperty('a')
    // Main alone has nothing to close.
    expect(closeMain(singlePane())).toBeNull()
  })

  it('takes the left neighbour when main is the last pane', () => {
    const layout = insertPane(singlePane(), pane('a', 's-a'), MAIN_SLOT, 'left')
    const closed = closeMain(layout)!
    expect(closed.location.sessionId).toBe('s-a')
    expect(closed.layout.order).toEqual([MAIN_SLOT])
  })

  it('moves a side pane’s location, and only a side pane’s', () => {
    const layout = insertPane(singlePane(), pane('a'), MAIN_SLOT, 'right')
    const moved = setLocation(layout, 'a', { sessionId: 'x', threadId: 't' })
    expect(moved.extra.a).toEqual({ id: 'a', sessionId: 'x', threadId: 't' })
    expect(setLocation(layout, MAIN_SLOT, { sessionId: 'x', threadId: null })).toBe(layout)
  })

  it('resizes a pair without letting either side vanish', () => {
    const layout = insertPane(singlePane(), pane('a'), MAIN_SLOT, 'right')
    const wider = resize(layout, MAIN_SLOT, 0.25)
    expect(wider.weights[MAIN_SLOT]).toBeCloseTo(1.5)
    expect(wider.weights.a).toBeCloseTo(0.5)
    const squeezed = resize(layout, MAIN_SLOT, 5)
    expect(squeezed.weights.a).toBeCloseTo(2 / 6)
    expect(resize(layout, 'a', 0.1)).toBe(layout)
  })
})
