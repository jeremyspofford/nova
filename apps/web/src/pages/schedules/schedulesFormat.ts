import type { SemanticColor } from '../../lib/design-tokens'
import type {
  Timer,
  TimerDelivery,
  TimerFiring,
  TimerFiringStatus,
  TimerKind,
  TimerLastFiring,
} from '../../lib/api'

/**
 * Pure presentation logic for the Schedules page — kept apart from the
 * component, as activityFormat.ts is, so each property the page has to get
 * right is one function a test can pin down without rendering anything.
 *
 * What is deliberately NOT here: any recurrence arithmetic. The words for a
 * schedule ("every day at 07:00 America/New_York, next Sun 7 Sep") come from
 * core's `describe()` on the row (`schedule_words`) — the same function her
 * chat confirmation uses — and are rendered verbatim. This file only formats
 * the instants core already computed (`next_fire_at`, a firing's times) in
 * the browser's locale, and maps statuses to badges.
 */

/** The three kinds (timers.kind CHECK). A kind this map has not met still
 * renders, verbatim and neutral, rather than being hidden. */
export function kindBadge(kind: TimerKind | string): { label: string; color: SemanticColor } {
  if (kind === 'reminder') return { label: 'reminder', color: 'accent' }
  if (kind === 'scheduled') return { label: 'scheduled', color: 'info' }
  if (kind === 'job') return { label: 'job', color: 'neutral' }
  return { label: kind, color: 'neutral' }
}

export type TimerState = 'active' | 'paused' | 'finished'

/**
 * A timer's state is DERIVED from two columns, never a stored flag:
 * `paused_at` set → paused (core also pauses a timer itself after 5
 * consecutive failures — `paused_reason` says which); otherwise
 * `next_fire_at` NULL → finished (a once that has fired); otherwise active.
 */
export function timerState(timer: Pick<Timer, 'paused_at' | 'next_fire_at'>): {
  state: TimerState
  label: string
  color: SemanticColor
} {
  if (timer.paused_at !== null) return { state: 'paused', label: 'paused', color: 'warning' }
  if (timer.next_fire_at === null) return { state: 'finished', label: 'finished', color: 'neutral' }
  return { state: 'active', label: 'active', color: 'success' }
}

/** timer_firings.status → badge. `running` pulses; `refused` (a firing core
 * could not run — an unknown job handler) is a failure, said as one. An
 * unrecognised value earns its own label rather than being relabelled. */
