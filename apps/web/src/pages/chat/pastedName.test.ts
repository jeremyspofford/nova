import { describe, it, expect } from 'vitest'
import { pastedName } from './pastedName'

const AT = new Date(2026, 8, 16, 14, 32, 7)

describe('pastedName — a screenshot arrives without a name', () => {
  it('names a nameless paste for when it happened', () => {
    // The only thing that tells one screenshot from another, and the thing
    // he actually remembers about it.
    expect(pastedName({ name: '', type: 'image/png' }, AT)).toBe(
      'Pasted image 2026-09-16 at 14.32.07.png',
    )
  })

  it('renames the generic name every paste shares', () => {
    // Chrome calls every pasted screenshot image.png. A dozen of them in one
    // conversation and the one he means is unfindable.
    expect(pastedName({ name: 'image.png', type: 'image/png' }, AT)).toContain('Pasted image')
    expect(pastedName({ name: 'Screenshot.png', type: 'image/png' }, AT)).toContain('Pasted image')
  })

  it('leaves a file that came with a real name alone', () => {
    // Dragging in invoice.pdf must not rename it: he chose that name and it
    // is how he will look for it later.
    expect(pastedName({ name: 'invoice.pdf', type: 'application/pdf' }, AT)).toBe('invoice.pdf')
    expect(pastedName({ name: 'Q3 report.csv', type: 'text/csv' }, AT)).toBe('Q3 report.csv')
  })

  it('takes the extension from the clipboard TYPE, not from the name it lacks', () => {
    expect(pastedName({ name: '', type: 'image/jpeg' }, AT)).toMatch(/\.jpg$/)
    expect(pastedName({ name: '', type: 'image/webp' }, AT)).toMatch(/\.webp$/)
  })

  it('does not call a non-image an image', () => {
    expect(pastedName({ name: '', type: 'text/plain' }, AT)).toContain('Pasted file')
  })
})
