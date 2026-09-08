import { describe, it, expect } from 'vitest'
import {
  deliveryLines,
  firingDurationMs,
  firingStatusBadge,
  formatNextFire,
  kindBadge,
  lastOutcome,
  payloadSummary,
  timerState,
} from './schedulesFormat'

describe('kindBadge', () => {
  it('maps the three kinds and shows an unknown one verbatim, never hidden', () => {
    expect(kindBadge('reminder')).toEqual({ label: 'reminder', color: 'accent' })
    expect(kindBadge('scheduled')).toEqual({ label: 'scheduled', color: 'info' })
    expect(kindBadge('job')).toEqual({ label: 'job', color: 'neutral' })
    expect(kindBadge('future')).toEqual({ label: 'future', color: 'neutral' })
  })
})

describe('timerState — derived from paused_at and next_fire_at, never a flag', () => {
  it('paused wins, whoever paused it', () => {
    expect(timerState({ paused_at: '2026-09-06T10:00:00Z', next_fire_at: '2026-09-07T07:00:00Z' }))
      .toEqual({ state: 'paused', label: 'paused', color: 'warning' })
    // A paused once that has no next fire is still "paused", not "finished".
    expect(timerState({ paused_at: '2026-09-06T10:00:00Z', next_fire_at: null }).state).toBe('paused')
  })

  it('a NULL next_fire_at is a once that has fired — finished', () => {
    expect(timerState({ paused_at: null, next_fire_at: null }))
      .toEqual({ state: 'finished', label: 'finished', color: 'neutral' })
  })

  it('otherwise active', () => {
    expect(timerState({ paused_at: null, next_fire_at: '2026-09-07T07:00:00Z' }))
      .toEqual({ state: 'active', label: 'active', color: 'success' })
  })
})

describe('firingStatusBadge', () => {
  it('pulses only while running; refused is a failure, said as one', () => {
    expect(firingStatusBadge('running')).toEqual({ label: 'running', color: 'neutral', pulse: true })
    expect(firingStatusBadge('ok')).toEqual({ label: 'ok', color: 'success', pulse: false })
    expect(firingStatusBadge('error')).toEqual({ label: 'error', color: 'danger', pulse: false })
    expect(firingStatusBadge('refused')).toEqual({ label: 'refused', color: 'danger', pulse: false })
    expect(firingStatusBadge('interrupted')).toEqual({ label: 'interrupted', color: 'warning', pulse: false })
  })

  it('shows an unrecognised status verbatim rather than relabelling it', () => {
    expect(firingStatusBadge('mystery')).toEqual({ label: 'mystery', color: 'neutral', pulse: false })
  })
})

describe('formatNextFire — how soon, in the browser locale', () => {
  const now = new Date('2026-09-06T14:30:00Z')

  it('counts seconds, minutes, hours, days', () => {
    expect(formatNextFire('2026-09-06T14:30:45Z', now).relative).toBe('in 45s')
    expect(formatNextFire('2026-09-06T14:32:00Z', now).relative).toBe('in 2m')
    expect(formatNextFire('2026-09-06T17:30:00Z', now).relative).toBe('in 3h')
    expect(formatNextFire('2026-09-08T14:30:00Z', now).relative).toBe('in 2d')
  })

  it('says "due" for an instant at or before now — owed to the next tick, not overdue', () => {
    expect(formatNextFire('2026-09-06T14:30:00Z', now).relative).toBe('due')
    expect(formatNextFire('2026-09-06T14:29:00Z', now).relative).toBe('due')
  })

  it('falls back to the date beyond a week, and always carries the exact local time', () => {
    const far = formatNextFire('2026-10-01T07:00:00Z', now)
    expect(far.relative).toBe(far.absolute)
    expect(far.relative).not.toMatch(/^in /)
    expect(formatNextFire('2026-09-06T14:32:00Z', now).absolute).toMatch(/\d/)
  })

  it('names the year only when it is not this one', () => {
    expect(formatNextFire('2027-01-01T07:00:00Z', now).absolute).toContain('2027')
    expect(formatNextFire('2026-09-08T14:30:00Z', now).absolute).not.toContain('2026')
  })
})

