import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BlockIcon, ICONS, TONES, iconName, tone } from './tokens'

describe('tone', () => {
  it('T2-C1 accepts exactly the five theme tones', () => {
    for (const t of TONES) expect(tone.safeParse(t).success).toBe(true)
    expect(TONES).toEqual(['accent', 'success', 'warning', 'danger', 'neutral'])
  })

  it('T2-C2 rejects colour values like #23354D while accepting accent', () => {
    expect(tone.safeParse('accent').success).toBe(true)
    for (const c of ['#23354D', '#fff', 'rgb(0,0,0)', 'red', 'Accent']) {
      expect(tone.safeParse(c).success).toBe(false)
    }
  })
})

describe('iconName', () => {
  it('T2-C3 accepts kebab-case names, known or not', () => {
    for (const n of ['lightbulb', 'bot', 'arrow-right', 'not-a-real-icon', 'layers-3']) {
      expect(iconName.safeParse(n).success).toBe(true)
    }
  })

  it('T2-C4 rejects emoji, punctuation, capitals and empty names', () => {
    expect(iconName.safeParse('bot').success).toBe(true)
    for (const n of ['\u{1F916}', 'Bot!', 'Bot', 'arrow_right', 'arrow--right', '-bot', '', 'bot \u{1F4A1}']) {
      expect(iconName.safeParse(n).success).toBe(false)
    }
  })
})

describe('ICONS / BlockIcon', () => {
  it('T2-C5 the curated map is non-empty, kebab-keyed, and holds the spec example icons', () => {
    const keys = Object.keys(ICONS)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(iconName.safeParse(k).success).toBe(true)
    expect(keys).toEqual(expect.arrayContaining(['lightbulb', 'bot']))
  })

  it('T2-C6 a known name renders an svg', () => {
    const { container } = render(<BlockIcon name="lightbulb" />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('T2-C7 an unknown kebab name renders nothing while a known one renders', () => {
    const known = render(<BlockIcon name="bot" />)
    expect(known.container.querySelector('svg')).not.toBeNull()
    const { container } = render(<BlockIcon name="not-a-real-icon" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('BlockIcon — coverage', () => {
  it('T2-C7b a kebab name that is an Object.prototype key renders nothing', () => {
    for (const n of ['constructor', 'valueof']) expect(iconName.safeParse(n).success).toBe(true)
    const { container } = render(<BlockIcon name="constructor" />)
    expect(container.innerHTML).toBe('')
  })
})
