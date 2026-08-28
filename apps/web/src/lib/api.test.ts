import { describe, it, expect, vi, afterEach } from 'vitest'
import { parsePullLine, pullModel, type PullLine } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Hand the pull the given chunks, byte-for-byte, in order. */
function stubPullResponse(chunks: string[]) {
  let i = 0
  const encoder = new TextEncoder()
  const response = {
    ok: true,
    status: 200,
    text: async () => '',
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
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

async function collect(gen: AsyncGenerator<PullLine>): Promise<PullLine[]> {
  const out: PullLine[] = []
  for await (const line of gen) out.push(line)
  return out
}

describe('parsePullLine', () => {
  it('reads ollama progress', () => {
    expect(
      parsePullLine('{"status":"pulling abc","digest":"sha256:abc","total":100,"completed":40}'),
    ).toEqual({ status: 'pulling abc', digest: 'sha256:abc', total: 100, completed: 40 })
  })

  it('reads the success line the download step gates on', () => {
    expect(parsePullLine('{"status":"success"}')).toEqual({ status: 'success' })
  })

  it('reads an error line', () => {
    expect(parsePullLine('{"error":"file does not exist"}')).toEqual({
      error: 'file does not exist',
    })
  })

  it('turns a garbage line into an error rather than dropping it', () => {
    const parsed = parsePullLine('<html>502 Bad Gateway</html>')
    expect(parsed.error).toBeTruthy()
    expect(parsed.error).toContain('502 Bad Gateway')
  })

  it('refuses valid JSON that is not an object', () => {
    expect(parsePullLine('42').error).toBeTruthy()
    expect(parsePullLine('null').error).toBeTruthy()
  })
})

describe('pullModel', () => {
  it('yields one object per line when several arrive in one chunk', async () => {
    stubPullResponse([
      '{"status":"preflight","required_gb":2.6,"free_gb":900,"ok":true}\n' +
        '{"status":"pulling manifest"}\n' +
        '{"status":"success"}\n',
    ])
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines.map(l => l.status)).toEqual(['preflight', 'pulling manifest', 'success'])
  })

  it('reassembles a line split across chunks', async () => {
    stubPullResponse(['{"status":"pulling ab', 'c","total":10,"completed":5}\n'])
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines).toEqual([{ status: 'pulling abc', total: 10, completed: 5 }])
  })

  it('surfaces the success line even when it is split across chunks', async () => {
    stubPullResponse(['{"status":"succ', 'ess"}\n'])
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines).toEqual([{ status: 'success' }])
  })

  it('surfaces an error line even when it is split across chunks', async () => {
    stubPullResponse(['{"error":"no space left ', 'on device"}\n'])
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines).toEqual([{ error: 'no space left on device' }])
  })

  it('yields a final line that never got its newline', async () => {
    stubPullResponse(['{"status":"pulling manifest"}\n{"status":"success"}'])
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines.map(l => l.status)).toEqual(['pulling manifest', 'success'])
  })

  it('reports a garbage line without ending the stream', async () => {
    stubPullResponse(['not json\n{"status":"success"}\n'])
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines[0].error).toBeTruthy()
    expect(lines[1]).toEqual({ status: 'success' })
  })

  it('skips blank lines', async () => {
    stubPullResponse(['\n{"status":"success"}\n\n'])
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines).toEqual([{ status: 'success' }])
  })

  it('says so when there is no stream to read at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, body: null, text: async () => '' }) as unknown as Response),
    )
    const lines = await collect(pullModel('qwen3:4b'))
    expect(lines).toHaveLength(1)
    expect(lines[0].error).toBeTruthy()
  })
})
