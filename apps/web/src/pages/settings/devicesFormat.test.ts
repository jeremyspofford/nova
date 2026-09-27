import { describe, it, expect } from 'vitest'
import { ONLINE_THRESHOLD_SECONDS, deviceLiveness, deviceSubtitle, enrollCommand, wslNote } from './devicesFormat'
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
    os: null,
    wsl: null,
    agent_version: null,
    facts_at: null,
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

describe('deviceSubtitle — what the agent reported, when it did', () => {
  it('names the OS the agent reported, the hostname and the agent version', () => {
    expect(
      deviceSubtitle(device({ os: 'Windows 11 Pro 24H2 (build 26100)', agent_version: '0.2.0' })),
    ).toBe('Windows 11 Pro 24H2 (build 26100) · thinkpad · agent 0.2.0')
  })
  it('falls back to the enrolled platform for an agent that sends no facts', () => {
    expect(deviceSubtitle(device())).toBe('linux · thinkpad')
  })
})

describe('wslNote — an agent inside WSL gives way to the Windows agent', () => {
  it('says so, naming the distro when it is known', () => {
    expect(wslNote(device({ wsl: 'Ubuntu-26.04' }))).toBe(
      "Runs inside WSL (Ubuntu-26.04). On Windows, Nova's agent runs on Windows itself — install the Windows agent, then revoke this one.",
    )
    expect(wslNote(device({ wsl: '' }))).toContain('Runs inside WSL.')
  })
  it('is null for a native agent, and for a revoked one', () => {
    expect(wslNote(device())).toBeNull()
    expect(wslNote(device({ wsl: 'Ubuntu-26.04', revoked_at: '2026-09-26T00:00:00Z' }))).toBeNull()
  })
})
