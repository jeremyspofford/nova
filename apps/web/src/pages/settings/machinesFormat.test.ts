import { describe, it, expect } from 'vitest'
import { lifecycleLabel, machineStateLabel, readBackMismatch } from './machinesFormat'

describe('machineStateLabel', () => {
  it('names the gateway states in words, with the reason when a machine is not answering', () => {
    expect(machineStateLabel({ state: 'ready', reason: null })).toEqual({ text: 'ready', color: 'success' })
    expect(machineStateLabel({ state: 'switched_off', reason: null })).toEqual({ text: 'not running chat models', color: 'neutral' })
    expect(machineStateLabel({ state: 'unreachable', reason: 'ConnectError: connection refused' })).toEqual({ text: 'not answering — ConnectError: connection refused', color: 'danger' })
    expect(machineStateLabel({ state: 'unreachable', reason: null })).toEqual({ text: 'not answering', color: 'danger' })
    expect(machineStateLabel({ state: 'unobserved', reason: null })).toEqual({ text: 'not checked yet', color: 'neutral' })
  })
  it("shows a state it does not know in the gateway's own word rather than hiding it", () => {
    expect(machineStateLabel({ state: 'waking', reason: null })).toEqual({ text: 'waking', color: 'neutral' })
    expect(machineStateLabel({ state: 'waking', reason: 'magic packet sent' })).toEqual({ text: 'waking — magic packet sent', color: 'neutral' })
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
