import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HumanText, formatStamp, shortReason, groupRefusals } from './humanText'

// UI review R12 (2026-10-11): machine text reached the screen as-is — ISO
// timestamps with microseconds in Inbox titles, whole exception strings in
// badges, 20 identical refusal lines. Format at the edge; keep the raw
// text one hover away, never drop it.

const NOW = new Date('2026-10-11T18:00:00Z')

describe('formatStamp', () => {
  it('a full timestamp reads as a local date and time, with no seconds', () => {
    const out = formatStamp('2026-10-12T16:10:05.378391+00:00', NOW)
    expect(out).not.toMatch(/2026-10-12T|\.378391|\+00:00/)
    expect(out).toMatch(/12 Oct/)
    expect(out).toMatch(/\d{1,2}:\d{2}/)
  })

  it('a bare date reads as day and month, the year only when it is not this one', () => {
    expect(formatStamp('2026-09-11', NOW)).toBe('11 Sep')
    expect(formatStamp('2025-09-11', NOW)).toBe('11 Sep 2025')
  })
})

describe('HumanText', () => {
  it('replaces timestamps inside a sentence and keeps the raw value on hover', () => {
    render(<HumanText text="openrouter is walled until 2026-10-12T16:10:05.378391+00:00 after 5 refusals" now={NOW} />)
    const t = screen.getByTitle('2026-10-12T16:10:05.378391+00:00')
    expect(t.tagName).toBe('TIME')
    expect(t.getAttribute('datetime')).toBe('2026-10-12T16:10:05.378391+00:00')
    expect(document.body.textContent).toMatch(/^openrouter is walled until .*12 Oct.* after 5 refusals$/)
    expect(document.body.textContent).not.toContain('378391')
  })

  it('leaves text without a timestamp exactly as it was', () => {
    const { container } = render(<HumanText text="no time here — 402: 12.5 credits" now={NOW} />)
    expect(container.textContent).toBe('no time here — 402: 12.5 credits')
    expect(container.querySelector('time')).toBeNull()
  })
})

describe('shortReason', () => {
  it('names the common causes in a word or two', () => {
    expect(shortReason('could not reach dell at http://100.122.40.93:11435/v1 — ConnectTimeout')).toBe('unreachable')
    expect(shortReason('openrouter refused (402): Insufficient credits. Add more using https://openrouter.ai/settings/credits')).toBe('out of credits')
    expect(shortReason('invalid x-api-key')).toBe('key rejected')
    expect(shortReason('429 Too Many Requests')).toBe('rate limited')
  })

  it('cuts anything else to a short clause rather than inventing a cause', () => {
    const r = shortReason('model produced an empty completion after the stop token was seen twice in a row')
    expect(r.length).toBeLessThanOrEqual(41)
    expect(r.startsWith('model produced an empty completion')).toBe(true)
  })
})

describe('groupRefusals', () => {
  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
  const dell = (model: string, h: number, purpose = 'review_commitments') => ({
    at: at(h), provider: 'dell', model, status: 502, purpose,
    error: 'could not reach dell at http://100.122.40.93:11435/v1 — ConnectTimeout',
  })

  it('folds the same provider, cause and purpose into one line with a count and every model', () => {
    const groups = groupRefusals([dell('qwen3:8b', 1), dell('qwen3.8:27b', 2), dell('qwen3:8b', 30)])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ provider: 'dell', reason: 'unreachable', purpose: 'review_commitments', count: 3 })
    expect(groups[0].models).toEqual(['qwen3:8b', 'qwen3.8:27b'])
    expect(groups[0].latest).toBe(at(1))
    expect(groups[0].raw).toContain('ConnectTimeout')
  })

  it('keeps different causes or purposes apart, newest group first', () => {
    const groups = groupRefusals([
      dell('qwen3:8b', 5),
      dell('qwen3:8b', 6, 'scheduled'),
      { at: at(1), provider: 'openrouter', model: 'x', status: 402, purpose: 'chat', error: 'Insufficient credits' },
    ])
    expect(groups.map(g => `${g.provider}/${g.reason}/${g.purpose}`)).toEqual([
      'openrouter/out of credits/chat',
      'dell/unreachable/review_commitments',
      'dell/unreachable/scheduled',
    ])
  })
})
