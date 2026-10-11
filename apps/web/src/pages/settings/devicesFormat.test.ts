import { describe, it, expect } from 'vitest'
import {
  ONLINE_THRESHOLD_SECONDS,
  adminPathLine,
  adminPathSurface,
  buildLine,
  deviceLiveness,
  deviceSubtitle,
  lastUpdateLine,
  revokedToggleLabel,
  splitDevicesByRevoked,
  updateSaid,
  wslNote,
} from './devicesFormat'
import type { Device, UpdateOutcome } from '../../lib/api'

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
    // S42b: "install the Windows agent" pointed at a step that no longer
    // exists — pairing the PC (its own card's Windows line) replaces it.
    expect(wslNote(device({ wsl: 'Ubuntu-26.04' }))).toBe(
      "Runs inside WSL (Ubuntu-26.04). On Windows, Nova's agent runs on Windows itself — add the PC with the Windows line on its card, then revoke this one.",
    )
    expect(wslNote(device({ wsl: '' }))).toContain('Runs inside WSL.')
  })
  it('is null for a native agent, and for a revoked one', () => {
    expect(wslNote(device())).toBeNull()
    expect(wslNote(device({ wsl: 'Ubuntu-26.04', revoked_at: '2026-09-26T00:00:00Z' }))).toBeNull()
  })
})

describe('the build, in words (S42b)', () => {
  it('says behind, never older — a hash has no order', () => {
    expect(buildLine({ build_state: 'behind', hub_version: 'aaaaaaaaaaaa' })).toBe('behind the hub’s build aaaaaaaaaaaa')
    expect(buildLine({ build_state: 'current', hub_version: 'aaaaaaaaaaaa' })).toBe('the hub’s build')
    expect(buildLine({ build_state: 'unknown', hub_version: null })).toBeNull()
  })
  it('is null when behind but the hub has no build to name', () => {
    expect(buildLine({ build_state: 'behind', hub_version: null })).toBeNull()
  })
})

describe('deviceSubtitle appends the build against the hub’s, when there is one', () => {
  it('reads "agent <v> · the hub’s build" when current', () => {
    expect(deviceSubtitle(device({ agent_version: 'aaaaaaaaaaaa', build_state: 'current', hub_version: 'aaaaaaaaaaaa' })))
      .toBe('linux · thinkpad · agent aaaaaaaaaaaa · the hub’s build')
  })
  it('reads "agent <v> · behind the hub’s build <h>" when behind', () => {
    expect(deviceSubtitle(device({ agent_version: 'bbbbbbbbbbbb', build_state: 'behind', hub_version: 'aaaaaaaaaaaa' })))
      .toBe('linux · thinkpad · agent bbbbbbbbbbbb · behind the hub’s build aaaaaaaaaaaa')
  })
  it('names nothing extra when the build is unknown', () => {
    expect(deviceSubtitle(device({ agent_version: 'bbbbbbbbbbbb' }))).toBe('linux · thinkpad · agent bbbbbbbbbbbb')
  })
})

describe('lastUpdateLine — a sent update is never shown as confirmed', () => {
  it('says a sent update is not confirmed', () => {
    expect(lastUpdateLine({ version: 'aaaaaaaaaaaa', outcome: 'sent', at: '2026-09-28T12:00:00Z', reason: null }))
      .toContain('aaaaaaaaaaaa sent — not confirmed until it reconnects')
  })
  it('says a confirmed update plainly, with no "not confirmed" hedge', () => {
    expect(lastUpdateLine({ version: 'aaaaaaaaaaaa', outcome: 'confirmed', at: null, reason: null }))
      .toBe('Last update: aaaaaaaaaaaa confirmed')
  })
  it('names the reason when the ledger holds one', () => {
    expect(lastUpdateLine({ version: 'aaaaaaaaaaaa', outcome: 'rolled_back', at: null, reason: 'did not connect within 2m0s' }))
      .toBe('Last update: aaaaaaaaaaaa rolled back — did not connect within 2m0s')
  })
})