export function firingStatusBadge(status: TimerFiringStatus | string): {
  label: string
  color: SemanticColor
  pulse: boolean
} {
  if (status === 'running') return { label: 'running', color: 'neutral', pulse: true }
  if (status === 'ok') return { label: 'ok', color: 'success', pulse: false }
  if (status === 'error') return { label: 'error', color: 'danger', pulse: false }
  if (status === 'refused') return { label: 'refused', color: 'danger', pulse: false }
  if (status === 'interrupted') return { label: 'interrupted', color: 'warning', pulse: false }
  return { label: status, color: 'neutral', pulse: false }
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** An instant in the browser's locale: weekday, date and time, with the
 * year only when it is not this one. */
export function formatAbsolute(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  return then.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * `next_fire_at` as "how soon" plus the exact local time. A next fire at or
 * before now reads "due": the scheduler claims due rows on its next tick
 * (within a minute), so the row is honest about being owed, not overdue.
 * Beyond a week the relative form stops being useful and the date is shown.
 */
export function formatNextFire(
  iso: string,
  now: Date = new Date(),
): { relative: string; absolute: string } {
  const then = new Date(iso)
  const diffSec = Math.round((then.getTime() - now.getTime()) / 1000)
  const absolute = formatAbsolute(iso, now)
  let relative: string
  if (diffSec <= 0) relative = 'due'
  else if (diffSec < MINUTE) relative = `in ${diffSec}s`
  else if (diffSec < HOUR) relative = `in ${Math.round(diffSec / MINUTE)}m`
  else if (diffSec < DAY) relative = `in ${Math.round(diffSec / HOUR)}h`
  else if (diffSec < WEEK) relative = `in ${Math.round(diffSec / DAY)}d`
  else relative = absolute
  return { relative, absolute }
}

/**
 * The newest firing's outcome for the list row, or null when the timer has
 * never fired — the caller renders that as an absence (an em dash), never a
 * fabricated "ok". `detail` carries the stated reason when there is one.
 */
export function lastOutcome(last: TimerLastFiring | null | undefined): {
  label: string
  color: SemanticColor
  pulse: boolean
  detail: string | null
} | null {
  // `undefined` too: a core that does not serialise `last_firing` on the row
  // yet is "nothing known", not a reason to crash the whole page.
  if (last == null) return null
  return { ...firingStatusBadge(last.status), detail: last.reason }
}

export type DeliveryLine = {
  channel: string
  /** 'ok' and 'failed' come from the channel's own result; 'stated' is a
   * fact core recorded that is neither (no connected device to notify). */
  verdict: 'ok' | 'failed' | 'stated'
  text: string
}

/**
 * Per-channel delivery lines for one firing, from the firing's `delivery`
 * ({"chat": {ok, reason?}, "devices": [{name, ok, reason?}], "note"?}).
 * Each channel is stated on its own — chat ok; device X ok; device Y offline
 * — because "delivered" is only true per channel, from that channel's own
 * result. A reminder that found no connected device carries an empty devices
 * list and a note: that is a stated fact, shown as one, not a failure. A
 * job's `{}` yields no lines at all.
 */
export function deliveryLines(delivery: TimerDelivery | null | undefined): DeliveryLine[] {
  const lines: DeliveryLine[] = []
  if (!delivery) return lines
  if (delivery.chat) {
    lines.push(
      delivery.chat.ok
        ? { channel: 'chat', verdict: 'ok', text: 'chat: delivered' }
        : {
            channel: 'chat',
            verdict: 'failed',
            text: `chat: failed${delivery.chat.reason ? ` — ${delivery.chat.reason}` : ''}`,
          },
    )
  }
  if (Array.isArray(delivery.devices)) {
    for (const device of delivery.devices) {
      lines.push(
        device.ok
          ? { channel: device.name, verdict: 'ok', text: `device ${device.name}: delivered` }
          : {
              channel: device.name,
              verdict: 'failed',
              text: `device ${device.name}: ${device.reason ?? 'failed'}`,
            },
      )
    }
  }
  if (delivery.note) lines.push({ channel: 'devices', verdict: 'stated', text: delivery.note })
  return lines
}

/**
 * What a firing of this timer does, from its payload — his reminder words
 * verbatim and where they go, the scheduled instruction, or the job's
 * handler name. null when the payload lacks the field its kind promises,
 * rather than an empty string standing in for words.
 */
export function payloadSummary(timer: Pick<Timer, 'kind' | 'payload'>): string | null {
  const payload = timer.payload ?? {}
  if (timer.kind === 'reminder') {
    const message = payload.message
    if (typeof message !== 'string' || message === '') return null
    const device = payload.device
    const target =
      typeof device === 'string' && device !== ''
        ? `to chat and device ${device}`
        : 'to chat and every connected device'
    return `“${message}” — ${target}`
  }
  if (timer.kind === 'scheduled') {
    const instruction = payload.instruction
    return typeof instruction === 'string' && instruction !== '' ? instruction : null
  }
  if (timer.kind === 'job') {
    const handler = payload.handler
    return typeof handler === 'string' && handler !== '' ? `handler: ${handler}` : null
  }
  return null
}

/** How long a firing ran, or null while it is still running (ended_at
 * NULL) — never a fake 0 for an open firing. */
export function firingDurationMs(firing: Pick<TimerFiring, 'started_at' | 'ended_at'>): number | null {
  if (firing.ended_at === null) return null
  const ms = new Date(firing.ended_at).getTime() - new Date(firing.started_at).getTime()
  return Number.isFinite(ms) ? Math.max(0, ms) : null
}
