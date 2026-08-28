import { describe, it, expect } from 'vitest'
import { createLineBuffer } from './lineBuffer'

describe('createLineBuffer', () => {
  it('returns every complete line in a chunk', () => {
    const buffer = createLineBuffer()
    expect(buffer.push('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three'])
  })

  it('holds an unfinished line back until the rest arrives', () => {
    const buffer = createLineBuffer()
    expect(buffer.push('par')).toEqual([])
    expect(buffer.push('tial\n')).toEqual(['partial'])
  })

  it('holds back the tail of a chunk that does not end on a newline', () => {
    const buffer = createLineBuffer()
    expect(buffer.push('done\nhalf')).toEqual(['done'])
    expect(buffer.push(' a line\n')).toEqual(['half a line'])
  })

  it('strips the carriage return of a CRLF terminator', () => {
    const buffer = createLineBuffer()
    expect(buffer.push('one\r\ntwo\r\n')).toEqual(['one', 'two'])
  })

  it('keeps blank lines — what they mean is the caller’s business', () => {
    const buffer = createLineBuffer()
    expect(buffer.push('a\n\nb\n')).toEqual(['a', '', 'b'])
  })

  it('flushes a trailing line that never got its newline', () => {
    const buffer = createLineBuffer()
    buffer.push('kept')
    expect(buffer.flush()).toEqual(['kept'])
  })

  it('flushes nothing when the last chunk ended cleanly', () => {
    const buffer = createLineBuffer()
    buffer.push('a\n')
    expect(buffer.flush()).toEqual([])
  })

  it('flushes only once', () => {
    const buffer = createLineBuffer()
    buffer.push('tail')
    expect(buffer.flush()).toEqual(['tail'])
    expect(buffer.flush()).toEqual([])
  })
})
