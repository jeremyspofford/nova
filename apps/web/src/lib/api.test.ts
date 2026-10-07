import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ApiError,
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
  updateDevice,
  getMachines,
  setMachineServing,
  rewind,
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

describe('machines (S40): the routes and the bodies, verbatim', () => {
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
  const HUB = {
    name: 'hub', lifecycle: 'always_on', serving: false, state: 'switched_off', reason: null, observed_at: null,
    compute: null, runtime: 'container', models: [],
  }

  it('lists from the fixed path, and asks for a fresh look only when told to', async () => {
    stubJson({ machines: [HUB] })
    expect(await getMachines()).toEqual({ machines: [HUB] })
    expect(call()[0]).toBe('/api/v1/machines')
    stubJson({ machines: [HUB] })
    await getMachines({ live: true })
    expect(call()[0]).toBe('/api/v1/machines?live=true')
  })

  it('sets the switch with PATCH {serving} and returns the row core read back, not the request', async () => {
    stubJson(HUB)
    expect(await setMachineServing('hub box', false)).toEqual(HUB)
    const [url, init] = call()
    expect(url).toBe('/api/v1/machines/hub%20box')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ serving: false })
  })
})

describe('updateDevice (S42b D4/K4, carried from Task 26): a dead or slow gateway is typed, never thrown', () => {
  function stubStatus(status: number, body = '') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status,
        text: async () => body,
      }) as unknown as Response),
    )
  }

  it.each([502, 504, 524])('status %i comes back as not_known_yet, never thrown', async status => {
    // Cloudflare's own error page — not JSON, exactly the body statedReason
    // would otherwise just quote verbatim as if it were a real refusal.
    stubStatus(status, '<html><body>Bad Gateway</body></html>')
    const outcome = await updateDevice('d-1')
    expect(outcome.outcome).toBe('not_known_yet')
    expect(outcome.version).toBeNull()
    expect(outcome.from_version).toBeNull()
    expect(outcome.needs_card).toBe(false)
    expect(outcome.in_flight).toBeNull()
    expect(outcome.reason).toContain('sent or not, not known yet')
    expect(outcome.reason).not.toContain('<html>')
  })

  it('a network failure says "may or may not" — status 0 happens BEFORE sending too, so it never claims the request was sent (K4)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error')
      }),
    )
    const outcome = await updateDevice('d-1')
    expect(outcome.outcome).toBe('not_known_yet')
    expect(outcome.reason).toContain('may or may not have received it')
    expect(outcome.reason).not.toContain('after the request was sent')
  })

  it('a 200 whose body cannot be read is not_known_yet too — core certainly got the request (K4)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => {
          throw new TypeError('network error')
        },
      }) as unknown as Response),
    )
    const outcome = await updateDevice('d-1')
    expect(outcome.outcome).toBe('not_known_yet')
    expect(outcome.reason).toContain('its body could not be read')
  })

  it('a real refusal (404, unpaired device) is thrown verbatim, never absorbed into not_known_yet', async () => {
    stubStatus(404, JSON.stringify({ error: 'no paired device with that id' }))
    await expect(updateDevice('d-1')).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('no paired device with that id'),
    })
  })

  it.each([500, 503])('status %i reads as itself — thrown with core’s own reason, never not_known_yet (K10)', async status => {
    stubStatus(status, JSON.stringify({ error: `core said ${status}` }))
    const err: unknown = await updateDevice('d-1').then(
      v => v,
      e => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
    expect((err as ApiError).message).toContain(`core said ${status}`)
  })

  it('a real answer passes through verbatim, including in_flight (K9), to the fixed path, as a POST', async () => {
    const body = { outcome: 'sent', version: 'abcdef123456', from_version: '111111111111', reason: null, needs_card: false, in_flight: 2 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as unknown as Response),
    )
    expect(await updateDevice('d 1')).toEqual(body)
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/devices/d%201/update')
    expect(init.method).toBe('POST')
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

describe('rewind (chat rewind T7): the route, the body, and core\'s own words', () => {
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

  it('POSTs {message_id, mode} to the conversation\'s rewind route and resolves to core\'s result verbatim', async () => {
    const result = {
      rewind_id: 'r1',
      marker_message_id: 'm1',
      mode: 'executions',
      withdrawn: 3,
      undone: [{ tool: 'workspace_write_file', action_id: 'a1', line: 'restored notes.md' }],
      not_undone: [{ tool: 'device_run', action_id: 'a2', reason: 'a command already run cannot be taken back' }],
    }
    stubJson(result)
    expect(await rewind('c1', 'u7', 'executions').catch(err => err)).toEqual(result)
    const [url, init] = call()
    expect(url).toBe('/api/v1/conversations/c1/rewind')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ message_id: 'u7', mode: 'executions' })
  })

  it('sends mode "chat" as given', async () => {
    stubJson({ rewind_id: 'r1', marker_message_id: 'm1', mode: 'chat', withdrawn: 1, undone: [], not_undone: [] })
    await rewind('c1', 'u7', 'chat').catch(() => undefined)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(call()[1]?.body as string)).toEqual({ message_id: 'u7', mode: 'chat' })
  })

  it('a 409 rejects with core\'s stated reason and status, never a generic message', async () => {
    stubJson({ error: 'a turn is still running in this conversation' }, 409)
    await expect(rewind('c1', 'u7', 'chat')).rejects.toMatchObject({
      status: 409,
      message: 'a turn is still running in this conversation',
    })
  })

  it('a 400 refusal rejects with core\'s stated reason', async () => {
    stubJson({ error: 'u7 is not one of his messages in this conversation' }, 400)
    await expect(rewind('c1', 'u7', 'chat')).rejects.toMatchObject({
      status: 400,
      message: 'u7 is not one of his messages in this conversation',
    })
  })
})
