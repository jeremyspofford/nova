/**
 * Timezone facts this browser can state on its own: which zone it is in,
 * which zones exist, and what time it is right now in any of them. Shared by
 * the onboarding Timezone step and Settings → General so the two surfaces
 * cannot disagree about what a zone is called or what time it is there.
 *
 * Everything reads the engine's own Intl data — no zone list is maintained
 * here beyond a short fallback for an engine without `supportedValuesOf`
 * (ES2022; this project compiles against ES2020, hence the guarded access).
 * The server (core's settings registry) is the one that decides whether a
 * name is a real IANA zone; nothing here pre-empts that refusal.
 */
import { useEffect, useState } from 'react'

/** The instance-wide setting key. Core's default ("UTC") counts as unset. */
export const TIMEZONE_SETTING = 'nova.timezone'

/** For an engine that cannot enumerate zones: enough to reach every populated
 * continent plus UTC. The detected zone is always added on top. */
export const FALLBACK_ZONES: readonly string[] = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

/** The zone this browser reports, or null when it reports none. */
export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone ? zone : null
  } catch {
    return null
  }
}

/**
 * Every zone worth offering, sorted. `include` are zones that must be
 * pickable whatever the engine enumerates — the detected zone (it can be an
 * alias the list does not carry) and a stored value. Plain "UTC" is always
 * present: V8's list only carries the Etc/ spellings.
 */
export function timeZoneChoices(include: Array<string | null | undefined> = []): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  let zones: string[] = []
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      zones = intl.supportedValuesOf('timeZone')
    } catch {
      zones = []
    }
  }
  if (zones.length === 0) zones = [...FALLBACK_ZONES]
  const set = new Set(zones)
  set.add('UTC')
  for (const zone of include) if (zone) set.add(zone)
  return Array.from(set).sort()
}

/**
 * The wall-clock time in `zone` at `now`, or null when this engine does not
 * know the zone — the caller states that, rather than showing a time
 * computed somewhere else. `locale` is for tests; production uses the
 * browser's.
 */
export function formatNowIn(zone: string, now: Date = new Date(), locale?: string): string | null {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      hourCycle: 'h23',
    }).format(now)
  } catch {
    return null
  }
}

/** A Date that re-renders its component every `intervalMs`, so a clock
 * shown for a zone actually moves. */
export function useClock(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
