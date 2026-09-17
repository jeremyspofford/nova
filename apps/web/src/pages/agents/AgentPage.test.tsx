import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AgentPage } from './AgentPage'
import { agentFixture } from './agentFixture'
import {
  ApiError,
  type ActivityTurn,
  type ActivityTurnDetail,
  type Agent,
  type AgentChanges,
  type AgentDeleted,
  type AgentSaved,
  type SkillInfo,
  type StoredMessage,
  type ToolInfo,
  type WorkspaceFileListing,
} from '../../lib/api'

const TOOLS: ToolInfo[] = [
  { name: 'workspace_read_file', description: 'read a file', result_kind: 'text', ephemeral: false },
  { name: 'workspace_write_file', description: 'write a file', result_kind: 'text', ephemeral: false },
  { name: 'delegate_to_agent', description: 'hand work to an agent', result_kind: 'text', ephemeral: false },
]
// A file under skills/ with no row of its own — still offerable to an agent
// (S17 keeps those grants working), which is why the form lists it.
const SKILLS: SkillInfo[] = [
  {
    name: 'review',
    title: null,
    summary: null,
    status: null,
    created_via: null,
    step_names: [],
    flagged_reason: null,
    scripted: false,
    script: null,
    inputs: null,
    file_present: true,
    uses: null,
    created_at: null,
    updated_at: null,
    size: 120,
    modified: '2026-09-08T08:00:00Z',
  },
]

function turn(overrides: Partial<ActivityTurn> = {}): ActivityTurn {
  return {
    id: 't1',
    kind: 'agent',
    model: 'ollama:qwen3:8b',
    status: 'ok',
    started_at: new Date().toISOString(),
    duration_ms: 1200,
    tool_call_count: 1,
    llm_round_count: 2,
    conversation_id: 'log-1',
    agent: 'coder',
    role: 'agent_coder',
    ...overrides,
  }
}

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return { id: 'm1', role: 'user', content: 'write a haiku', created_at: '2026-09-08T10:00:00Z', ...overrides }
}

const DELETED: AgentDeleted = {
  deleted: 'coder',
  paused_timers: [],
  route: { registered: true, detail: 'route agent_coder removed' },
  remains: 'its folder agents/coder/, its memory notes and its log conversation were left in place',
  text: 'deleted agent coder — …',
}

function fakeApi(
  agent: () => Agent = () => agentFixture(),
  extra: {
    traces?: ActivityTurn[]
    details?: Record<string, ActivityTurnDetail>
    files?: WorkspaceFileListing
    log?: StoredMessage[]
  } = {},
) {
  return {
    getAgent: vi.fn(async () => agent()),
    updateAgent: vi.fn(async (name: string, changes: AgentChanges): Promise<AgentSaved> => ({
      ...agentFixture({ name, ...(changes as Partial<Agent>) }),
      text: `updated agent ${name}`,
      route: { registered: true, detail: `route agent_${name} kept` },
    })),
    deleteAgent: vi.fn(async () => DELETED),
    getAgentLog: vi.fn(async () => extra.log ?? []),
    getActivity: vi.fn(async () => extra.traces ?? []),
    getActivityTurn: vi.fn(async (id: string) => {
      const found = extra.details?.[id]
      if (!found) throw new Error(`no detail stubbed for ${id}`)
      return found
    }),
    getWorkspaceFiles: vi.fn(async () => extra.files ?? { files: [], total: 0, truncated: false }),
    listTools: vi.fn(async () => TOOLS),
    listSkills: vi.fn(async () => SKILLS),
  }
}

const NEVER = 1_000_000

function renderPage(api: ReturnType<typeof fakeApi>, name = 'coder', pollMs = NEVER) {
  const onDeleted = vi.fn()
  const view = render(
    <MemoryRouter>
      <AgentPage name={name} api={api} onDeleted={onDeleted} pollMs={pollMs} pageSize={2} />
    </MemoryRouter>,
  )
  return { ...view, onDeleted }
}

