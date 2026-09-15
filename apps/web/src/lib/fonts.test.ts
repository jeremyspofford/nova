import { describe, it, expect } from 'vitest'
import { DEFAULT_FONT, fontChoices, fontStack, knownFont, sanitizeFamily } from './fonts'

describe('fontChoices', () => {
  it('every choice ends its stack in a generic family', () => {
    // A face that fails to load — offline, a blocked request, a name the
    // operator typed wrong — must still leave the page set in the right KIND
    // of type rather than in whatever the browser defaults to.
    for (const [key, choice] of Object.entries(fontChoices)) {
      if (key === 'custom') continue // built by fontStack, asserted below
      expect(choice.stack, `${key}`).toMatch(/(sans-serif|serif|monospace)$/)
    }
  })

  it('the default is a real choice and brings a face with it', () => {
    expect(fontChoices[DEFAULT_FONT]).toBeDefined()
    expect(fontChoices[DEFAULT_FONT].load).toBeTypeOf('function')
  })

  it('only the choices that need no download declare no loader', () => {
    // A bundled face without a loader would silently never arrive.
    expect(fontChoices.system.load).toBeUndefined()
    expect(fontChoices.custom.load).toBeUndefined()
    for (const key of ['jakarta', 'inter', 'figtree', 'source-serif']) {
      expect(fontChoices[key].load, key).toBeTypeOf('function')
    }
  })
})

describe('sanitizeFamily', () => {
  /**
   * This value is written into a <style> element's text. A name carrying a
   * brace closes the rule and lets whatever follows through as CSS. It is
   * self-inflicted — the operator types it — but the repo's rule is that a
   * property is held by code, not by the expectation that nobody types `}`.
   */
  it('drops anything that could close a rule or open a new one', () => {
    expect(sanitizeFamily('Styrene A}body{display:none')).toBe('Styrene Abodydisplaynone')
    expect(sanitizeFamily('x; background: url(http://evil)')).toBe('x background urlhttpevil')
    expect(sanitizeFamily('"><script>')).toBe('script')
  })

  it('keeps what a real family name is made of', () => {
    expect(sanitizeFamily('Styrene A')).toBe('Styrene A')
    expect(sanitizeFamily('SF Pro Text')).toBe('SF Pro Text')
    expect(sanitizeFamily('IBM Plex Sans')).toBe('IBM Plex Sans')
    expect(sanitizeFamily('Helvetica-Neue_2')).toBe('Helvetica-Neue_2')
  })

  it('trims, and refuses to be a megabyte long', () => {
    expect(sanitizeFamily('   Inter   ')).toBe('Inter')
    expect(sanitizeFamily('a'.repeat(500))).toHaveLength(64)
  })
})

describe('fontStack', () => {
  it('gives each known choice its own stack', () => {
    expect(fontStack('inter')).toContain('Inter Variable')
    expect(fontStack('figtree')).toContain('Figtree Variable')
    expect(fontStack('source-serif')).toMatch(/serif$/)
    expect(fontStack('system')).toContain('system-ui')
  })

  it('falls back to the default rather than publishing nothing', () => {
    // An unknown key, a prototype key, and a custom choice with no family
    // typed yet all have to render SOMETHING.
    expect(fontStack('no-such-font')).toBe(fontChoices[DEFAULT_FONT].stack)
    expect(fontStack('constructor')).toBe(fontChoices[DEFAULT_FONT].stack)
    expect(fontStack('custom', '')).toBe(fontChoices[DEFAULT_FONT].stack)
    expect(fontStack('custom', '{}')).toBe(fontChoices[DEFAULT_FONT].stack)
  })

  it('quotes a custom family and keeps a fallback behind it', () => {
    const stack = fontStack('custom', 'Styrene A')
    expect(stack.startsWith('"Styrene A", ')).toBe(true)
    expect(stack).toMatch(/sans-serif$/)
  })

  it('sanitises on the way out too, not only on the way in', () => {
    // Storage is hand-editable, and this is the last gate before the value
    // reaches a stylesheet.
    expect(fontStack('custom', 'A}html{opacity:0')).not.toContain('}')
    expect(fontStack('custom', 'A}html{opacity:0')).not.toContain('{')
  })
})

describe('knownFont', () => {
  it('accepts only its own keys', () => {
    expect(knownFont('inter')).toBe('inter')
    expect(knownFont('constructor')).toBeNull()
    expect(knownFont('toString')).toBeNull()
    expect(knownFont(42)).toBeNull()
    expect(knownFont(undefined)).toBeNull()
  })
})
