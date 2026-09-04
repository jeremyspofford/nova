import { describe, it, expect } from 'vitest'
import { ONLINE_THRESHOLD_SECONDS, deviceLiveness, enrollCommand } from './devicesFormat'
import type { Device } from '../../lib/api'

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'd-1',
    name: 'laptop',
    platform: 'linux',
    hostname: 'thinkpad',
    enrolled_at: '2026-08-30T00:00:00Z',
    last_seen: null,
    revoked_at: null,
    // Always false from the REST list by design — deviceLiveness must ignore it.
    connected: false,
    ...overrides,
  }
}

const NOW = new Date('2026-08-31T12:00:00Z')

describe('deviceLiveness — DERIVED from last_seen, never from `connected`', () => {
  it('a revoked device is "revoked", regardless of last_seen', () => {
    const live = deviceLiveness(
      device({ revoked_at: '2026-08-31T11:00:00Z', last_seen: NOW.toISOString() }),
      NOW,
    )
    expect(live.state).toBe('revoked')
    expect(live.label).toMatch(/revoked/i)
  })

  it('a never-seen device (last_seen null) is "never connected", NOT online', () => {
    const live = deviceLiveness(device({ last_seen: null }), NOW)
    expect(live.state).toBe('never')
    expect(live.label).toMatch(/never/i)
    // The no-fake-numbers rail: a never-seen device is not green.
    expect(live.state).not.toBe('online')
  })

  it('a fresh last_seen (well within the threshold) is online, even though connected=false', () => {
    const fresh = new Date(NOW.getTime() - 5_000).toISOString()
    const live = deviceLiveness(device({ last_seen: fresh, connected: false }), NOW)
    expect(live.state).toBe('online')
    expect(live.label).toBe('online')
  })

  it('exactly at the threshold is still online (<= boundary)', () => {
    const atEdge = new Date(NOW.getTime() - ONLINE_THRESHOLD_SECONDS * 1000).toISOString()
    expect(deviceLiveness(device({ last_seen: atEdge }), NOW).state).toBe('online')
  })

  it('one second past the threshold is stale, and names when it was last seen', () => {
    const stale = new Date(NOW.getTime() - (ONLINE_THRESHOLD_SECONDS + 1) * 1000).toISOString()
    const live = deviceLiveness(device({ last_seen: stale }), NOW)
    expect(live.state).toBe('stale')
    expect(live.label).toMatch(/last seen/i)
    expect(live.pulse).toBe(true)
  })

  it('connected=true on the payload does not manufacture online for a never-seen device', () => {
    // Belt-and-braces: even if a payload ever carried connected:true, liveness
    // is last_seen only — a never-seen device stays "never".
    const live = deviceLiveness(device({ last_seen: null, connected: true }), NOW)
    expect(live.state).toBe('never')
  })
})

describe('enrollCommand', () => {
  it('is the exact T3 CLI one-liner, with the origin and the code', () => {
    expect(enrollCommand('https://nova.example', 'A1B2C3D4')).toBe(
      'novad enroll --server https://nova.example --code A1B2C3D4',
    )
  })
})
