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
 * A stated refusal for an fs-root the operator is trying to add, or null if it
 * is acceptable. This is FAST FEEDBACK only — the backend refuses the same
 * inputs (non-absolute or `..`-containing, per devices.clean_fs_roots) — so it
 * never lets through something the PUT would then reject as a surprise.
 */
export function fsRootRefusal(path: string): string | null {
  const trimmed = path.trim()
  if (trimmed === '') return 'Enter a path.'
  if (!trimmed.startsWith('/')) {
    return `A filesystem root must be an absolute path — "${trimmed}" does not start with "/".`
  }
  // Mirror the backend (services/core/app/devices.clean_fs_roots): a ".."
  // path SEGMENT is refused, but ".." inside a name is not — so
  // "/home/jeremy/my..project" is a real directory the backend accepts, and
  // refusing it here would be a false refusal the operator can't act on.
  if (trimmed.split('/').includes('..')) {
    return `A filesystem root cannot contain a ".." path segment — give the real path.`
  }
  return null
}

/**
 * The enroll one-liner shown in the pairing modal (controller ruling R-pre2,
 * reconciled against T3's CLI: `novad enroll --server <url> --code <code>`).
 * `origin` is window.location.origin — the same single origin the phone uses.
 */
export function enrollCommand(origin: string, code: string): string {
  return `novad enroll --server ${origin} --code ${code}`
}

export interface CapabilitySpec {
  token: string
  label: string
}

/**
 * The 8 grantable capabilities, in the plan's order and grouping. A fresh
 * device holds only `system.info`; everything else is the operator's to grant.
 * `fs.write` / `apps.launch` / `shell.exec` are the powerful (consent-gated in
 * core) set. Each carries a plain-language label; the raw token is rendered
 * alongside it so what is being granted is never hidden behind a friendly name.
 */
export const CAPABILITY_GROUPS: { title: string; caps: CapabilitySpec[] }[] = [
  {
    title: 'Reads (safe)',
    caps: [
      { token: 'system.info', label: 'Read system info' },
      { token: 'system.notify', label: 'Send a desktop notification' },
      { token: 'fs.list', label: 'List files' },
      { token: 'fs.read', label: 'Read files' },
      { token: 'apps.list', label: 'List installed apps' },
    ],
  },
  {
    title: 'Actions (powerful)',
    caps: [
      { token: 'fs.write', label: 'Write files' },
      { token: 'apps.launch', label: 'Launch an app' },
      { token: 'shell.exec', label: 'Run a shell command' },
    ],
  },
]
