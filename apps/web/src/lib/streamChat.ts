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
 */

export type StreamEvent =
  | { type: 'meta'; conversationId: string; model: string; turnId: string }
  | { type: 'delta'; text: string }
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

function frameToEvent(payload: string): StreamEvent {
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
  // A frame outside the contract is not a delta and not a success. Saying so
  // is louder than dropping it, and the contract is pinned on both sides.
  return { type: 'error', reason: `unrecognised frame from the server: ${quote(payload)}` }
}

function lineToEvents(raw: string): StreamEvent[] {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  if (line.trim() === '') return []
  // SSE comment — proxies use these as keep-alives.
  if (line.startsWith(':')) return []
  if (line.startsWith('data:')) return [frameToEvent(line.slice('data:'.length).trim())]
  return [{ type: 'error', reason: `unexpected line from the server: ${quote(line)}` }]
}

export interface SseParser {
  /** Events completed by this chunk. An unfinished tail is held for the next. */
  push(chunk: string): StreamEvent[]
  /** Whatever is left when the stream ends — a frame with no trailing newline. */
  flush(): StreamEvent[]
}

export function createSseParser(): SseParser {
  let buffer = ''
  return {
    push(chunk: string): StreamEvent[] {
      buffer += chunk
      const lines = buffer.split('\n')
      // The last element is either '' (chunk ended on a newline) or a partial
      // line; either way it belongs to the next chunk, not to this batch.
      buffer = lines.pop() ?? ''
      return lines.flatMap(lineToEvents)
    },
    flush(): StreamEvent[] {
      const tail = buffer
      buffer = ''
      return lineToEvents(tail)
    },
  }
}

async function statedRefusal(response: Response): Promise<string> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    /* an unreadable body still leaves us the status */
  }
  try {
    const parsed = JSON.parse(body)
    const detail = parsed?.detail
    if (typeof detail === 'string' && detail) return `the server refused the turn (${response.status}): ${detail}`
  } catch {
    /* not JSON — quote what came back */
  }
  const quoted = body ? `: ${quote(body)}` : ''
  return `the server refused the turn (${response.status})${quoted}`
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