describe('updateSaid — what "update it now" came back with, in words (S42b)', () => {
  it('says a sent update is not confirmed', () => {
    expect(updateSaid({ outcome: 'confirmed', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false, in_flight: 0 }))
      .toBe('Updated to aaaaaaaaaaaa — it reconnected on it.')
    expect(updateSaid({ outcome: 'sent', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false, in_flight: 0 }))
      .toBe('Sent aaaaaaaaaaaa — not confirmed until it reconnects on it.')
  })
  it('says it is already current, and a rollback with its reason', () => {
    expect(updateSaid({ outcome: 'current', version: 'aaaaaaaaaaaa', from_version: null, reason: null, needs_card: false, in_flight: 0 }))
      .toBe('Already on the hub’s build.')
    expect(updateSaid({ outcome: 'rolled_back', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: 'did not connect within 2m0s', needs_card: false, in_flight: 0 }))
      .toBe('It did not come up on aaaaaaaaaaaa; its old build was put back — did not connect within 2m0s.')
  })

  describe('S42b E3 (F15): names how many running commands a restart there cancels', () => {
    it('says nothing extra with 0', () => {
      expect(updateSaid({ outcome: 'sent', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false, in_flight: 0 }))
        .toBe('Sent aaaaaaaaaaaa — not confirmed until it reconnects on it.')
    })
    it('names one command, singular', () => {
      expect(updateSaid({ outcome: 'sent', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false, in_flight: 1 }))
        .toBe('Sent aaaaaaaaaaaa — not confirmed until it reconnects on it. 1 running command there ends cancelled unless it finishes before the agent restarts.')
    })
    it('names several commands, plural', () => {
      expect(updateSaid({ outcome: 'sent', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false, in_flight: 2 }))
        .toBe('Sent aaaaaaaaaaaa — not confirmed until it reconnects on it. 2 running commands there end cancelled unless they finish before the agent restarts.')
    })
    it('names a count beside a confirmed outcome too, in the past tense', () => {
      expect(updateSaid({ outcome: 'confirmed', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false, in_flight: 1 }))
        .toBe('Updated to aaaaaaaaaaaa — it reconnected on it. 1 command was running there when it was sent, and a restart ends a running command cancelled.')
    })
  })

  describe('S42b E4 (Task 26 carry): a gateway timeout is "not known yet", never "failed"', () => {
    it('says the one stable sentence regardless of the underlying cause', () => {
      const timedOut: UpdateOutcome = {
        outcome: 'not_known_yet',
        version: null,
        from_version: null,
        reason: "the gateway did not answer in time (status 502); sent or not, not known yet — the machine's line will say",
        needs_card: false,
        in_flight: null,
      }
      const said = updateSaid(timedOut)
      expect(said).toBe("Sent or not — not known yet; the machine's line will say")
      expect(said.toLowerCase()).not.toContain('failed')
    })
  })

  it('an update that needs the owner names needs_card, carried through by the tile', () => {
    const out: UpdateOutcome = {
      outcome: 'cannot',
      version: null,
      from_version: null,
      reason: "cannot: laptop's agent was started by hand",
      needs_card: true,
      in_flight: 0,
    }
    expect(updateSaid(out)).toBe("cannot: laptop's agent was started by hand")
    expect(out.needs_card).toBe(true)
  })
})

describe('splitDevicesByRevoked — revoked hidden by default behind a toggle (owner 2026-09-28)', () => {
  it('splits live from revoked, each list keeping the original order', () => {
    const a = device({ id: 'a', name: 'a' })
    const b = device({ id: 'b', name: 'b', revoked_at: '2026-09-01T00:00:00Z' })
    const c = device({ id: 'c', name: 'c' })
    expect(splitDevicesByRevoked([a, b, c])).toEqual({ live: [a, c], revoked: [b] })
  })

  it('an all-live list has no revoked devices', () => {
    const a = device({ id: 'a' })
    expect(splitDevicesByRevoked([a])).toEqual({ live: [a], revoked: [] })
  })

  it('an all-revoked list has no live devices', () => {
    const a = device({ id: 'a', revoked_at: '2026-09-01T00:00:00Z' })
    expect(splitDevicesByRevoked([a])).toEqual({ live: [], revoked: [a] })
  })

  it('an empty list splits into two empty lists', () => {
    expect(splitDevicesByRevoked([])).toEqual({ live: [], revoked: [] })
  })
})

describe('revokedToggleLabel', () => {
  it('names the count while offering to reveal them', () => {
    expect(revokedToggleLabel(1, false)).toBe('Show revoked (1)')
    expect(revokedToggleLabel(3, false)).toBe('Show revoked (3)')
  })

  it('drops the count once they are revealed', () => {
    expect(revokedToggleLabel(3, true)).toBe('Hide revoked')
  })
})

