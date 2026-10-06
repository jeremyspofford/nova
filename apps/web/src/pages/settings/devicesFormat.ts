import type { Device, UpdateOutcome } from '../../lib/api'
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
 * The build against the hub's (S42b): behind means "not the hub's build" — a
 * hash has no order, so this is never "older". null when there is nothing to
 * say — no hub build to compare against, or no build this agent reported
 * (device_facts.build_state's own "unknown").
 */
export function buildLine(d: Pick<Device, 'build_state' | 'hub_version'>): string | null {
  if (d.build_state === 'current') return 'the hub’s build'
  if (d.build_state === 'behind' && d.hub_version) return `behind the hub’s build ${d.hub_version}`
  return null
}

/**
 * The tile's second line: the OS the agent REPORTED (its facts, S42a) when it
 * did, else the platform it enrolled with — then the hostname, the agent's
 * version when known, and its build against the hub's (S42b) when there is
 * one to state. Read from facts, never guessed from a name.
 */
export function deviceSubtitle(device: Device): string {
  const parts = [device.os ?? device.platform, device.hostname]
  if (device.agent_version) parts.push(`agent ${device.agent_version}`)
  const build = buildLine(device)
  if (build) parts.push(build)
  return parts.join(' · ')
}

/**
 * The note an agent inside WSL carries (hub decision D1): on Windows, Nova's
 * agent runs on Windows itself and reaches WSL through wsl.exe, so this one
 * gives way to it. null for every other device, and for a revoked one.
 *
 * S42b: points at the Windows line on that machine's own setup card — the
 * retired "install the Windows agent" named a step (a standalone Windows
 * agent install) that no longer exists; pairing the PC is what replaces it.
 */
export function wslNote(device: Device): string | null {
  if (device.wsl === null || device.revoked_at !== null) return null
  const distro = device.wsl ? ` (${device.wsl})` : ''
  return `Runs inside WSL${distro}. On Windows, Nova's agent runs on Windows itself — add the PC with the Windows line on its card, then revoke this one.`
}

/**
 * The device's latest update attempt (S42b decision 2), as a line for the
 * tile. `u.at` is core's own clock (devices.rows_with_last_update), never
 * the browser's. A `sent` outcome is never shown as confirmed — only the
 * agent's own reconnect on the new build does that (core's own rule, and
 * the same one `updateSaid` holds to for the live response).
 */
export function lastUpdateLine(u: NonNullable<Device['last_update']>): string {
  const when = u.at ? ` (${new Date(u.at).toLocaleString()})` : ''
  if (u.outcome === 'sent') return `Last update: ${u.version} sent — not confirmed until it reconnects${when}`
  return `Last update: ${u.version} ${u.outcome.replace('_', ' ')}${u.reason ? ` — ${u.reason}` : ''}${when}`
}

/**
 * S42b E3 (F15): the clause naming how many commands were already running on
 * the machine when an update went out — the hub keeps futures, not
 * capability names, so this is a COUNT, never their identities. "" with 0:
 * nothing was running there, so nothing extra is said. Mirrors core's own
 * words for the same fact (services/core/app/tools/machines.py's
 * `_cancelled_words`) so the tile and what Nova says about the same update
 * agree with each other.
 */
function cancelledNote(outcome: UpdateOutcome['outcome'], count: number): string {
  if (!count) return ''
  const plural = count !== 1
  if (outcome === 'sent') {
    return ` ${count} running command${plural ? 's' : ''} there ${plural ? 'end' : 'ends'} cancelled unless ${
      plural ? 'they finish' : 'it finishes'
    } before the agent restarts.`
  }
  return ` ${count} command${plural ? 's' : ''} ${plural ? 'were' : 'was'} running there when it was sent, and a restart ends a running command cancelled.`
}

/**
 * What "update it now" came back with, in words for the tile (S42b decision
 * 2). `sent` is never said as updated — only the agent's reconnect on the
 * new build does that. `not_known_yet` (S42b E4, carried from Task 26) is
 * never said as a failure: the gateway itself did not answer — a dead or
 * overloaded proxy, never core's own stated refusal — so whether the update
 * reached the agent is genuinely unknown here, and the tile says exactly
 * that, never "failed".
 */
export function updateSaid(o: UpdateOutcome): string {
  const base = (() => {
    switch (o.outcome) {
      case 'confirmed':
        return `Updated to ${o.version} — it reconnected on it.`
      case 'sent':
        return `Sent ${o.version} — not confirmed until it reconnects on it.`
      case 'current':
        return 'Already on the hub’s build.'
      case 'rolled_back':
        return `It did not come up on ${o.version}; its old build was put back — ${o.reason ?? 'no reason given'}.`
      case 'not_known_yet':
        // S42b E4: never "failed", and never the gateway's own stated
        // reason verbatim — the tile's one stable sentence, whatever the
        // underlying cause (a dead gateway, Cloudflare's 524, the network
        // failing after the request left).
        return "Sent or not — not known yet; the machine's line will say"
      default:
        return o.reason ?? `The update ${o.outcome.replace('_', ' ')}.`
    }
  })()
  return base + cancelledNote(o.outcome, o.in_flight ?? 0)
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
