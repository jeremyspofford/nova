import type { Device } from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'

/**
 * Pure presentation logic for Settings → Devices — kept apart from the section
 * component so the one property this slice keeps coming back to (liveness is
 * DERIVED from last_seen freshness, never from a stored flag) is a function a
 * test pins without rendering anything.
 *
 * Why not the REST `connected` field: `GET /devices` returns `connected:false`
 * for EVERY device by design (only the model-facing device_list tool overwrites
 * it from live WS hub membership — the REST route does not). So driving a tile
 * off `connected` would leave every device reading disconnected forever. The
 * daemon heartbeats ~every 20s, which bumps `last_seen` to core's clock; three
 * missed beats (60s) with no advance is the online cutoff. Kill its network and
 * `last_seen` stops moving; the tile goes stale. This is controller ruling R2.
 */
export const ONLINE_THRESHOLD_SECONDS = 60

export type LivenessState = 'revoked' | 'never' | 'online' | 'stale'

export interface Liveness {
  state: LivenessState
  /** Human label for the tile ("online" / "never connected" / "last seen …"). */
  label: string
  /** A stale-but-alive tile pulses, like the Activity unfinished-turn idiom. */
  pulse: boolean
}

/**
 * A device's liveness, derived. `now` is injected so a test drives the clock.
 * Order matters: a revoked device is shown-but-muted before anything else; a
 * never-seen device is "never connected" (NOT a green dot — DoD item 5); else
 * the age of `last_seen` decides online vs stale against ONLINE_THRESHOLD.
 */
export function deviceLiveness(device: Device, now: Date = new Date()): Liveness {
  if (device.revoked_at !== null) {
    return { state: 'revoked', label: 'revoked', pulse: false }
  }
  if (device.last_seen === null) {
    return { state: 'never', label: 'never connected', pulse: false }
  }
  const ageSeconds = (now.getTime() - new Date(device.last_seen).getTime()) / 1000
  if (ageSeconds <= ONLINE_THRESHOLD_SECONDS) {
    return { state: 'online', label: 'online', pulse: false }
  }
  return { state: 'stale', label: `last seen ${formatRelativeTime(device.last_seen, now)}`, pulse: true }
}

/**
 * The tile's second line: the OS the agent REPORTED (its facts, S42a) when it
 * did, else the platform it enrolled with — then the hostname and, when known,
 * the agent's version. Read from facts, never guessed from a name.
 */
export function deviceSubtitle(device: Device): string {
  const parts = [device.os ?? device.platform, device.hostname]
  if (device.agent_version) parts.push(`agent ${device.agent_version}`)
  return parts.join(' · ')
}

/**
 * The note an agent inside WSL carries (hub decision D1): on Windows, Nova's
 * agent runs on Windows itself and reaches WSL through wsl.exe, so this one
 * gives way to it. null for every other device, and for a revoked one.
 */
export function wslNote(device: Device): string | null {
  if (device.wsl === null || device.revoked_at !== null) return null
  const distro = device.wsl ? ` (${device.wsl})` : ''
  return `Runs inside WSL${distro}. On Windows, Nova's agent runs on Windows itself — install the Windows agent, then revoke this one.`
}

/**
 * Owner ruling 2026-09-28 ("the revoked machine is still in the devices
 * list, just crossed out" → "Hide them (Recommended)"): revoked devices are
 * kept out of the Devices list by default, behind a "Show revoked" toggle —
 * display only, the API and the audit/history record are untouched. Kept
 * pure and apart from the section component so the split is a function a
 * test pins without rendering. Order within each list is preserved.
 */
export function splitDevicesByRevoked(devices: Device[]): { live: Device[]; revoked: Device[] } {
  const live: Device[] = []
  const revoked: Device[] = []
  for (const d of devices) {
    ;(d.revoked_at === null ? live : revoked).push(d)
  }
  return { live, revoked }
}

/**
 * The "Show/Hide revoked" toggle's label — named with the count only while
 * it is offering to reveal them, per the owner's example ("Show revoked (1)"
 * / "Hide revoked").
 */
export function revokedToggleLabel(revokedCount: number, showRevoked: boolean): string {
  return showRevoked ? 'Hide revoked' : `Show revoked (${revokedCount})`
}
