import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSseParser, type StreamEvent } from '../../lib/streamChat'
import { chatReducer, emptyChat, type ChatRow, type ChatState } from './chatReducer'

/**
 * What streams live is what core keeps (said-not-done fix rounds 4 and 5).
 *
 * Once this client showed correction frames (fix round 3, T6), the owner could
 * read a line live that core never stored: a redirect whose own call ran but
 * whose report failed streamed "[I said I'd check but did not …]" and stored
 * "[I ran device_info but could not report the result …]" (R6), two stored
 * backend lines arrived in the wrong order (P2), and a redirect's note said
 * "Doing that now…" beside a regeneration that did nothing (P6). This is the
 * client's half of that contract, read from the streams core really produced
 * for these turns and the replies it stored —
 * services/core/tests/fixtures/live_stored_frames.json, written and checked by
 * core's suite (test_chat_said_not_done.py) — through this client's own parser
 * and reducer:
 *
 *   - an "append" turn shows, live, exactly the stored reply;
 *   - a "replace" turn (a bare-intent or consent correction drops the prose she
 *     streamed) shows that streamed prose above EXACTLY the stored text, which
 *     a reload then shows alone;
 *   - a "redirect" turn (a REPLACE-class redirect whose regeneration stood)
 *     shows her streamed prose, the redirect's note, then exactly the stored
 *     reply — and that note, the one live line a reload never shows, claims
 *     work only when a call REACHED a tool's executor (`dispatched`, core's
 *     record — see aCallStarted for why the stream cannot say it).
 */

type Turn = {
  class: 'append' | 'replace' | 'redirect'
  raw: string
  stored: string
  streamed?: string
  note?: string
  dispatched?: boolean
  note_claims_work?: boolean
}

// Read where core writes it (npm test runs from apps/web): a copy here would be
// the drift this test exists to catch.
const turns = JSON.parse(
  readFileSync('../../services/core/tests/fixtures/live_stored_frames.json', 'utf8'),
) as Record<string, Turn>

function shownLive(raw: string): { text: string; errors: ChatRow[]; events: StreamEvent[] } {
  const parser = createSseParser()
  const events: StreamEvent[] = [...parser.push(raw), ...parser.flush()]
  let state: ChatState = chatReducer(emptyChat(), {
    type: 'send',
    userId: 'u1',
    assistantId: 'a1',
    text: 'go',
  })
  for (const event of events) state = chatReducer(state, { type: 'event', event })
  const assistant = state.rows.find(
    (r): r is Extract<ChatRow, { kind: 'message' }> => r.kind === 'message' && r.id === 'a1',
  )
  return {
    text: assistant?.text ?? '',
    errors: state.rows.filter(r => r.kind === 'error'),
    events,
  }
}

/**
 * Whether the stream shows a call STARTED — which is not whether one ran.
 *
 * A call core refuses before any executor — written as text, or naming no
 * registered tool — is framed `activity: start` all the same, and the refusal
 * then ends in `activity: error` exactly as an executor's own failure does:
 * only the reason's words differ, and words are not a record. So nothing in
 * the stream tells a refused call from one that ran (said-not-done P6, at the
 * cap). Whether a call REACHED a tool's executor is pinned on core's side, from
 * the spans it files (`reached_executor`), and carried here as `dispatched`;
 * this checks only what the stream can show — a call that ran was started.
 */
function aCallStarted(events: StreamEvent[]): boolean {
  return events.some(e => e.type === 'activity' && e.status === 'start')
}

describe('what streams live is what core stores', () => {
  it('reads every turn core captured, of every class', () => {
    const names = Object.keys(turns)
    expect(names.length).toBeGreaterThanOrEqual(18)
    for (const name of [
      'offer_ran_report_failed',
      'bare_intent_ran_report_failed',
      'consent_markup_and_unverified_listing',
      'offer_redirect_ran',
      'offer_redirect_no_call',
      'consent_redirect_ran',
      'consent_redirect_no_call',
      'consent_redirect_markup_refused',
      'listing_redirect_ran',
      'listing_redirect_no_call',
    ]) {
      expect(names).toContain(name)
    }
    expect(new Set(names.map(name => turns[name].class))).toEqual(
      new Set(['append', 'replace', 'redirect']),
    )
  })

  for (const [name, turn] of Object.entries(turns)) {
    it(name, () => {
      const live = shownLive(turn.raw)
      expect(live.errors).toEqual([])
      if (turn.class === 'append') {
        expect(live.text).toBe(turn.stored)
      } else if (turn.class === 'replace') {
        expect(turn.streamed).toBeTruthy()
        expect(live.text).toBe(`${turn.streamed}\n\n${turn.stored}`)
      } else {
        expect(turn.streamed).toBeTruthy()
        expect(turn.note).toBeTruthy()
        expect(live.text).toBe(`${turn.streamed}\n\n${turn.note}\n\n${turn.stored}`)
        // Live vs truth: the note shown live claims work exactly when a call
        // reached a tool's executor (core's record), and the stream agrees
        // wherever it can — a call that ran was framed as started.
        expect(typeof turn.dispatched).toBe('boolean')
        expect(turn.note_claims_work).toBe(turn.dispatched)
        if (turn.dispatched) expect(aCallStarted(live.events)).toBe(true)
      }
    })
  }

  it('a call refused before any executor is framed as started too, so core keeps the record', () => {
    // The regeneration wrote its call as text: refused, never run. The stream
    // still starts it, and the note must not claim work.
    const turn = turns.consent_redirect_markup_refused
    expect(turn.class).toBe('redirect')
    expect(aCallStarted(shownLive(turn.raw).events)).toBe(true)
    expect(turn.dispatched).toBe(false)
    expect(turn.note_claims_work).toBe(false)
  })
})