describe('AgentPage — the header', () => {
  it('shows the spec and every derived fact as the server stated it', async () => {
    const api = fakeApi(() =>
      agentFixture({
        name: 'coder',
        purpose: 'writes code',
        monthly_cap_usd: 5,
        spent_month_usd: 1.5,
        max_tool_rounds: 8,
        read_shared_memory: true,
        tools: ['workspace_read_file', 'gone_tool'],
        unknown_tools: ['gone_tool'],
        skills: [
          { name: 'review', present: true },
          { name: 'lost', present: false },
        ],
        bound_timers: [{ id: 'x', title: 'nightly review' }],
        state: { working: true, doing: 'reviewing', since: new Date().toISOString(), turn_id: 't1' },
      }),
    )
    renderPage(api)
    const facts = await screen.findByTestId('agent-facts')
    expect(screen.getByRole('heading', { name: 'coder' })).toBeDefined()
    expect(screen.getByText('writes code')).toBeDefined()
    expect(within(facts).getByTestId('state-pill').textContent).toBe('working · reviewing')
    expect(within(facts).getByText('agent_coder')).toBeDefined()
    expect(within(facts).getByRole('link', { name: /settings → routing/i }).getAttribute('href')).toBe('/settings')
    expect(within(facts).getByTestId('spend').textContent).toBe('$1.50')
    expect(within(facts).getByText(/of \$5\.00 \/ month/)).toBeDefined()
    expect(within(facts).getByTestId('agent-rounds').textContent).toBe('up to 8 tool rounds a turn')
    expect(within(facts).getByTestId('agent-read-shared').textContent).toContain('reads the household')
    const tools = within(facts).getByTestId('agent-tools')
    expect(tools.textContent).toContain('workspace_read_file')
    expect(tools.textContent).toContain('gone_tool — no longer exists')
    const skills = within(facts).getByTestId('agent-skills')
    expect(skills.textContent).toContain('review')
    expect(skills.textContent).toContain('lost — missing')
    expect(within(facts).getByTestId('agent-folder').textContent).toBe('agents/coder/')
    expect(within(facts).getByTestId('agent-timers').textContent).toContain('nightly review')
  })

  it('an unreadable ledger reads "spend unreadable" with the note, never 0', async () => {
    renderPage(fakeApi(() => agentFixture({ spent_month_usd: null, spend_note: 'ledger unreadable — gateway down', monthly_cap_usd: null })))
    const facts = await screen.findByTestId('agent-facts')
    const spend = within(facts).getByTestId('spend')
    expect(spend.textContent).toBe('spend unreadable')
    expect(spend.getAttribute('title')).toBe('ledger unreadable — gateway down')
    expect(within(facts).getByText(/of uncapped/)).toBeDefined()
  })

  it('a name no agent holds is core\'s 404, in its words, with a way back', async () => {
    const api = fakeApi()
    api.getAgent = vi.fn(async () => {
      throw new ApiError(404, 'no agent named nobody')
    })
    renderPage(api, 'nobody')
    expect(await screen.findByText('no agent named nobody')).toBeDefined()
    expect(screen.getByRole('link', { name: /back to agents/i }).getAttribute('href')).toBe('/agents')
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('any other failure states its reason in an alert', async () => {
    const api = fakeApi()
    api.getAgent = vi.fn(async () => {
      throw new Error('the server refused the turn (500)')
    })
    renderPage(api)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
  })

  it('the header re-reads on the interval so a state change is seen', async () => {
    let working = false
    const api = fakeApi(() =>
      agentFixture({
        state: working
          ? { working: true, doing: 'reviewing', since: new Date().toISOString(), turn_id: 't1' }
          : { working: false, doing: null, since: null, turn_id: null },
      }),
    )
    renderPage(api, 'coder', 10)
    const facts = await screen.findByTestId('agent-facts')
    expect(within(facts).getByTestId('state-pill').textContent).toBe('idle')
    await waitFor(() => expect(api.getAgent.mock.calls.length).toBeGreaterThanOrEqual(3))
    working = true
    await waitFor(() => expect(within(screen.getByTestId('agent-facts')).getByTestId('state-pill').textContent).toBe('working · reviewing'))
  })
})

describe('AgentPage — Traces', () => {
  it('lists this agent\'s turns (the ?agent= filter), the Activity rows, with the drill-in', async () => {
    const api = fakeApi(undefined, {
      traces: [turn({ id: 't1' }), turn({ id: 't2', status: null, duration_ms: null })],
      details: {
        t1: {
          turn: turn({ id: 't1' }),
          spans: [
            {
              kind: 'tool',
              name: 'workspace_write_file',
              started_at: new Date().toISOString(),
              duration_ms: 3,
              meta: { ok: true, args_redacted: { path: 'agents/coder/haiku.md' }, result_head: 'Wrote agents/coder/haiku.md' },
            },
          ],
        },
      },
    })
    renderPage(api)
    const row = await screen.findByTestId('activity-row-t1')
    expect(api.getActivity).toHaveBeenCalledWith(expect.objectContaining({ agent: 'coder', limit: 2 }))
    expect(within(row).getByTestId('agent-badge').textContent).toBe('coder')
    expect(within(screen.getByTestId('activity-row-t2')).getByText('unfinished')).toBeDefined()

    fireEvent.click(row)
    const panel = await screen.findByTestId('activity-detail-t1')
    await within(panel).findByText(/Wrote agents\/coder\/haiku\.md/)
    expect(api.getActivityTurn).toHaveBeenCalledWith('t1')
    expect(within(panel).getByRole('link', { name: 'agents/coder/haiku.md' }).getAttribute('href')).toBe(
      '/files?path=agents%2Fcoder%2Fhaiku.md',
    )
  })

  it('pages older turns by the last row\'s id, and hides Load more on a short page', async () => {
    const api = fakeApi()
    api.getActivity = vi
      .fn()
      .mockResolvedValueOnce([turn({ id: 'a0' }), turn({ id: 'a1' })])
      .mockResolvedValueOnce([turn({ id: 'b0' })])
    renderPage(api)
    await screen.findByTestId('activity-row-a0')
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    await screen.findByTestId('activity-row-b0')
    expect(api.getActivity).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'coder', before: 'a1', limit: 2 }))
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('an agent that has never run says so', async () => {
    renderPage(fakeApi())
    expect(await screen.findByText(/no turns yet/i)).toBeDefined()
  })

  it('a traces read that fails states the reason', async () => {
    const api = fakeApi()
    api.getActivity = vi.fn(async () => {
      throw new Error('activity unavailable')
    })
    renderPage(api)
    expect((await screen.findByText(/could not load traces/i)).textContent).toContain('activity unavailable')
  })
})

describe('AgentPage — Artifacts', () => {
  it('lists the files under the agent\'s folder, each linking to the Files drill-in', async () => {
    const api = fakeApi(undefined, {
      files: {
        files: [{ path: 'agents/coder/haiku.md', size: 42, modified: new Date().toISOString() }],
        total: 1,
        truncated: false,
      },
    })
    renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }))
    const row = await screen.findByTestId('artifact-row-agents/coder/haiku.md')
    expect(api.getWorkspaceFiles).toHaveBeenCalledWith('agents/coder/')
    expect(within(row).getByRole('link', { name: 'agents/coder/haiku.md' }).getAttribute('href')).toBe(
      '/files?path=agents%2Fcoder%2Fhaiku.md',
    )
    expect(within(row).getByText(/42 B/)).toBeDefined()
  })

  it('an agent that has written nothing says "nothing written yet"', async () => {
    renderPage(fakeApi())
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }))
    expect(await screen.findByText(/nothing written yet/i)).toBeDefined()
  })

  it('a listing that fails states the reason', async () => {
    const api = fakeApi()
    api.getWorkspaceFiles = vi.fn(async () => {
      throw new Error("'agents/coder/' escapes the workspace")
    })
    renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }))
    expect((await screen.findByText(/could not list/i)).textContent).toContain('escapes the workspace')
  })
})

