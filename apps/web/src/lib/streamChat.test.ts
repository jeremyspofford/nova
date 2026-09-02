import { describe, it, expect } from 'vitest'
import { createSseParser, streamChat, type StreamEvent } from './streamChat'

function parseAll(chunks: string[]): StreamEvent[] {
  const parser = createSseParser()
  const events: StreamEvent[] = []
  for (const chunk of chunks) events.push(...parser.push(chunk))
  events.push(...parser.flush())
  return events
}

/** A Response-shaped stand-in that hands back the given chunks, in order. */
function fakeResponse(chunks: string[], init: { ok?: boolean; status?: number; text?: string } = {}) {
  let i = 0
  const encoder = new TextEncoder()
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => init.text ?? '',
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
  } as unknown as Response
}

/** A Response whose reader throws partway — the dropped-connection case. */
function brokenResponse(chunks: string[], reason: string) {
  let i = 0
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) }
          throw new Error(reason)
        },
        cancel: async () => {},
      }),
    },
  } as unknown as Response
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of gen) out.push(event)
  return out
}

describe('createSseParser', () => {
  it('reads several frames out of a single chunk', () => {
    const events = parseAll([
      'data: {"meta":{"conversation_id":"c1","model":"qwen3:4b","turn_id":"t1"}}\n\n' +
        'data: {"t":"He"}\n\n' +
        'data: {"t":"llo"}\n\n' +
        'data: [DONE]\n\n',
    ])
    expect(events).toEqual([
      { type: 'meta', conversationId: 'c1', model: 'qwen3:4b', turnId: 't1' },
      { type: 'delta', text: 'He' },
      { type: 'delta', text: 'llo' },
      { type: 'done' },
    ])
  })

  it('buffers a frame split across chunk boundaries', () => {
    const events = parseAll(['data: {"t":"par', 'tial"}\n\n', 'data: [DO', 'NE]\n\n'])
    expect(events).toEqual([{ type: 'delta', text: 'partial' }, { type: 'done' }])
  })

  it('buffers a frame split mid-newline', () => {
    const events = parseAll(['data: {"t":"a"}\n', '\ndata: {"t":"b"}\n\n'])
    expect(events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
    ])
  })

  it('handles CRLF line endings', () => {
    const events = parseAll(['data: {"t":"x"}\r\n\r\ndata: [DONE]\r\n\r\n'])
    expect(events).toEqual([{ type: 'delta', text: 'x' }, { type: 'done' }])
  })

  it('turns an error frame into an error event carrying the stated reason', () => {
    const events = parseAll(['data: {"error":"the gateway refused the request (503)"}\n\ndata: [DONE]\n\n'])
    expect(events).toEqual([
      { type: 'error', reason: 'the gateway refused the request (503)' },
      { type: 'done' },
    ])
  })

  it('reports a garbage payload as an error rather than crashing', () => {
    const events = parseAll(['data: not json at all\n\n'])
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect(events[0].type === 'error' && events[0].reason).toContain('not json at all')
  })

  it('reports a line that is not a data frame as an error', () => {
    const events = parseAll(['<html>502 Bad Gateway</html>\n'])
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect(events[0].type === 'error' && events[0].reason).toContain('502 Bad Gateway')
  })

  // A well-formed JSON object whose keys are ALL unknown is ignored rather
  // than errored, so a future server can add a new frame type without
  // breaking a client built before it existed. A frame carrying a KNOWN
  // key with the wrong shape (the "malformed key" tests below) is still an
  // error — this only covers keys this client has never heard of at all.
  // (Ruling S2-R6, amending S1's R20, which used to error on any frame
  // outside {t, error, meta}.)
  it('ignores a well-formed frame whose keys are all unknown, forward-compat', () => {
    expect(parseAll(['data: {"surprise":1}\n\n'])).toEqual([])
    expect(parseAll(['data: {}\n\n'])).toEqual([])
  })

  it('still errors a frame carrying a known key with the wrong shape', () => {
    const events = parseAll(['data: {"meta":"not an object"}\n\n'])
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
  })

  // Task 2's tool loop emits {"activity":{tool,status}} while a round's
  // tool calls run — S1's forward-compat above is what let an older client
  // tolerate these before this client knew what they meant. Now it does:
  // this is a KNOWN frame, not an unknown one, and status is whatever the
  // server actually reported (chat.py only ever sends start/ok/error, but
  // this parser does not invent a narrower type than the wire promises).
  it('turns an activity frame into an activity event', () => {
    expect(
      parseAll(['data: {"activity":{"tool":"get_time","status":"start"}}\n\n']),
    ).toEqual([{ type: 'activity', tool: 'get_time', status: 'start' }])
    expect(
      parseAll(['data: {"activity":{"tool":"get_time","status":"ok"}}\n\n']),
    ).toEqual([{ type: 'activity', tool: 'get_time', status: 'ok' }])
    expect(
      parseAll(['data: {"activity":{"tool":"workspace_write_file","status":"error"}}\n\n']),
    ).toEqual([{ type: 'activity', tool: 'workspace_write_file', status: 'error' }])
  })

  it('errors an activity frame missing tool or status rather than dropping it silently', () => {
    expect(parseAll(['data: {"activity":{"status":"start"}}\n\n'])[0].type).toBe('error')
    expect(parseAll(['data: {"activity":{"tool":"get_time"}}\n\n'])[0].type).toBe('error')
    expect(parseAll(['data: {"activity":"not an object"}\n\n'])[0].type).toBe('error')
    expect(parseAll(['data: {"activity":null}\n\n'])[0].type).toBe('error')
  })

  // S3-T2's approval card: the policy kernel raises a consent this turn and
  // chat.py streams its card_spec verbatim. S2-T1's forward-compat allowance
  // is what let an older client silently ignore these before this client
  // knew what they meant; now it graduates from unknown to known, same as
  // `activity` did for S2's tool loop.
  it('turns a consent frame into a consent event carrying the card', () => {
    const card = {
      consent_id: 'c-1',
      action_class: 'fetch_url',
      args_hash: 'deadbeef',
      args: { url: 'https://example.com/pricing' },
      summary: 'Run fetch_url with url=https://example.com/pricing',
      status: 'pending',
      conversation_id: 'conv-1',
      requested_by: { person_id: 'p-1', agent: 'chat' },
      created_at: '2026-08-30T00:00:00Z',
      expires_at: '2026-08-31T00:00:00Z',
    }
    expect(parseAll([`data: {"consent":${JSON.stringify(card)}}\n\n`])).toEqual([
      { type: 'consent', card },
    ])
  })

  it('errors a consent frame missing consent_id, action_class or summary rather than dropping it', () => {
    expect(parseAll(['data: {"consent":{"action_class":"fetch_url","summary":"x"}}\n\n'])[0].type).toBe(
      'error',
    )
    expect(parseAll(['data: {"consent":"not an object"}\n\n'])[0].type).toBe('error')
    expect(parseAll(['data: {"consent":null}\n\n'])[0].type).toBe('error')
  })

  it('still errors malformed/non-JSON lines — the amendment only covers well-formed unknowns', () => {
    const events = parseAll(['data: not json at all\n\n'])
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
  })

  it('ignores blank lines and SSE comment heartbeats', () => {
    expect(parseAll(['\n\n', ': keep-alive\n\n', '   \n'])).toEqual([])
  })

  it('flushes a trailing frame that never got its newline', () => {
    const parser = createSseParser()
    expect(parser.push('data: {"t":"tail"}')).toEqual([])
    expect(parser.flush()).toEqual([{ type: 'delta', text: 'tail' }])
  })

  it('flushes nothing when the buffer is empty', () => {
    const parser = createSseParser()
    parser.push('data: {"t":"a"}\n\n')
    expect(parser.flush()).toEqual([])
  })
})

