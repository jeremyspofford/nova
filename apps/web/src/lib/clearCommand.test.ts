import { describe, it, expect } from 'vitest'
import { isClearCommand } from './clearCommand'

describe('isClearCommand', () => {
  it('recognises /clear and its /reset alias as whole-message commands', () => {
    expect(isClearCommand('/clear')).toBe(true)
    expect(isClearCommand('/reset')).toBe(true)
  })

  it('ignores surrounding whitespace and case', () => {
    expect(isClearCommand('  /clear  ')).toBe(true)
    expect(isClearCommand('/CLEAR')).toBe(true)
    expect(isClearCommand('/Reset')).toBe(true)
  })

  it('treats a message that merely CONTAINS the command mid-text as ordinary', () => {
    expect(isClearCommand('remind me to run /clear later')).toBe(false)
    expect(isClearCommand('/clear the driveway')).toBe(false)
    expect(isClearCommand('what does /reset do?')).toBe(false)
  })

  it('does not match near-misses', () => {
    expect(isClearCommand('clear')).toBe(false)
    expect(isClearCommand('//clear')).toBe(false)
    expect(isClearCommand('/clearall')).toBe(false)
    expect(isClearCommand('')).toBe(false)
  })
})