describe('AgentPage — Log', () => {
  it('renders the log as brief → report pairs, in order', async () => {
    const api = fakeApi(undefined, {
      log: [
        message({ id: 'm1', role: 'user', content: 'write a haiku to haiku.md' }),
        message({ id: 'm2', role: 'assistant', content: 'Wrote haiku.md: cold pond…', served_by: 'ollama:qwen3:8b' }),
        message({ id: 'm3', role: 'user', content: 'review it' }),
      ],
    })
    renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    const pairs = await screen.findAllByTestId('log-pair')
    expect(api.getAgentLog).toHaveBeenCalledWith('coder')
    expect(pairs).toHaveLength(2)
    expect(within(pairs[0]).getByTestId('log-brief').textContent).toBe('write a haiku to haiku.md')
    expect(within(pairs[0]).getByTestId('log-report').textContent).toBe('Wrote haiku.md: cold pond…')
    expect(within(pairs[0]).getByText('ollama:qwen3:8b')).toBeDefined()
    expect(within(pairs[1]).getByTestId('log-brief').textContent).toBe('review it')
    expect(within(pairs[1]).getByText(/no report yet/i)).toBeDefined()
  })

  it('an agent never delegated to has an empty log, said as such', async () => {
    renderPage(fakeApi())
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    expect(await screen.findByText(/no delegations yet/i)).toBeDefined()
  })
})

