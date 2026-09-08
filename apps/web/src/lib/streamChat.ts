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
 * "start"|"ok"|"error","reason"?:"<stated head>"}}`, sent once per tool
 * call while a round's tools run. It graduates from "unknown, tolerated"
 * to "known, understood" here. `reason` (added alongside the honesty fix
 * for MessageBubble's "did not finish" mislabel) is present only on some
 * "error" frames — the ERROR_PREFIX-stripped head of what the tool itself
 * stated (chat.py's `_activity_reason`) — and is optional even then: a
 * frame with `tool`/`status` but no (or non-string) `reason` is still a
 * perfectly valid, known frame, not a contract violation.
 */

import { createLineBuffer } from './lineBuffer'
import { statedReason } from './statedReason'

export type StreamEvent =
  | { type: 'meta'; conversationId: string; model: string; turnId: string }
  | { type: 'delta'; text: string }
  // status is whatever the server actually sent (chat.py only ever sends
  // start/ok/error) — kept as `string` rather than a narrower literal
  // union so a status this client has not seen yet is still a real event,
  // not a type error waiting to happen.
  // `detail` rides only a 'progress' status (S10a-3): the tool's own words
  // about a long call still running ("pulling qwen3:4b — 42% (1.0 GB of
  // 2.3 GB)"). Optional like `reason`.
  | { type: 'activity'; tool: string; status: string; reason?: string; detail?: string }
  | { type: 'error'; reason: string }
  // {"served_by": "provider:model"} — who actually answered, as the gateway
  // stated it on the llm_call span (S10-pre). Once per answered turn.
  | { type: 'served'; servedBy: string }
  // {"usage": {...}} — the turn's cost summed over its rounds from what
  // the gateway's ledger stated (S10). Once per turn, after served_by.
  // cost_usd null when no round was priced; the counts say why.
  | { type: 'usage'; usage: TurnUsage }
  // {"route": {...}} — the gateway served this turn from a link PAST the
  // first (S10-2): who answered and its stated reason. Sent only then.
  | { type: 'route'; route: RouteMarker }
  | { type: 'done' }
  | { type: 'interrupted'; reason: string }

export interface TurnUsage {
  rounds: number
  priced_rounds: number
  cost_usd: number | null
  cost_basis: string[]
  prompt_tokens: number
  completion_tokens: number
  unmetered_rounds: number
  local_rounds: number
  unrecorded_rounds: number
}

export interface RouteMarker {
  role: string | null
  link: number
  reason: string | null
  servedBy: string | null
}

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
const KNOWN_FRAME_KEYS = new Set(['t', 'error', 'meta', 'activity', 'served_by', 'usage', 'route'])

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
  if (typeof obj.served_by === 'string' && obj.served_by) {
    return { type: 'served', servedBy: obj.served_by }
  }
  if (obj.route !== null && typeof obj.route === 'object') {
    const r = obj.route as Record<string, unknown>
    if (typeof r.link === 'number') {
      return {
        type: 'route',
        route: {
          role: typeof r.role === 'string' ? r.role : null,
          link: r.link,
          reason: typeof r.reason === 'string' ? r.reason : null,
          servedBy: typeof r.served_by === 'string' ? r.served_by : null,
        },
      }
    }
  }
  if (obj.usage !== null && typeof obj.usage === 'object') {
    const u = obj.usage as Record<string, unknown>
    if (typeof u.rounds === 'number') {
      return {
        type: 'usage',
        usage: {
          rounds: u.rounds,
          priced_rounds: typeof u.priced_rounds === 'number' ? u.priced_rounds : 0,
          cost_usd: typeof u.cost_usd === 'number' ? u.cost_usd : null,
          cost_basis: Array.isArray(u.cost_basis) ? u.cost_basis.filter((b): b is string => typeof b === 'string') : [],
          prompt_tokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
          completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
          unmetered_rounds: typeof u.unmetered_rounds === 'number' ? u.unmetered_rounds : 0,
          local_rounds: typeof u.local_rounds === 'number' ? u.local_rounds : 0,
          unrecorded_rounds: typeof u.unrecorded_rounds === 'number' ? u.unrecorded_rounds : 0,
        },
      }
    }
  }
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
      const event: Extract<StreamEvent, { type: 'activity' }> = {
        type: 'activity',
        tool: activity.tool,
        status: activity.status,
      }
      // `reason` is optional even on the frame's own contract (chat.py only
      // ever sends it on some "error" statuses) — a missing or wrong-typed
      // `reason` is not a shape violation the way a missing tool/status is,
      // it just means the event carries none, so the key is left off
      // entirely rather than set to undefined.
      if (typeof activity.reason === 'string') event.reason = activity.reason
      if (typeof activity.detail === 'string') event.detail = activity.detail
      return event
    }
    // Falls through to the generic "known key, wrong shape" refusal below
    // rather than being treated as an unknown frame — `activity` IS known,
    // it just did not carry the two fields it promises.
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
  signal?: AbortSignal
}

export async function* streamChat(
  { message, conversationId, signal }: StreamChatOptions,
  fetchImpl: FetchLike = ((url, init) => fetch(url, init)) as FetchLike,
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = { message }
  if (conversationId) body.conversation_id = conversationId

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
