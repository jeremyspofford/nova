/**
 * The one SSE client for POST /api/v1/chat/stream.
 *
 * Core's frame contract, each line `data: <json>`:
 *   {"meta":{conversation_id,model,turn_id}}   exactly once, first
 *   {"t":"<delta>"}                            zero or more
 *   {"error":"<stated reason>"}                at most one, on failure
 *   [DONE]                                     always last
 *
 * EventSource cannot POST, so this is fetch + a ReadableStream reader. The
 * parser is separated from the transport so the ugly parts — a frame split
 * across two TCP chunks, several frames in one chunk, a proxy's HTML error
 * page arriving instead of a frame — are unit-testable without a socket.
 *
 * Nothing here ever invents a success. An unparseable line becomes an error
 * event, and a stream that stops without saying [DONE] becomes an
 * `interrupted` event, so the UI can keep the partial text and still say
 * plainly that the turn did not finish.
 *
 * Forward-compat: a well-formed JSON frame whose keys are ALL outside
 * {t, error, meta, activity} is a future frame type, not a broken one, and
 * is silently ignored — this lets the server start sending a new frame
 * shape later without breaking a client built before that frame type
 * existed. Malformed/non-JSON lines, and a KNOWN key with the wrong shape,
 * still remain error events: the allowance only ever widens what counts as
 * "not part of the contract yet", never what counts as broken.
 * (Ruling S2-R6, amending S1's R20.)
 *
 * `activity` (S2 task 2/3) is exactly the frame type that comment used to
 * gesture at as a hypothetical: `{"activity":{"tool":"<name>","status":
 * "start"|"ok"|"error"}}`, sent once per tool call while a round's tools
 * run. It graduates from "unknown, tolerated" to "known, understood" here.
 *
 * `consent` (S3-T2) is the same graduation for the policy kernel's approval
 * cards: `{"consent": <card_spec>}`, sent once per card the funnel raises
 * this turn (services/core/app/consents.py's card_spec, services/core/app/
 * chat.py's consent_sink diff). The card is carried verbatim — this parser
 * only checks that the three fields every consumer needs (consent_id,
 * action_class, summary) are actually strings, the same "known key, wrong
 * shape is still an error" stance `activity` takes above.
 */

import type { ConsentCard } from './consentCard'
import { createLineBuffer } from './lineBuffer'
import { statedReason } from './statedReason'

export type StreamEvent =
  | { type: 'meta'; conversationId: string; model: string; turnId: string }
  | { type: 'delta'; text: string }
  // status is whatever the server actually sent (chat.py only ever sends
  // start/ok/error) — kept as `string` rather than a narrower literal
  // union so a status this client has not seen yet is still a real event,
  // not a type error waiting to happen.
  | { type: 'activity'; tool: string; status: string }
  | { type: 'consent'; card: ConsentCard }
  | { type: 'error'; reason: string }
  | { type: 'done' }
  | { type: 'interrupted'; reason: string }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const MAX_QUOTED = 200

function quote(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_QUOTED ? `${trimmed.slice(0, MAX_QUOTED)}…` : trimmed
}

