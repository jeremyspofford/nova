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
 * The enroll one-liner shown in the pairing modal (controller ruling R-pre2,
 * reconciled against T3's CLI: `novad enroll --server <url> --code <code>`).
 * `origin` is window.location.origin — the same single origin the phone uses.
 */
export function enrollCommand(origin: string, code: string): string {
  return `novad enroll --server ${origin} --code ${code}`
}
