import type { EventSender } from '../../lib/api'
import { formatStamp } from '../../lib/humanText'

/**
 * How Settings → Events and Routing say a sender (S37c). The owner said on
 * 2026-10-13 that Schedules, Inbox and Activity read like a database: these
 * are the words a person reads instead of a kind, a role key or a timestamp.
 */

/** The two built-ins, by the name core seeds them under. A sender of his is
 * called by the name he gave it. */
const BUILT_IN_TITLES: Record<string, string> = {
  monitor: 'Monitoring',
  github_ci: 'GitHub CI',
}

/** What each built-in sends, in a sentence. */
const BUILT_IN_ABOUT: Record<string, string> = {
  monitor:
    'Built in. Her own checks send this when part of Nova goes down, a timer keeps failing, or a model runs slowly; she looks at once.',
  github_ci:
    'Built in. Reads the CI runs of the repos below every 5 minutes; a run that turns red starts her look.',
}

/** A sender that takes no calls — core's own kinds for the two built-ins.
 *  Any other kind is a program with its own key. */
export function isBuiltIn(sender: Pick<EventSender, 'kind'>): boolean {
  return sender.kind !== 'token'
}

export function senderTitle(sender: Pick<EventSender, 'name'>): string {
  return BUILT_IN_TITLES[sender.name] ?? sender.name
}

/** A sender's title from its routing role (`event_<name>`), or null for a
 *  role that is not a sender's. */
export function eventRoleSender(role: string): string | null {
  return role.startsWith('event_') && role.length > 'event_'.length ? role.slice('event_'.length) : null
}

export function senderAbout(sender: Pick<EventSender, 'name' | 'kind'>): string {
  if (isBuiltIn(sender)) {
    return BUILT_IN_ABOUT[sender.name] ?? 'Built in.'
  }
  return 'A program that sends with its own key; what it sends, she reads as data, never as orders.'
}

export function addedByWords(addedBy: string | null): string | null {
  if (addedBy === 'owner') return 'added by you'
  if (addedBy === 'nova') return 'added by Nova'
  return null
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

/** "last sent 5 minutes ago": whole words, never "5m", and the day once it
 *  is older than a week. A value that is not a time is said so, not guessed. */
export function sentWords(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'has not sent anything yet'
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'last sent at an unreadable time'
  const sec = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
  if (sec < MINUTE) return 'last sent just now'
  if (sec < HOUR) return `last sent ${count(Math.floor(sec / MINUTE), 'minute')}`
  if (sec < DAY) return `last sent ${count(Math.floor(sec / HOUR), 'hour')}`
  if (sec < WEEK) return `last sent ${count(Math.floor(sec / DAY), 'day')}`
  // The date alone ("1 Sep"): formatStamp of a day, in local time.
  const day = `${then.getFullYear()}-${String(then.getMonth() + 1).padStart(2, '0')}-${String(then.getDate()).padStart(2, '0')}`
  return `last sent on ${formatStamp(day, now)}`
}
