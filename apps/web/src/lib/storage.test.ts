import { describe, expect, it, vi } from 'vitest'

import { readLocal, writeLocal } from './storage'

describe('readLocal', () => {
  it('returns the fallback when nothing is stored', () => {
    expect(readLocal('nova-test-absent', 'fallback')).toBe('fallback')
  })

  it('returns what writeLocal stored', () => {
    writeLocal('nova-test-round-trip', { a: 1, b: 'two' })
    expect(readLocal('nova-test-round-trip', null)).toEqual({ a: 1, b: 'two' })
  })

  it('returns the fallback for a value that is not JSON', () => {
    localStorage.setItem('nova-test-garbage', '{not json')
    expect(readLocal('nova-test-garbage', 'fallback')).toBe('fallback')
  })

  it('returns the fallback when storage itself throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    try {
      expect(readLocal('nova-test-throws', 'fallback')).toBe('fallback')
    } finally {
      getItem.mockRestore()
    }
  })
})

describe('writeLocal', () => {
  it('does not throw when storage refuses the write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    try {
      expect(() => writeLocal('nova-test-refused', 'value')).not.toThrow()
    } finally {
      setItem.mockRestore()
    }
  })

  it('removes the key when the value is null', () => {
    writeLocal('nova-test-cleared', 'something')
    writeLocal('nova-test-cleared', null)
    expect(localStorage.getItem('nova-test-cleared')).toBeNull()
  })
})
