import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AgentsPage } from './AgentsPage'
import { agentFixture } from './agentFixture'
import type { Agent, AgentSaved, AgentWrite, SkillInfo, ToolInfo } from '../../lib/api'

const TOOLS: ToolInfo[] = [
  { name: 'workspace_read_file', description: 'read a file in the workspace', result_kind: 'text', ephemeral: false },
  { name: 'workspace_write_file', description: 'write a file in the workspace', result_kind: 'text', ephemeral: false },
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
    file_present: true,
    uses: null,
    created_at: null,
    updated_at: null,
    size: 120,
    modified: '2026-09-08T08:00:00Z',
  },
]

function saved(body: AgentWrite): AgentSaved {
  return {
    ...agentFixture({ name: body.name, purpose: body.purpose, instructions: body.instructions, tools: body.tools }),
    text: `created agent ${body.name} — folder agents/${body.name}/ made; route agent_${body.name} registered`,
    route: { registered: true, detail: `route agent_${body.name} registered` },
  }
}

function fakeApi(roster: () => Agent[] = () => []) {
  return {
    listAgents: vi.fn(async () => roster()),
    createAgent: vi.fn(async (body: AgentWrite) => saved(body)),
    listTools: vi.fn(async () => TOOLS),
    listSkills: vi.fn(async () => SKILLS),
  }
}

const NEVER = 1_000_000

function renderPage(api: ReturnType<typeof fakeApi>, props: { pollMs?: number; notice?: string | null } = {}) {
  return render(
    <MemoryRouter>
      <AgentsPage api={api} pollMs={props.pollMs ?? NEVER} notice={props.notice ?? null} />
    </MemoryRouter>,
  )
}

/** Fill the sheet's required fields and tick one tool. */
function fillForm(form: HTMLElement, name = 'coder') {
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'writes code' } })
  fireEvent.change(within(form).getByLabelText('Instructions'), { target: { value: 'Work under your folder.' } })
  fireEvent.click(within(form).getByLabelText(/workspace_write_file/))
}

describe('AgentsPage — the roster', () => {
  it('shows the empty state when there are no agents', async () => {
    renderPage(fakeApi())
    expect(await screen.findByText(/no agents yet/i)).toBeDefined()
    expect(screen.getByText(/create one, or ask Nova to/i)).toBeDefined()
  })

  it('renders a row per agent: name linking to its page, purpose, state, spend, last active, tools count', async () => {
    const api = fakeApi(() => [
      agentFixture({
        name: 'coder',
        purpose: 'writes code',
        state: { working: true, doing: 'writing haiku.md', since: new Date().toISOString(), turn_id: 't1' },
        spent_month_usd: 1.5,
        last_active: new Date(Date.now() - 2 * 60_000).toISOString(),
        tools: ['a', 'b', 'c'],
      }),
      agentFixture({ name: 'mailer', purpose: 'drafts email', spent_month_usd: 0, last_active: null, tools: ['send'] }),
    ])
    renderPage(api)
    const list = await screen.findByTestId('agents-list')
    const coder = within(list).getByTestId('agent-row-coder')
    const link = within(coder).getByRole('link', { name: /coder/ })
    expect(link.getAttribute('href')).toBe('/agents/coder')
    expect(within(coder).getByText('writes code')).toBeDefined()
    const pill = within(coder).getByTestId('state-pill')
    expect(pill.textContent).toBe('working · writing haiku.md')
    expect(pill.getAttribute('data-working')).toBe('true')
    expect(within(coder).getByTestId('spend').textContent).toBe('$1.50')
    expect(within(coder).getByText('2m ago')).toBeDefined()
    expect(within(coder).getByTestId('tools-count').textContent).toBe('3')

    const mailer = within(list).getByTestId('agent-row-mailer')
    expect(within(mailer).getByTestId('state-pill').textContent).toBe('idle')
    expect(within(mailer).getByTestId('state-pill').getAttribute('data-working')).toBe('false')
    // A real 0 is money, never "unreadable".
    expect(within(mailer).getByTestId('spend').textContent).toBe('$0.00')
    expect(within(mailer).getByText('never')).toBeDefined()
    expect(within(mailer).getByTestId('tools-count').textContent).toBe('1')
    // Rows in the order the server gave them.
    expect(within(list).getAllByTestId(/^agent-row-/).map(r => r.getAttribute('data-testid'))).toEqual([
      'agent-row-coder',
      'agent-row-mailer',
    ])
  })

  it('an unreadable ledger reads "spend unreadable" with the server\'s note as the title — never 0', async () => {
    renderPage(
      fakeApi(() => [
        agentFixture({ name: 'coder', spent_month_usd: null, spend_note: 'ledger unreadable — the gateway is not answering' }),
      ]),
    )
    const row = await screen.findByTestId('agent-row-coder')
    const spend = within(row).getByTestId('spend')
    expect(spend.textContent).toBe('spend unreadable')
    expect(spend.getAttribute('title')).toBe('ledger unreadable — the gateway is not answering')
    expect(within(row).queryByText('$0.00')).toBeNull()
  })

  it('flags tools the registry no longer lists beside the count', async () => {
    renderPage(fakeApi(() => [agentFixture({ name: 'coder', tools: ['a', 'gone'], unknown_tools: ['gone'] })]))
    const row = await screen.findByTestId('agent-row-coder')
    expect(within(row).getByText('1 no longer exists')).toBeDefined()
  })

  it('a failed load states the reason in an alert', async () => {
    const api = fakeApi()
    api.listAgents = vi.fn(async () => {
      throw new Error('the server refused the turn (500)')
    })
    renderPage(api)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
    expect(screen.queryByTestId('agents-skeleton')).toBeNull()
  })

  it('shows the one-time notice handed over after a delete, and it can be dismissed', async () => {
    renderPage(fakeApi(), { notice: 'Deleted coder — no timers were bound to it; its folder stays.' })
    const notice = await screen.findByTestId('agents-notice')
    expect(notice.textContent).toContain('Deleted coder')
    fireEvent.click(within(notice).getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByTestId('agents-notice')).toBeNull()
  })
})