// core's device_spec admin_path: {installed (core's platform-checked verdict),
// kind, line (device_facts.admin_path_line — the words Nova says)}. The tile
// shows that line, capitalised; it never words the path itself (T8 G1).
const SUDO = {
  installed: true,
  kind: 'sudoers',
  line: 'admin path: installed (sudoers rule) — an elevated run goes through sudo as root',
}
const TASK = {
  installed: true,
  kind: 'task',
  line: 'admin path: installed (scheduled task) — an elevated run runs as the signed-in user, elevated',
}
const ABSENT = { installed: false, kind: 'none', line: 'admin path: not installed' }
const UNKNOWN = { installed: false, kind: 'none', line: 'admin path: unknown — sudo -n -l failed: exit 1' }
const PREDATES = { installed: false, kind: null, line: 'admin path: unknown — this agent predates the admin path' }
const INCOMPLETE = {
  installed: false,
  kind: 'none',
  line: 'admin path: not installed — part of it is left (the task is absent but the copy is left)',
}
const PENDING = {
  installed: false,
  kind: 'none',
  line: 'admin path: not installed; the agent copy moved aside to C:\\Nova\\novad-admin-removed-1.exe is deleted at the next restart',
}
const FOREIGN = {
  installed: false,
  kind: 'task',
  line: 'admin path: unknown — the agent reported a task admin path on a linux machine, which has none of that kind',
}

describe('adminPathLine — the standing admin path (S30b), in core\'s words', () => {
  it('an installed sudoers rule and an installed scheduled task', () => {
    expect(adminPathLine(device({ admin_path: SUDO }))).toBe(
      'Admin path: installed (sudoers rule) — an elevated run goes through sudo as root',
    )
    expect(adminPathLine(device({ platform: 'windows', admin_path: TASK }))).toBe(
      'Admin path: installed (scheduled task) — an elevated run runs as the signed-in user, elevated',
    )
  })

  it('not installed is said', () => {
    expect(adminPathLine(device({ admin_path: ABSENT }))).toBe('Admin path: not installed')
  })

  it('unknown is unknown, never "not installed"', () => {
    expect(adminPathLine(device({ admin_path: UNKNOWN }))).toBe('Admin path: unknown — sudo -n -l failed: exit 1')
    expect(adminPathLine(device({ admin_path: PREDATES }))).toBe(
      'Admin path: unknown — this agent predates the admin path',
    )
  })

  it('an incomplete path says what is left', () => {
    expect(adminPathLine(device({ platform: 'windows', admin_path: INCOMPLETE }))).toBe(
      'Admin path: not installed — part of it is left (the task is absent but the copy is left)',
    )
  })

  it('a pending restart names the leftover path', () => {
    expect(adminPathLine(device({ platform: 'windows', admin_path: PENDING }))).toBe(
      'Admin path: not installed; the agent copy moved aside to C:\\Nova\\novad-admin-removed-1.exe is deleted at the next restart',
    )
  })

  it('a kind foreign to the platform is said as core says it — unknown, never "installed"', () => {
    expect(adminPathLine(device({ admin_path: FOREIGN }))).toBe(
      'Admin path: unknown — the agent reported a task admin path on a linux machine, which has none of that kind',
    )
  })

  it('never probed (null or absent) has no line', () => {
    expect(adminPathLine(device({ admin_path: null }))).toBeNull()
    expect(adminPathLine(device())).toBeNull()
  })

  it('a revoked device has no line, installed or not', () => {
    const revoked_at = '2026-09-01T00:00:00Z'
    expect(adminPathLine(device({ revoked_at, admin_path: SUDO }))).toBeNull()
    // T8 G2: installed:false has a line of its own — only the revoked check hides it.
    expect(adminPathLine(device({ revoked_at, admin_path: ABSENT }))).toBeNull()
    expect(adminPathLine(device({ revoked_at, admin_path: UNKNOWN }))).toBeNull()
  })
})

describe('adminPathSurface — one statement of what the path exposes', () => {
  const mini = device({ id: 'a', name: 'mini', admin_path: SUDO })
  const dell = device({ id: 'b', name: 'dell', platform: 'windows', admin_path: TASK })

  it('null when no live device has the path installed', () => {
    expect(adminPathSurface([])).toBeNull()
    expect(adminPathSurface([device({ admin_path: ABSENT }), device()])).toBeNull()
    expect(adminPathSurface([device({ admin_path: UNKNOWN }), device({ admin_path: FOREIGN })])).toBeNull()
    expect(adminPathSurface([{ ...mini, revoked_at: '2026-09-01T00:00:00Z' }])).toBeNull()
  })

  it('states the surface, names the machines, what it means and how to remove it', () => {
    const s = adminPathSurface([mini, device({ id: 'c', name: 'laptop' }), dell]) ?? ''
    expect(s).toMatch(/^Machines with the admin path: a compromise of Nova's core is root\/admin on each of them\./)
    expect(s).toContain('mini')
    expect(s).toContain('dell')
    expect(s).not.toContain('laptop')
    expect(s).toMatch(/any command/)
    expect(s).toMatch(/ask Nova to remove the admin path/i)
  })
})
