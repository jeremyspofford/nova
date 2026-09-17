import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parsePullLine,
  pullModel,
  getActivity,
  getWorkspaceFiles,
  getWorkspaceFile,
  workspaceRawUrl,
  bindTimerAgent,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentLog,
  listAgents,
  listSkills,
  listTools,
  updateAgent,
  type PullLine,
} from './api'

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

describe('getActivity', () => {
  function stubJson(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as unknown as Response),
    )
  }

  it('defaults the limit and omits before when there is no cursor yet', async () => {
    stubJson({ turns: [] })
    await getActivity()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/v1/activity?limit=50')
  })

  it('carries an explicit limit and cursor through as query params', async () => {
    stubJson({ turns: [] })
    await getActivity({ limit: 10, before: 'turn-9' })
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/v1/activity?limit=10&before=turn-9')
  })

  it('returns the turns array, not the wrapper object', async () => {
    stubJson({ turns: [{ id: 't1' }] })
    expect(await getActivity()).toEqual([{ id: 't1' }])
  })
})

describe('getWorkspaceFiles / getWorkspaceFile / workspaceRawUrl', () => {
  function stubJson(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as unknown as Response),
    )
  }

  it('fetches the listing from the fixed path', async () => {
    stubJson({ files: [], total: 0, truncated: false })
    await getWorkspaceFiles()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/v1/workspace/files')
  })

  it('returns the listing body verbatim', async () => {
    const body = { files: [{ path: 'a.md', size: 5, modified: '2026-08-28T00:00:00Z' }], total: 1, truncated: false }
    stubJson(body)
    expect(await getWorkspaceFiles()).toEqual(body)
  })

  it('encodes the path query parameter for getWorkspaceFile', async () => {
    stubJson({ path: 'lists/a.md', size: 1, modified: 'x', text: '1', binary: false, too_large: false })
    await getWorkspaceFile('lists/a.md')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/v1/workspace/file?path=lists%2Fa.md')
  })

  it('builds the raw download url with the path encoded', () => {
    expect(workspaceRawUrl('lists/a.md')).toBe('/api/v1/workspace/raw?path=lists%2Fa.md')
  })

  it('narrows the listing to a folder with ?prefix= when one is given (S12)', async () => {
    stubJson({ files: [], total: 0, truncated: false })
    await getWorkspaceFiles('agents/coder/')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/v1/workspace/files?prefix=agents%2Fcoder%2F')
  })
})

describe('activity: the agent filter (S12)', () => {
  function stubJson(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as unknown as Response),
    )
  }

  it('sends ?agent= only when asked, beside the limit and cursor', async () => {
    stubJson({ turns: [] })
    await getActivity({ limit: 2, agent: 'coder', before: 'abc' })
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/v1/activity?limit=2&before=abc&agent=coder')
    stubJson({ turns: [] })
    await getActivity({ limit: 2 })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/v1/activity?limit=2')
  })
})

describe('agents (S12): the routes and the bodies, verbatim', () => {
  function stubJson(body: unknown, status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as unknown as Response),
    )
  }
  const call = () => vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit | undefined]

  it('lists, reads, logs, tools and skills from their fixed paths, names encoded', async () => {
    stubJson([])
    await listAgents()
    expect(call()[0]).toBe('/api/v1/agents')
    stubJson({ name: 'a b' })
    await getAgent('a b')
    expect(call()[0]).toBe('/api/v1/agents/a%20b')
    stubJson([])
    await getAgentLog('coder')
    expect(call()[0]).toBe('/api/v1/agents/coder/log')
    stubJson([])
    await listTools()
    expect(call()[0]).toBe('/api/v1/tools')
    stubJson([])
    await listSkills()
    expect(call()[0]).toBe('/api/v1/skills')
  })

  it('creates with a POST of the spec, updates with a PUT of the changes, deletes with DELETE', async () => {
    const spec = { name: 'coder', purpose: 'p', instructions: 'i', tools: ['workspace_read_file'] }
    stubJson({ ...spec, text: 'created', route: { registered: true, detail: 'ok' } }, 201)
    await createAgent(spec)
    let [url, init] = call()
    expect(url).toBe('/api/v1/agents')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual(spec)

    stubJson({ name: 'coder', text: 'updated', route: { registered: true, detail: 'ok' } })
    await updateAgent('coder', { purpose: 'q' })
    ;[url, init] = call()
    expect(url).toBe('/api/v1/agents/coder')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ purpose: 'q' })

    const answer = { deleted: 'coder', paused_timers: [], route: { registered: true, detail: 'removed' }, remains: 'stays', text: 't' }
    stubJson(answer)
    expect(await deleteAgent('coder')).toEqual(answer)
    ;[url, init] = call()
    expect(url).toBe('/api/v1/agents/coder')
    expect(init?.method).toBe('DELETE')
  })

  it('a refusal is thrown with the store\'s own words and status', async () => {
    stubJson({ detail: "an agent's name is lowercase — 'Coder' is not" }, 400)
    await expect(createAgent({ name: 'Coder', purpose: 'p', instructions: 'i', tools: [] })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("'Coder' is not"),
    })
  })

  it('binds a timer to an agent with PUT {agent}, null to unbind', async () => {
    stubJson({ id: 't1', agent: 'coder' })
    await bindTimerAgent('t1', 'coder')
    let [url, init] = call()
    expect(url).toBe('/api/v1/timers/t1/agent')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ agent: 'coder' })

    stubJson({ id: 't1', agent: null })
    await bindTimerAgent('t1', null)
    ;[url, init] = call()
    expect(JSON.parse(init?.body as string)).toEqual({ agent: null })
  })

  it('encodes characters that would otherwise break the query string', () => {
    expect(workspaceRawUrl('a b&c.md')).toBe('/api/v1/workspace/raw?path=a%20b%26c.md')
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
