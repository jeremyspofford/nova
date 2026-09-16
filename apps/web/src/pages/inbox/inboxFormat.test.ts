import { describe, it, expect } from 'vitest'
import {
  actedLine,
  deliveryVerdicts,
  factLines,
  draftWords,
  subjectLink,
  silenceWords,
  talkWords,
  SUBJECT_ROUTES,
  UNLINKED_SUBJECTS,
  livePill,
  muteWords,
  readWords,
  sightingsWords,
  stateBadge,
} from './inboxFormat'

describe('stateBadge — whether he was told, in plain words', () => {
  it('maps the four states core can store', () => {
    expect(stateBadge('raised')).toEqual({ label: 'not told yet', color: 'neutral' })
    expect(stateBadge('delivered')).toEqual({ label: 'told you', color: 'success' })
    expect(stateBadge('failed')).toEqual({ label: 'not delivered', color: 'danger' })
    expect(stateBadge('muted')).toEqual({ label: 'muted', color: 'warning' })
  })

  // S25.1.3 removed `seen` from core's state machine — a read receipt is a
  // timestamp, and as a state it silently also meant "dropped from the
  // digest". If core ever sent one again this badge would say so verbatim
  // rather than quietly relabelling it, which is the same rule as below.
  it('has no `seen` state to map, and would not invent a label for one', () => {
    expect(stateBadge('seen')).toEqual({ label: 'seen', color: 'neutral' })
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
    expect(muteWords({ silenced: true })).toMatchObject({ muted: true, label: 'Unmute', next: false })
    expect(muteWords({ silenced: false })).toMatchObject({ muted: false, label: 'Mute', next: true })
  })

  // The words are the mechanism here: this page has no approve and no deny,
  // and the button that silences says in its own title what it is.
  it('neither button\'s words claim to permit or forbid anything', () => {
    expect(muteWords({ silenced: false }).title).toContain('never permission')
    expect(readWords({ seen_at: null }).title).toContain('permits nothing and forbids nothing')
    expect(muteWords({ silenced: false }).title).not.toMatch(/approve|allow|deny/i)
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

describe('factLines — the moving half of a card (S25.2.1)', () => {
  const NOW = new Date('2026-09-14T12:00:00Z')

  it('renders an instant relative to now, keeping the exact time behind it', () => {
    const [line] = factLines({ paused_at: '2026-09-11T14:35:29+00:00' }, NOW)
    // The card's SENTENCE cannot say this — it is composed once and frozen —
    // so the version that keeps up with the calendar lives here.
    expect(line).toEqual({ key: 'paused_at', value: '3d ago', title: '2026-09-11T14:35:29+00:00' })
  })

  it('leaves a plain day and a month alone', () => {
    // Already the answer to "which day". "3 days ago" would be a worse
    // version of a fact that is not moving.
    expect(factLines({ day: '2026-09-11', month: '2026-09' }, NOW)).toEqual([
      { key: 'day', value: '2026-09-11' },
      { key: 'month', value: '2026-09' },
    ])
  })

  it('shows a timestamp it cannot parse verbatim rather than inventing one', () => {
    expect(factLines({ at: '2026-09-31T99:99:99Z' }, NOW)).toEqual([
      { key: 'at', value: '2026-09-31T99:99:99Z' },
    ])
  })

  it('still renders non-strings as their JSON', () => {
    expect(factLines({ failures: 3, ok: false }, NOW)).toEqual([
      { key: 'failures', value: '3' },
      { key: 'ok', value: 'false' },
    ])
  })
})

describe('subjectLink — a fact you can follow (S25.2.2)', () => {
  it('routes a known subject by the FACT key, not by which check emitted it', () => {
    // Keyed on the fact, so a check family added next month links its timer
    // the day it lands with no edit to the registry.
    expect(subjectLink('timer_id', '0b39fae3')).toBe('/schedules?timer=0b39fae3')
    expect(subjectLink('turn_id', 'abc-123')).toBe('/activity?turn=abc-123')
    expect(subjectLink('agent', 'coder')).toBe('/agents/coder')
  })

  it('escapes the value rather than pasting it into a URL', () => {
    expect(subjectLink('agent', 'a coder/2')).toBe('/agents/a%20coder%2F2')
  })

  it('is null for a subject with nowhere to go, and for an empty value', () => {
    expect(subjectLink('kind', 'scheduled')).toBeNull()
    // Deliberately unlinked, with its reason recorded beside it.
    expect(subjectLink('span_id', 'sp-1')).toBeNull()
    expect(UNLINKED_SUBJECTS.span_id).toContain('turn')
    // A route built from nothing lands on a page that cannot find what it
    // was asked for, which is worse than plain text.
    expect(subjectLink('timer_id', '   ')).toBeNull()
    expect(subjectLink('timer_id', 42)).toBeNull()
  })

  it('never lists a subject as both linked and deliberately unlinked', () => {
    const both = Object.keys(SUBJECT_ROUTES).filter(k => k in UNLINKED_SUBJECTS)
    expect(both).toEqual([])
  })
})

describe('silenceWords and talkWords — whose silence, and whether there is a room', () => {
  it('names WHO silenced it, because hers and his are different facts', () => {
    expect(silenceWords({ silenced: true, muted_by: null })).toEqual({
      text: 'Nova silenced this — it is not being reported to you',
      mine: false,
    })
    expect(silenceWords({ silenced: true, muted_by: 'p1' })).toMatchObject({ mine: true })
    // Nothing to say when nothing is silenced — including on a cleared row
    // that still carries the `muted_at` stamp of a silence that is over.
    expect(silenceWords({ silenced: false, muted_by: null })).toBeNull()
  })

  it('says what has not happened, never what he may not do', () => {
    const none = talkWords({ delivered_message_id: null })
    expect(none.can).toBe(false)
    // The one place a disabled control is honest: the reason is about the
    // world, so it names the thing that has not happened yet.
    expect(none.title).toContain('no message to talk under')
    expect(none.title).not.toMatch(/cannot|not allowed|permission|denied/i)

    expect(talkWords({ delivered_message_id: 'm1' })).toMatchObject({ can: true })
  })
})

describe('draftWords — a skill from a notice, derived (S25.2.5)', () => {
  it('offers the draft on any notice carrying steps, whatever check wrote it', () => {
    // The backend composes a draft by reading `facts.steps`, so this is the
    // same condition it would accept — a new check emitting steps gets the
    // button the day it lands, with no edit here.
    const words = draftWords({ facts: { steps: ['list_timers', 'cancel_timer'] } })
    expect(words).toMatchObject({ can: true })
    expect(words!.title).toContain('2 steps')
  })

  it('offers nothing when there is no procedure to write down', () => {
    expect(draftWords({ facts: { service: 'gateway' } })).toBeNull()
    expect(draftWords({ facts: { steps: [] } })).toBeNull()
    // Steps that are not sentences are not steps: the backend refuses these
    // too, and a button that leads to a stated refusal is worse than none.
    expect(draftWords({ facts: { steps: [1, 2] } })).toBeNull()
    expect(draftWords({ facts: {} })).toBeNull()
  })
})