describe('lastOutcome — never fired is an absence, not an ok', () => {
  it('returns null for a timer that has never fired', () => {
    expect(lastOutcome(null)).toBeNull()
  })

  it('returns null, not a crash, for a row that carries no last_firing at all', () => {
    expect(lastOutcome(undefined)).toBeNull()
  })

  it('carries the stated reason with the badge', () => {
    expect(lastOutcome({ status: 'error', ended_at: '2026-09-06T14:00:00Z', reason: 'no such device' }))
      .toEqual({ label: 'error', color: 'danger', pulse: false, detail: 'no such device' })
    expect(lastOutcome({ status: 'ok', ended_at: '2026-09-06T14:00:00Z', reason: null })?.detail).toBeNull()
  })
})

describe('deliveryLines — one line per channel, from that channel\'s own result', () => {
  it('chat ok; each device on its own line; an offline device states its reason', () => {
    expect(
      deliveryLines({
        chat: { ok: true },
        devices: [
          { name: 'laptop', ok: true },
          { name: 'phone', ok: false, reason: 'offline' },
        ],
      }),
    ).toEqual([
      { channel: 'chat', verdict: 'ok', text: 'chat: delivered' },
      { channel: 'laptop', verdict: 'ok', text: 'device laptop: delivered' },
      { channel: 'phone', verdict: 'failed', text: 'device phone: offline' },
    ])
  })

  it('a failed chat delivery carries its reason; a device failure with none says "failed"', () => {
    expect(deliveryLines({ chat: { ok: false, reason: 'conversation gone' } })).toEqual([
      { channel: 'chat', verdict: 'failed', text: 'chat: failed — conversation gone' },
    ])
    expect(deliveryLines({ devices: [{ name: 'x', ok: false }] })).toEqual([
      { channel: 'x', verdict: 'failed', text: 'device x: failed' },
    ])
  })

  it('no connected device is a STATED fact — the note, not a failure', () => {
    expect(
      deliveryLines({ chat: { ok: true }, devices: [], note: 'no paired device was connected' }),
    ).toEqual([
      { channel: 'chat', verdict: 'ok', text: 'chat: delivered' },
      { channel: 'devices', verdict: 'stated', text: 'no paired device was connected' },
    ])
  })

  it('a job\'s empty delivery yields no lines; absent delivery yields none', () => {
    expect(deliveryLines({})).toEqual([])
    expect(deliveryLines(undefined)).toEqual([])
    expect(deliveryLines(null)).toEqual([])
  })
})

describe('payloadSummary — what a firing does, from the payload', () => {
  it('a reminder quotes his words and names where they go', () => {
    expect(payloadSummary({ kind: 'reminder', payload: { message: 'stretch', device: null } }))
      .toBe('“stretch” — to chat and every connected device')
    expect(payloadSummary({ kind: 'reminder', payload: { message: 'stretch', device: 'laptop' } }))
      .toBe('“stretch” — to chat and device laptop')
  })

  it('a scheduled timer shows its instruction; a job its handler', () => {
    expect(payloadSummary({ kind: 'scheduled', payload: { instruction: 'tell me what is on my calendar' } }))
      .toBe('tell me what is on my calendar')
    expect(payloadSummary({ kind: 'job', payload: { handler: 'retention' } })).toBe('handler: retention')
  })

  it('a payload missing the field its kind promises is null, never an empty quote', () => {
    expect(payloadSummary({ kind: 'reminder', payload: {} })).toBeNull()
    expect(payloadSummary({ kind: 'scheduled', payload: { instruction: '' } })).toBeNull()
    expect(payloadSummary({ kind: 'job', payload: {} })).toBeNull()
  })
})

describe('firingDurationMs', () => {
  it('is null while the firing is still running — never a fake zero', () => {
    expect(firingDurationMs({ started_at: '2026-09-06T14:00:00Z', ended_at: null })).toBeNull()
  })

  it('measures started to ended', () => {
    expect(firingDurationMs({ started_at: '2026-09-06T14:00:00Z', ended_at: '2026-09-06T14:00:01.500Z' }))
      .toBe(1500)
  })
})