describe('AgentsPage — the light poll', () => {
  it('re-reads the roster on the interval so a state change is seen with no operator action', async () => {
    let working = false
    const api = fakeApi(() => [
      agentFixture({
        name: 'coder',
        state: working
          ? { working: true, doing: 'reviewing', since: new Date().toISOString(), turn_id: 't1' }
          : { working: false, doing: null, since: null, turn_id: null },
      }),
    ])
    renderPage(api, { pollMs: 10 })
    const row = await screen.findByTestId('agent-row-coder')
    expect(within(row).getByTestId('state-pill').textContent).toBe('idle')
    await waitFor(() => expect(api.listAgents.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(within(screen.getByTestId('agent-row-coder')).getByTestId('state-pill').textContent).toBe('idle')

    working = true
    await waitFor(() =>
      expect(within(screen.getByTestId('agent-row-coder')).getByTestId('state-pill').textContent).toBe('working · reviewing'),
    )
  })

  it('a poll failure keeps the roster and states why, until a read succeeds again', async () => {
    let broken = false
    const api = fakeApi()
    api.listAgents = vi.fn(async () => {
      if (broken) throw new Error('core is not answering')
      return [agentFixture({ name: 'coder' })]
    })
    renderPage(api, { pollMs: 10 })
    await screen.findByTestId('agent-row-coder')
    broken = true
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('core is not answering'))
    expect(screen.getByTestId('agent-row-coder')).toBeDefined()
    broken = false
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('stops polling after unmount', async () => {
    const api = fakeApi(() => [agentFixture()])
    const { unmount } = renderPage(api, { pollMs: 10 })
    await waitFor(() => expect(api.listAgents.mock.calls.length).toBeGreaterThanOrEqual(3))
    unmount()
    const atUnmount = api.listAgents.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(api.listAgents.mock.calls.length).toBe(atUnmount)
  })
})

describe('AgentsPage — New agent', () => {
  it('opens the form with the live tool and skill lists, delegate_to_agent hidden', async () => {
    const api = fakeApi()
    renderPage(api)
    await screen.findByText(/no agents yet/i)
    fireEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0])
    const form = await screen.findByTestId('agent-form')
    expect(api.listTools).toHaveBeenCalledTimes(1)
    expect(api.listSkills).toHaveBeenCalledTimes(1)
    await within(form).findByLabelText(/workspace_read_file/)
    expect(within(form).getByLabelText(/workspace_write_file/)).toBeDefined()
    expect(within(form).queryByLabelText(/delegate_to_agent/)).toBeNull()
    expect(await within(form).findByLabelText(/review/)).toBeDefined()
    // The chain is set on Routing, not here.
    expect(within(form).getByRole('link', { name: /settings → routing/i }).getAttribute('href')).toBe('/settings')
  })

  it('creates the agent with what was typed, closes the sheet and re-reads the roster', async () => {
    const rows: Agent[] = []
    const api = fakeApi(() => rows)
    api.createAgent = vi.fn(async (body: AgentWrite) => {
      rows.push(agentFixture({ name: body.name, purpose: body.purpose }))
      return saved(body)
    })
    renderPage(api)
    await screen.findByText(/no agents yet/i)
    fireEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0])
    const form = await screen.findByTestId('agent-form')
    await within(form).findByLabelText(/workspace_write_file/)
    fillForm(form)
    fireEvent.click(within(form).getByLabelText(/review/))
    fireEvent.change(within(form).getByLabelText('Monthly cap (USD)'), { target: { value: '5' } })
    fireEvent.change(within(form).getByLabelText('Max tool rounds'), { target: { value: '7' } })
    fireEvent.click(within(form).getByLabelText('Read shared memory'))
    fireEvent.submit(form)

    await waitFor(() => expect(api.createAgent).toHaveBeenCalledTimes(1))
    expect(api.createAgent.mock.calls[0][0]).toEqual({
      name: 'coder',
      purpose: 'writes code',
      instructions: 'Work under your folder.',
      tools: ['workspace_write_file'],
      skills: ['review'],
      monthly_cap_usd: 5,
      max_tool_rounds: 7,
      read_shared_memory: true,
    })
    await waitFor(() => expect(screen.queryByTestId('agent-form')).toBeNull())
    // The roster was re-read; the row shown is the server's, and its sentence is up.
    await waitFor(() => expect(api.listAgents).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('agent-row-coder')).toBeDefined()
    expect(screen.getByTestId('agent-created').textContent).toContain('created agent coder')
  })

  it('a blank cap is uncapped (null) and a blank rounds field is left to the store\'s default', async () => {
    const api = fakeApi()
    renderPage(api)
    await screen.findByText(/no agents yet/i)
    fireEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0])
    const form = await screen.findByTestId('agent-form')
    await within(form).findByLabelText(/workspace_write_file/)
    fillForm(form)
    fireEvent.submit(form)
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledTimes(1))
    const body = api.createAgent.mock.calls[0][0]
    expect(body.monthly_cap_usd).toBeNull()
    expect('max_tool_rounds' in body).toBe(false)
    expect(body.read_shared_memory).toBe(false)
  })

  it('rounds outside 1–50 cannot be submitted', async () => {
    const api = fakeApi()
    renderPage(api)
    await screen.findByText(/no agents yet/i)
    fireEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0])
    const form = await screen.findByTestId('agent-form')
    await within(form).findByLabelText(/workspace_write_file/)
    fillForm(form)
    fireEvent.change(within(form).getByLabelText('Max tool rounds'), { target: { value: '51' } })
    const submit = within(form).getByRole('button', { name: /create agent/i }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(within(form).getByText(/1 to 50/)).toBeDefined()
    fireEvent.submit(form)
    expect(api.createAgent).not.toHaveBeenCalled()
  })

  it('a refused create shows the store\'s words inline and keeps the sheet open with the draft', async () => {
    const api = fakeApi()
    api.createAgent = vi.fn(async () => {
      throw new Error("an agent's name is lowercase letters, digits and hyphens — 'Coder' is not")
    })
    renderPage(api)
    await screen.findByText(/no agents yet/i)
    fireEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0])
    const form = await screen.findByTestId('agent-form')
    await within(form).findByLabelText(/workspace_write_file/)
    fillForm(form, 'Coder')
    fireEvent.submit(form)
    await waitFor(() => expect(api.createAgent).toHaveBeenCalled())
    const alert = await within(screen.getByTestId('agent-form')).findByRole('alert')
    expect(alert.textContent).toContain("'Coder' is not")
    expect((within(screen.getByTestId('agent-form')).getByLabelText('Name') as HTMLInputElement).value).toBe('Coder')
    expect(api.listAgents).toHaveBeenCalledTimes(1)
  })

  it('a tool registry that cannot be read is said in the form, and Cancel closes it', async () => {
    const api = fakeApi()
    api.listTools = vi.fn(async () => {
      throw new Error('registry unavailable')
    })
    renderPage(api)
    await screen.findByText(/no agents yet/i)
    fireEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0])
    const form = await screen.findByTestId('agent-form')
    expect((await within(form).findByRole('alert')).textContent).toContain('registry unavailable')
    fireEvent.click(within(form).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByTestId('agent-form')).toBeNull()
  })
})