describe('AgentPage — Edit', () => {
  it('opens the same sheet with the name locked and the spec filled, and PUTs the changes without the name', async () => {
    const api = fakeApi(() => agentFixture({ purpose: 'writes code', tools: ['workspace_read_file'], skills: [{ name: 'review', present: true }] }))
    renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const form = await screen.findByTestId('agent-form')
    const name = within(form).getByLabelText('Name') as HTMLInputElement
    expect(name.value).toBe('coder')
    expect(name.disabled).toBe(true)
    expect((within(form).getByLabelText('Purpose') as HTMLInputElement).value).toBe('writes code')
    await within(form).findByLabelText(/workspace_write_file/)
    expect((within(form).getByLabelText(/workspace_read_file/) as HTMLInputElement).checked).toBe(true)
    expect((within(form).getByLabelText(/workspace_write_file/) as HTMLInputElement).checked).toBe(false)
    expect((await within(form).findByLabelText(/review/) as HTMLInputElement).checked).toBe(true)
    expect((within(form).getByLabelText('Max tool rounds') as HTMLInputElement).value).toBe('8')

    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'writes and reviews code' } })
    fireEvent.click(within(form).getByLabelText(/workspace_write_file/))
    fireEvent.submit(form)
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledTimes(1))
    const [calledName, changes] = api.updateAgent.mock.calls[0]
    expect(calledName).toBe('coder')
    expect('name' in changes).toBe(false)
    expect(changes).toEqual({
      purpose: 'writes and reviews code',
      instructions: 'Work only under your folder. Report what you changed.',
      tools: ['workspace_read_file', 'workspace_write_file'],
      skills: ['review'],
      monthly_cap_usd: null,
      max_tool_rounds: 8,
      read_shared_memory: false,
    })
    await waitFor(() => expect(screen.queryByTestId('agent-form')).toBeNull())
    // The header now shows the row the server read back, and its sentence.
    expect(screen.getByText('writes and reviews code')).toBeDefined()
    expect(screen.getByTestId('agent-saved').textContent).toContain('updated agent coder')
  })

  it('a tool the registry no longer lists is shown flagged and ticked, so it can be unticked', async () => {
    const api = fakeApi(() => agentFixture({ tools: ['workspace_read_file', 'gone_tool'], unknown_tools: ['gone_tool'] }))
    renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const form = await screen.findByTestId('agent-form')
    const stale = await within(form).findByTestId('tool-stale-gone_tool')
    expect(stale.textContent).toContain('no longer exists')
    const box = within(stale).getByLabelText(/gone_tool/) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    fireEvent.submit(form)
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledTimes(1))
    expect(api.updateAgent.mock.calls[0][1].tools).toEqual(['workspace_read_file'])
  })

  it('a refused update shows the store\'s words inline and keeps the sheet open', async () => {
    const api = fakeApi()
    api.updateAgent = vi.fn(async () => {
      throw new Error('tools must name registered tools — no tool named nope')
    })
    renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const form = await screen.findByTestId('agent-form')
    await within(form).findByLabelText(/workspace_write_file/)
    fireEvent.submit(form)
    const alert = await within(screen.getByTestId('agent-form')).findByRole('alert')
    expect(alert.textContent).toContain('no tool named nope')
  })
})

describe('AgentPage — Delete', () => {
  it('asks first, naming the timers it will pause, then deletes and hands the server\'s answer over', async () => {
    const api = fakeApi(() =>
      agentFixture({
        bound_timers: [
          { id: 'a', title: 'nightly review' },
          { id: 'b', title: 'weekly digest' },
        ],
      }),
    )
    const { onDeleted } = renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(api.deleteAgent).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'Delete coder? This will pause 2 scheduled timers: nightly review, weekly digest. Its folder, notes and log stay.',
      ),
    ).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith('coder'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(DELETED))
  })

  it('says plainly when no timers are bound', async () => {
    renderPage(fakeApi())
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(screen.getByText('Delete coder? No timers are bound to it. Its folder, notes and log stay.')).toBeDefined()
  })

  it('Cancel deletes nothing', async () => {
    const api = fakeApi()
    const { onDeleted } = renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(api.deleteAgent).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.queryByText(/No timers are bound to it/)).toBeNull()
  })

  it('a refused delete states core\'s reason and stays on the page', async () => {
    const api = fakeApi()
    api.deleteAgent = vi.fn(async () => {
      throw new Error('agent coder is working right now — wait for its turn to end')
    })
    const { onDeleted } = renderPage(api)
    await screen.findByTestId('agent-facts')
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('is working right now'))
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-facts')).toBeDefined()
  })
})
