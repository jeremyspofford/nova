import { describe, it, expect } from 'vitest'
import { displayName, initials } from './displayName'

/**
 * `people.name` is whatever was typed at registration, and on this instance
 * that is an email — so the sidebar footer read "jeremyspofford@gmail…." in
 * a 240px column, which is an identifier rather than a name.
 */
describe('displayName', () => {
  it('takes the person out of an email address', () => {
    expect(displayName('jeremyspofford@gmail.com')).toBe('Jeremyspofford')
    expect(displayName('jeremy.spofford@gmail.com')).toBe('Jeremy')
    expect(displayName('jeremy_spofford@work.io')).toBe('Jeremy')
    expect(displayName('jeremy+nova@gmail.com')).toBe('Jeremy')
  })

  it('takes the given name out of a real name', () => {
    expect(displayName('Jeremy Spofford')).toBe('Jeremy')
    expect(displayName('jeremy')).toBe('Jeremy')
  })

  it('never returns an empty label', () => {
    // An avatar beside a blank is worse than a clumsy word.
    expect(displayName('')).toBe('Signed in')
    expect(displayName('   ')).toBe('Signed in')
  })

  it('leaves a name that is already capitalised alone', () => {
    expect(displayName('Ada')).toBe('Ada')
  })
})

describe('initials', () => {
  it('prefers real initials', () => {
    expect(initials('Jeremy Spofford')).toBe('JS')
    expect(initials('jeremy.spofford@gmail.com')).toBe('JS')
  })

  it('falls back to two characters when there is only one part', () => {
    expect(initials('jeremyspofford@gmail.com')).toBe('JE')
    expect(initials('ada')).toBe('AD')
  })

  it('says something rather than nothing for an empty name', () => {
    expect(initials('')).toBe('?')
  })
})
