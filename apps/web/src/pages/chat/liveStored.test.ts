import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSseParser, type StreamEvent } from '../../lib/streamChat'
import { chatReducer, emptyChat, type ChatRow, type ChatState } from './chatReducer'

/**
 * What streams live is what core keeps (said-not-done fix round 4, R6).
 *
 * Once this client showed correction frames (fix round 3, T6), the owner could
 * read a line live that core never stored: a redirect whose own call ran but
 * whose report failed streamed "[I said I'd check but did not …]" and stored
 * "[I ran device_info but could not report the result …]". Core now streams
 * exactly what it stores. This is the client's half of that contract, read
 * from the streams core really produced for these turns and the replies it
 * stored — services/core/tests/fixtures/live_stored_frames.json, written and
 * checked by core's suite (test_chat_said_not_done.py, "R6") — through this
 * client's own parser and reducer:
 *
 *   - an "append" turn shows, live, exactly the stored reply;
 *   - a "replace" turn (the bare-intent redirect drops the "Checking…" she
 *     streamed) shows that streamed prose above EXACTLY the stored text,
 *     which a reload then shows alone.
 */

type Turn = { class: 'append' | 'replace'; raw: string; stored: string; streamed?: string }

// Read where core writes it (npm test runs from apps/web): a copy here would be
// the drift this test exists to catch.
const turns = JSON.parse(
  readFileSync('../../services/core/tests/fixtures/live_stored_frames.json', 'utf8'),
) as Record<string, Turn>

function shownLive(raw: string): { text: string; errors: ChatRow[] } {
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
  return { text: assistant?.text ?? '', errors: state.rows.filter(r => r.kind === 'error') }
}

describe('what streams live is what core stores (R6)', () => {
  it('reads every turn core captured, of both classes', () => {
    const names = Object.keys(turns)
    expect(names.length).toBeGreaterThanOrEqual(8)
    expect(names).toContain('offer_ran_report_failed')
    expect(names).toContain('bare_intent_ran_report_failed')
    expect(new Set(names.map(name => turns[name].class))).toEqual(new Set(['append', 'replace']))
  })

  for (const [name, turn] of Object.entries(turns)) {
    it(name, () => {
      const live = shownLive(turn.raw)
      expect(live.errors).toEqual([])
      if (turn.class === 'append') {
        expect(live.text).toBe(turn.stored)
      } else {
        expect(turn.streamed).toBeTruthy()
        expect(live.text).toBe(`${turn.streamed}\n\n${turn.stored}`)
      }
    })
  }
})
