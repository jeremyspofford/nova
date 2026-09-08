import { describe, it, expect } from 'vitest'
import {
  actedLine,
  deliveryVerdicts,
  factLines,
  livePill,
  muteWords,
  readWords,
  sightingsWords,
  stateBadge,
} from './inboxFormat'

describe('stateBadge — whether he was told, in plain words', () => {
  it('maps the five states core can store', () => {
    expect(stateBadge('raised')).toEqual({ label: 'not told yet', color: 'neutral' })
    expect(stateBadge('delivered')).toEqual({ label: 'told you', color: 'success' })
    expect(stateBadge('failed')).toEqual({ label: 'not delivered', color: 'danger' })
    expect(stateBadge('seen')).toEqual({ label: 'read', color: 'neutral' })
    expect(stateBadge('muted')).toEqual({ label: 'muted', color: 'warning' })
  })

  it('shows a state it has not met verbatim rather than relabelling it', () => {
    expect(stateBadge('future')).toEqual({ label: 'future', color: 'neutral' })
  })
})

describe('livePill — the condition, not the news', () => {
  it('a NULL cleared_at is a condition still true', () => {
    const pill = livePill({ cleared_at: null })
    expect(pill.live).toBe(true)
    expect(pill.label).toBe('still true')
    expect(pill.color).toBe('warning')
  })

  it('a cleared row says a check that RAN stopped finding the facts', () => {
    const pill = livePill({ cleared_at: '2026-09-08T09:00:00Z' })
    expect(pill.live).toBe(false)
    expect(pill.label).toBe('cleared')
    expect(pill.color).toBe('success')
    expect(pill.title).toContain('a check that ran')
  })
})

describe('deliveryVerdicts — the Schedules page\'s three verdicts, reused', () => {
  it('renders a receipt exactly as the firing renderer does', () => {
    expect(
      deliveryVerdicts({
        delivery: { chat: { ok: true }, devices: [{ name: 'phone', ok: true }] },
        state: 'delivered',
        failed_reason: null,
      }),
    ).toEqual([
      { channel: 'chat', verdict: 'ok', text: 'chat: delivered' },
      { channel: 'phone', verdict: 'ok', text: 'device phone: delivered' },
    ])
  })

  it('a failed row always says WHY, even when no rung got as far as reporting', () => {
    expect(
      deliveryVerdicts({
        delivery: {},
        state: 'failed',
        failed_reason: 'there is no person on this delivery',
      }),
    ).toEqual([
      { channel: 'delivery', verdict: 'failed', text: 'there is no person on this delivery' },
    ])
  })

  it('does not repeat the reason a rung already stated', () => {
    const lines = deliveryVerdicts({
      delivery: { chat: { ok: false, reason: 'conversation gone' } },
      state: 'failed',
      failed_reason: 'conversation gone',
    })
    expect(lines).toEqual([
      { channel: 'chat', verdict: 'failed', text: 'chat: failed — conversation gone' },
    ])
  })

  it('an empty receipt on a row nobody has tried to deliver yields NO lines — the page states that absence', () => {
    expect(deliveryVerdicts({ delivery: {}, state: 'raised', failed_reason: null })).toEqual([])
  })
})

describe('actedLine — what she did, and the trace that backs it', () => {
  it('is null when she did not act', () => {
    expect(actedLine({ acted: false, acted_note: null, acted_turn_id: null })).toBeNull()
  })

  it('carries her note and the turn that is the account of it', () => {
    expect(
      actedLine({ acted: true, acted_note: 'restarted the gateway', acted_turn_id: 'turn-1' }),
    ).toEqual({ text: 'restarted the gateway', turnId: 'turn-1' })
  })

  it('says the gap when a row claims she acted but carries no words', () => {
    const line = actedLine({ acted: true, acted_note: '   ', acted_turn_id: 'turn-1' })
    expect(line!.text).toContain('left no words')
    expect(line!.turnId).toBe('turn-1')
  })

  it('names no turn when the row names none, so no link is rendered for one', () => {
    expect(actedLine({ acted: true, acted_note: 'did a thing', acted_turn_id: null })!.turnId)
      .toBeNull()
  })
})

describe('sightingsWords — a sighting count, never a delivery count', () => {
  it('says nothing for a finding seen once', () => {
    expect(sightingsWords(1)).toBeNull()
    expect(sightingsWords(0)).toBeNull()
  })

  it('counts repeats above one', () => {
    expect(sightingsWords(2)).toBe('seen 2 times by the checks')
    expect(sightingsWords(37)).toBe('seen 37 times by the checks')
  })
})

describe('muteWords and readWords — a noise preference and a read receipt, and nothing else', () => {
  it('a muted row offers to unmute; anything else offers to mute', () => {
    expect(muteWords({ state: 'muted' })).toMatchObject({ muted: true, label: 'Unmute', next: false })
    expect(muteWords({ state: 'raised' })).toMatchObject({ muted: false, label: 'Mute', next: true })
    expect(muteWords({ state: 'seen' })).toMatchObject({ muted: false, next: true })
  })

  // The words are the mechanism here: this page has no approve and no deny,
  // and the button that silences says in its own title what it is.
  it('neither button\'s words claim to permit or forbid anything', () => {
    expect(muteWords({ state: 'raised' }).title).toContain('never permission')
    expect(readWords({ seen_at: null }).title).toContain('permits nothing and forbids nothing')
    expect(muteWords({ state: 'raised' }).title).not.toMatch(/approve|allow|deny/i)
    expect(readWords({ seen_at: null }).label).toBe('Mark seen')
  })

  it('read is the timestamp, not the state — a failed delivery he opened is still read', () => {
    expect(readWords({ seen_at: '2026-09-08T10:00:00Z' })).toMatchObject({ read: true, label: 'Seen' })
  })
})

describe('factLines — the evidence the fingerprint was computed from', () => {
  it('keeps core\'s order and shows non-strings as their JSON', () => {
    expect(factLines({ service: 'gateway', reachable: false, tries: 3 })).toEqual([
      { key: 'service', value: 'gateway' },
      { key: 'reachable', value: 'false' },
      { key: 'tries', value: '3' },
    ])
  })

  it('an empty facts object yields no lines', () => {
    expect(factLines({})).toEqual([])
  })
})
