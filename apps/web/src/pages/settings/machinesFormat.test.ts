import { describe, it, expect } from 'vitest'
import { lifecycleLabel, machineStateLabel, readBackMismatch } from './machinesFormat'

describe('machineStateLabel', () => {
  // `line`: the label is a sentence (a reason, or what the switch does), so
  // the tile gives it a line of its own — a badge is one fixed line and
  // cannot wrap.
  it('names the gateway states in words, with the reason when a machine is not answering', () => {
    expect(machineStateLabel({ state: 'ready', reason: null })).toEqual({ text: 'ready', color: 'success', line: false })
    expect(machineStateLabel({ state: 'unreachable', reason: 'ConnectError: connection refused' })).toEqual({ text: 'not answering — ConnectError: connection refused', color: 'danger', line: true })
    expect(machineStateLabel({ state: 'unreachable', reason: null })).toEqual({ text: 'not answering', color: 'danger', line: false })
    expect(machineStateLabel({ state: 'unreachable', reason: '' })).toEqual({ text: 'not answering', color: 'danger', line: false })
    expect(machineStateLabel({ state: 'unobserved', reason: null })).toEqual({ text: 'not checked yet', color: 'neutral', line: false })
  })
  it('says only what the switch enforces: chat routing passes over it (S40 fix wave B5)', () => {
    // Moved: this read "not running chat models", which the gateway does not
    // enforce — a call outside any role still runs there, and a model
    // already loaded stays loaded. Only the role walk reads the switch.
    const label = machineStateLabel({ state: 'switched_off', reason: 'hub is switched off (serving=false)' })
    expect(label).toEqual({ text: 'switched off — chat routing passes over it', color: 'neutral', line: true })
    expect(label.text).not.toMatch(/not running|no model calls/)
  })
  it("shows a state it does not know in the gateway's own word rather than hiding it", () => {
    expect(machineStateLabel({ state: 'waking', reason: null })).toEqual({ text: 'waking', color: 'neutral', line: false })
    expect(machineStateLabel({ state: 'waking', reason: 'magic packet sent' })).toEqual({ text: 'waking — magic packet sent', color: 'neutral', line: true })
  })
})

describe('readBackMismatch', () => {
  it('is silent when the machine reads back what was asked', () => {
    expect(readBackMismatch('hub', false, { serving: false })).toBeNull()
  })
  it('says what was asked and what was read back when they differ', () => {
    expect(readBackMismatch('hub', false, { serving: true })).toBe('Asked to turn chat models off on hub, but it reads back on.')
  })
})

describe('lifecycleLabel', () => {
  it('words the two lifecycles and passes anything else through', () => {
    expect(lifecycleLabel('always_on')).toBe('always on')
    expect(lifecycleLabel('wake_on_lan')).toBe('wakes on LAN')
    expect(lifecycleLabel('something_new')).toBe('something_new')
  })
})
