import { describe, it, expect } from 'vitest'
import { FALLBACK_ZONES, browserTimeZone, formatNowIn, timeZoneChoices } from './timezone'

const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }

/** Runs `fn` with Intl.supportedValuesOf removed, the way an older engine
 * presents, then puts it back whatever happened. */
function withoutSupportedValuesOf<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf')
  Object.defineProperty(Intl, 'supportedValuesOf', { value: undefined, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    if (original) Object.defineProperty(Intl, 'supportedValuesOf', original)
    else delete intl.supportedValuesOf
  }
}

describe('timeZoneChoices', () => {
  it('offers the engine list plus plain UTC, sorted', () => {
    const zones = timeZoneChoices()
    expect(zones).toContain('UTC')
    expect(zones).toContain('America/New_York')
    expect(zones).toContain('Asia/Tokyo')
    expect(zones.length).toBeGreaterThan(FALLBACK_ZONES.length)
    expect(zones).toEqual([...zones].sort())
    expect(new Set(zones).size).toBe(zones.length)
  })

  it('keeps a detected or stored zone pickable even when the engine does not list it', () => {
    // An alias the canonical list omits, and a stored value from another
    // machine: neither may vanish from the picker.
    const zones = timeZoneChoices(['Asia/Calcutta', 'Etc/GMT+3', null, undefined, ''])
    expect(zones).toContain('Asia/Calcutta')
    expect(zones).toContain('Etc/GMT+3')
    expect(zones).not.toContain('')
  })

  it('falls back to a short list that still holds the detected zone and UTC', () => {
    const zones = withoutSupportedValuesOf(() => timeZoneChoices(['Antarctica/Troll']))
    expect(zones).toContain('UTC')
    expect(zones).toContain('Antarctica/Troll')
    for (const zone of FALLBACK_ZONES) expect(zones).toContain(zone)
    expect(zones.length).toBe(FALLBACK_ZONES.length + 1)
  })
})

describe('browserTimeZone', () => {
  it('reports the zone this engine resolves', () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})

describe('formatNowIn', () => {
  const instant = new Date('2026-09-06T09:00:00Z')

  it('renders the same instant as a different wall time in a different zone', () => {
    expect(formatNowIn('UTC', instant, 'en-US')).toBe('Sun, Sep 6, 2026, 09:00:00 UTC')
    expect(formatNowIn('Asia/Tokyo', instant, 'en-US')).toBe('Sun, Sep 6, 2026, 18:00:00 GMT+9')
    expect(formatNowIn('America/New_York', instant, 'en-US')).toBe('Sun, Sep 6, 2026, 05:00:00 EDT')
  })

  it('returns null for a zone the engine does not know, never a time computed elsewhere', () => {
    expect(formatNowIn('Mars/Olympus', instant, 'en-US')).toBeNull()
    expect(formatNowIn('', instant, 'en-US')).toBeNull()
  })
})