export function failureReason(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

// The frame keys this client understands at all. A well-formed JSON object
// whose keys are ALL outside this set is a future frame type the server may
// start sending later — silently ignored so an older client does not break
// the moment a newer server introduces one. A key IN this set with the
// wrong shape (caught below, before this check ever runs) is still a
// contract violation and still an error. (Ruling S2-R6, amending S1's R20.)
const KNOWN_FRAME_KEYS = new Set(['t', 'error', 'meta', 'activity', 'consent'])

function frameToEvent(payload: string): StreamEvent | null {
  if (payload === '[DONE]') return { type: 'done' }

  let data: unknown
  try {
    data = JSON.parse(payload)
  } catch {
    return { type: 'error', reason: `unreadable frame from the server: ${quote(payload)}` }
  }
  if (data === null || typeof data !== 'object') {
    return { type: 'error', reason: `unexpected frame from the server: ${quote(payload)}` }
  }

  const obj = data as Record<string, unknown>
  if (typeof obj.t === 'string') return { type: 'delta', text: obj.t }
  if (typeof obj.error === 'string') return { type: 'error', reason: obj.error }
  if (obj.meta !== null && typeof obj.meta === 'object') {
    const meta = obj.meta as Record<string, unknown>
    return {
      type: 'meta',
      conversationId: String(meta.conversation_id ?? ''),
      model: String(meta.model ?? ''),
      turnId: String(meta.turn_id ?? ''),
    }
  }
  if (obj.activity !== null && typeof obj.activity === 'object') {
    const activity = obj.activity as Record<string, unknown>
    if (typeof activity.tool === 'string' && typeof activity.status === 'string') {
      return { type: 'activity', tool: activity.tool, status: activity.status }
    }
    // Falls through to the generic "known key, wrong shape" refusal below
    // rather than being treated as an unknown frame — `activity` IS known,
    // it just did not carry the two fields it promises.
  }
  if (obj.consent !== null && typeof obj.consent === 'object') {
    const card = obj.consent as Record<string, unknown>
    if (
      typeof card.consent_id === 'string' &&
      typeof card.action_class === 'string' &&
      typeof card.summary === 'string'
    ) {
      return { type: 'consent', card: card as unknown as ConsentCard }
    }
    // Same stance as `activity` above: a known key with the wrong shape is
    // a contract violation, not an unknown frame — falls through below.
  }
  if (!Object.keys(obj).some(key => KNOWN_FRAME_KEYS.has(key))) {
    // Every key here is one this client has never heard of — a future frame
    // type, silently ignored rather than treated as broken.
    return null
  }
  // A known key with the wrong shape (e.g. {"meta": "not an object"}) is a
  // genuine contract violation, not an unknown frame type. Saying so is
  // louder than dropping it, and the contract is pinned on both sides.
  return { type: 'error', reason: `unrecognised frame from the server: ${quote(payload)}` }
}

function lineToEvents(line: string): StreamEvent[] {
  if (line.trim() === '') return []
  // SSE comment — proxies use these as keep-alives.
  if (line.startsWith(':')) return []
  if (line.startsWith('data:')) {
    const event = frameToEvent(line.slice('data:'.length).trim())
    return event === null ? [] : [event]
  }
  return [{ type: 'error', reason: `unexpected line from the server: ${quote(line)}` }]
}

export interface SseParser {
  /** Events completed by this chunk. An unfinished tail is held for the next. */
  push(chunk: string): StreamEvent[]
  /** Whatever is left when the stream ends — a frame with no trailing newline. */
  flush(): StreamEvent[]
}

export function createSseParser(): SseParser {
  // Chunk reassembly is shared with the model pull — see lib/lineBuffer.ts.
  // Only the interpretation of a finished line is SSE-specific.
  const lines = createLineBuffer()
  return {
    push: (chunk: string) => lines.push(chunk).flatMap(lineToEvents),
    flush: () => lines.flush().flatMap(lineToEvents),
  }
}

async function statedRefusal(response: Response): Promise<string> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    /* an unreadable body still leaves us the status */
  }
  if (!body) return `the server refused the turn (${response.status})`
  return `the server refused the turn (${response.status}): ${quote(statedReason(body, response.status))}`
}

export interface StreamChatOptions {
  message: string
  conversationId?: string | null
  /**
   * The consent_id this message RESUMES — set only by the continuation the
   * chat store sends after an approve. Core verifies it against the consents
   * table and, when it names a real card, records the message as PLUMBING, so
   * later turns never read the approval choreography back to the model
   * (migration 014). Nothing visible changes: the row still shows in the
   * transcript, and this turn still receives the message.
   */
  continuationOf?: string | null
  signal?: AbortSignal
}

export async function* streamChat(
  { message, conversationId, continuationOf, signal }: StreamChatOptions,
  fetchImpl: FetchLike = ((url, init) => fetch(url, init)) as FetchLike,
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = { message }
  if (conversationId) body.conversation_id = conversationId
  if (continuationOf) body.continuation_of = continuationOf

  let response: Response
  try {
    response = await fetchImpl('/api/v1/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    yield { type: 'error', reason: `could not reach Nova — ${failureReason(err)}` }
    yield { type: 'done' }
    return
  }

  if (!response.ok) {
    yield { type: 'error', reason: await statedRefusal(response) }
    yield { type: 'done' }
    return
  }
  if (!response.body) {
    yield { type: 'error', reason: 'the server answered with no stream to read' }
    yield { type: 'done' }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  let sawDone = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (event.type === 'done') sawDone = true
        yield event
      }
    }
    for (const event of parser.flush()) {
      if (event.type === 'done') sawDone = true
      yield event
    }
  } catch (err) {
    // The socket died partway. Everything already yielded really arrived —
    // say the turn was cut off rather than letting it look finished.
    yield { type: 'interrupted', reason: `the connection dropped — ${failureReason(err)}` }
    return
  } finally {
    reader.cancel().catch(() => {})
  }

  if (!sawDone) {
    yield {
      type: 'interrupted',
      reason: 'the stream ended before the server said the turn was finished',
    }
  }
}
