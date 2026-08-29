import { describe, it, expect } from 'vitest'
import { formatBytes, notShownMessage } from './filesFormat'

describe('formatBytes', () => {
  it('renders sub-1024 sizes in bytes, including the small workspace files this page mostly shows', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(7)).toBe('7 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('renders kilobytes with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('renders megabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('notShownMessage', () => {
  it('names the too-large reason and the real size, in bytes, per the plan\'s stated shape', () => {
    const msg = notShownMessage({ size: 500000, binary: false, too_large: true })
    expect(msg).toContain('500000 bytes')
    expect(msg).toContain('not shown')
    expect(msg).toContain('download')
    expect(msg).toContain('too large')
  })

  it('names the binary reason', () => {
    const msg = notShownMessage({ size: 4096, binary: true, too_large: false })
    expect(msg).toContain('4096 bytes')
    expect(msg).toContain('binary')
  })

  it('never claims both reasons when only one applies', () => {
    const msg = notShownMessage({ size: 10, binary: true, too_large: false })
    expect(msg).not.toContain('too large')
  })
})