describe('streamChat', () => {
  it('yields the frames of a healthy turn', async () => {
    const fetchImpl = async () =>
      fakeResponse([
        'data: {"meta":{"conversation_id":"c1","model":"m","turn_id":"t1"}}\n\n',
        'data: {"t":"hi"}\n\ndata: [DONE]\n\n',
      ])
    const events = await collect(streamChat({ message: 'hello' }, fetchImpl))
    expect(events).toEqual([
      { type: 'meta', conversationId: 'c1', model: 'm', turnId: 't1' },
      { type: 'delta', text: 'hi' },
      { type: 'done' },
    ])
  })

  it('posts the message and the conversation id', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen = { url, init }
      return fakeResponse(['data: [DONE]\n\n'])
    }
    await collect(streamChat({ message: 'hey', conversationId: 'c9' }, fetchImpl))
    expect(seen!.url).toBe('/api/v1/chat/stream')
    expect(seen!.init.method).toBe('POST')
    expect(JSON.parse(String(seen!.init.body))).toEqual({ message: 'hey', conversation_id: 'c9' })
  })

  it('posts continuation_of when the message resumes an approved card', async () => {
    // The plumbing marker (migration 014): a continuation sent after an
    // approve names the consent it resumes, so core records that row as
    // plumbing and later turns never read the choreography back.
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen = { url, init }
      return fakeResponse(['data: [DONE]\n\n'])
    }
    await collect(
      streamChat(
        { message: 'go ahead', conversationId: 'c9', continuationOf: 'consent-7' },
        fetchImpl,
      ),
    )
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      message: 'go ahead',
      conversation_id: 'c9',
      continuation_of: 'consent-7',
    })
  })

  it('omits continuation_of from an ordinary send', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen = { url, init }
      return fakeResponse(['data: [DONE]\n\n'])
    }
    await collect(streamChat({ message: 'hey' }, fetchImpl))
    expect(JSON.parse(String(seen!.init.body))).toEqual({ message: 'hey' })
  })

  it('turns a refused request into a stated error, never silence', async () => {
    const fetchImpl = async () =>
      fakeResponse([], { ok: false, status: 401, text: '{"detail":"no identity"}' })
    const events = await collect(streamChat({ message: 'hello' }, fetchImpl))
    expect(events[0].type).toBe('error')
    expect(events[0].type === 'error' && events[0].reason).toContain('no identity')
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('marks a stream that ends without [DONE] as interrupted', async () => {
    const fetchImpl = async () => fakeResponse(['data: {"t":"half"}\n\n'])
    const events = await collect(streamChat({ message: 'hello' }, fetchImpl))
    expect(events[0]).toEqual({ type: 'delta', text: 'half' })
    expect(events[1].type).toBe('interrupted')
  })

  it('marks a reader that throws mid-stream as interrupted, keeping what arrived', async () => {
    const fetchImpl = async () => brokenResponse(['data: {"t":"half"}\n\n'], 'socket hang up')
    const events = await collect(streamChat({ message: 'hello' }, fetchImpl))
    expect(events[0]).toEqual({ type: 'delta', text: 'half' })
    expect(events[1].type).toBe('interrupted')
    expect(events[1].type === 'interrupted' && events[1].reason).toContain('socket hang up')
  })

  it('reports a transport failure before any frame as an error', async () => {
    const fetchImpl = async () => {
      throw new Error('Failed to fetch')
    }
    const events = await collect(streamChat({ message: 'hello' }, fetchImpl))
    expect(events[0].type).toBe('error')
    expect(events[0].type === 'error' && events[0].reason).toContain('Failed to fetch')
  })
})
