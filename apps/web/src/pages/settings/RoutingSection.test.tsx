import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { RoutingSection } from './RoutingSection'
import type { AgentSummary, CatalogRow, RouteExplain, Routes } from '../../lib/api'

function row(id: string, kind: 'local' | 'cloud', installed?: boolean): CatalogRow {
  const [provider, ...rest] = id.split(':')
  return {
    id, provider, model: rest.join(':'), label: rest.join(':'), kind, installed,
    sources: [], facts: {}, capabilities: {}, suitability: {}, actions: [],
  }
}

// The gateway lists built-ins first (in its order), then stored roles by name.
const ROUTES: Routes = {
  roles: [
    { role: 'chat', chain: ['ollama:qwen3:8b'], reserved: false, builtin: true },
    { role: 'scheduled', chain: [], reserved: false, builtin: true },
    { role: 'judge', chain: [], reserved: false, builtin: true },
    { role: 'coding', chain: [], reserved: true, builtin: true },
    { role: 'vision', chain: [], reserved: true, builtin: true },
  ],
  walls: [{ provider: 'openrouter', walled_until: '2026-09-08T10:00:00Z', reason: 'openrouter refused (402): insufficient credits', status: 402, strikes: 1 }],
}
// Two agent roles the gateway holds rows for: coder's agent is live, zed's is gone.
const ROUTES_WITH_AGENTS: Routes = {
  ...ROUTES,
  roles: [
    ...ROUTES.roles,
    { role: 'agent_coder', chain: ['cerebras:llama'], reserved: false, builtin: false },
    { role: 'agent_zed', chain: ['ollama:qwen3:8b'], reserved: false, builtin: false },
  ],
}
const AGENTS: AgentSummary[] = [{ name: 'coder', purpose: 'writes and reviews code in a sandbox', role: 'agent_coder' }]
const EXPLAIN_CHAT: RouteExplain = {
  role: 'chat',
  chain: [
    { link: 1, id: 'openrouter:openai/gpt-x', verdict: 'walled', reason: 'openrouter refused (402): insufficient credits — walled for another 59 min' },
    { link: 2, id: 'ollama:qwen3:8b', verdict: 'runnable', reason: null },
  ],
  would_serve: { role: 'chat', link: 2, reason: 'fell back to link 2 (ollama:qwen3:8b) — openrouter:openai/gpt-x: openrouter refused (402)', served_by: 'ollama:qwen3:8b', standby: false },
  reason: 'fell back to link 2 (ollama:qwen3:8b) — openrouter:openai/gpt-x: openrouter refused (402)',
}

type ApiName = 'getRoutes' | 'putRoute' | 'explainRoute' | 'clearWall' | 'getCatalog' | 'deleteRoute' | 'listAgents'

function renderSection(over: Partial<Record<ApiName, ReturnType<typeof vi.fn>>> = {}) {
  const api = {
    getRoutes: vi.fn(async () => ROUTES),
    putRoute: vi.fn(async (role: string, chain: string[]) => ({ role, chain })),
    explainRoute: vi.fn(async (role: string) => (role === 'chat' ? EXPLAIN_CHAT : { role, chain: [], would_serve: null, reason: 'no chain' })),
    clearWall: vi.fn(async () => ({ provider: 'openrouter', cleared: true })),
    getCatalog: vi.fn(async () => ({
      fetched_at: 't',
      sources: [],
      rows: [row('ollama:qwen3:8b', 'local', true), row('ollama:qwen3:4b', 'local', false), row('openrouter:openai/gpt-x', 'cloud'), row('cerebras:llama', 'cloud')],
    })),
    deleteRoute: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => AGENTS),
    ...over,
  }
  render(<RoutingSection chatModel="openrouter:openai/gpt-x" api={api as never} />)
  return api
}

/** The roles on the page, top to bottom, by their data-testid. */
function rolesOnPage(): string[] {
  return Array.from(screen.getByTestId('routing-section').querySelectorAll<HTMLElement>('[data-testid^="route-"]'))
    .map(el => el.dataset.testid ?? '')
    .filter(id => /^route-[^-]+$/.test(id) || /^route-agent_[^-]+$/.test(id))
    .map(id => id.slice('route-'.length))
}

describe('RoutingSection', () => {
  it('shows every role, link 1 of chat as the current pick, and each link\'s live verdict', async () => {
    const api = renderSection()
    await waitFor(() => expect(screen.getByTestId('route-chat')).toBeTruthy())
    const chat = screen.getByTestId('route-chat')
    expect(within(chat).getByTestId('route-chat-link-1').textContent).toContain('openrouter:openai/gpt-x')
    expect(within(chat).getByTestId('route-chat-link-1').textContent).toContain('your current pick')
    expect(within(chat).getByTestId('route-chat-link-1').querySelector('[data-verdict]')?.getAttribute('data-verdict')).toBe('walled')
    expect(within(chat).getByTestId('route-chat-link-2').textContent).toContain('ollama:qwen3:8b')
    expect(within(chat).getByTestId('route-chat-would-serve').textContent).toContain('ollama:qwen3:8b would answer — fell back to link 2')
    expect(api.explainRoute).toHaveBeenCalledWith('chat', 'openrouter:openai/gpt-x')
    expect(screen.getByTestId('route-scheduled').textContent).toContain('uses the chat chain')
    expect(screen.getByTestId('route-coding').textContent).toContain('no user yet')
  })

  it('renders the roles the server returns, in the server\'s order, with the built-ins\' own words', async () => {
    // Not the canonical order: proves the page follows the response, not a list of its own.
    const shuffled: Routes = { ...ROUTES, roles: [ROUTES.roles[0], ROUTES.roles[2], ROUTES.roles[1], ROUTES.roles[4], ROUTES.roles[3]] }
    renderSection({ getRoutes: vi.fn(async () => shuffled) })
    await waitFor(() => expect(screen.getByTestId('route-vision')).toBeTruthy())
    expect(rolesOnPage()).toEqual(['chat', 'judge', 'scheduled', 'vision', 'coding'])
    expect(screen.getByTestId('route-judge').textContent).toContain('Quality judging')
    expect(screen.getByTestId('route-vision').textContent).toContain('reserved — nothing routes here yet')
    for (const role of ['chat', 'judge', 'scheduled', 'vision', 'coding']) {
      expect(within(screen.getByTestId(`route-${role}`)).queryByRole('button', { name: `remove role ${role}` })).toBeNull()
    }
  })

  it('names a live agent\'s role after the agent, links to it, and offers no Remove', async () => {
    renderSection({ getRoutes: vi.fn(async () => ROUTES_WITH_AGENTS) })
    await waitFor(() => expect(screen.getByTestId('route-agent_coder')).toBeTruthy())
    expect(rolesOnPage()).toEqual(['chat', 'scheduled', 'judge', 'coding', 'vision', 'agent_coder', 'agent_zed'])
    const coder = screen.getByTestId('route-agent_coder')
    const link = within(coder).getByRole('link', { name: 'Agent · coder' })
    expect(link.getAttribute('href')).toBe('/agents/coder')
    expect(coder.textContent).toContain('writes and reviews code in a sandbox')
    expect(coder.textContent).not.toContain('no agent by this name')
    expect(within(coder).queryByRole('button', { name: 'remove role agent_coder' })).toBeNull()
    // Its chain is editable like any other role's.
    expect(within(coder).getByLabelText('add to agent_coder')).toBeTruthy()
  })

  it('marks a role no agent owns, and Remove → confirm → deletes it and re-reads the list', async () => {
    const api = renderSection({ getRoutes: vi.fn(async () => ROUTES_WITH_AGENTS) })
    await waitFor(() => expect(screen.getByTestId('route-agent_zed')).toBeTruthy())
    const zed = screen.getByTestId('route-agent_zed')
    expect(zed.textContent).toContain('agent_zed')
    expect(zed.textContent).toContain('no agent by this name')
    // Nothing to edit: core refuses a PUT for a role whose agent is gone.
    expect(within(zed).queryByLabelText('add to agent_zed')).toBeNull()
    expect(api.getRoutes).toHaveBeenCalledTimes(1)

    fireEvent.click(within(zed).getByRole('button', { name: 'remove role agent_zed' }))
    expect(screen.getByText('Remove the chain for agent_zed? No agent has this name.')).toBeTruthy()
    expect(api.deleteRoute).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.deleteRoute).toHaveBeenCalledWith('agent_zed'))
    await waitFor(() => expect(api.getRoutes).toHaveBeenCalledTimes(2))
  })

  it('offers no Remove on any agent role while the agents list cannot be read, and says why', async () => {
    const api = renderSection({
      getRoutes: vi.fn(async () => ROUTES_WITH_AGENTS),
      listAgents: vi.fn(async () => { throw new Error('agents API not found (404)') }),
    })
    await waitFor(() => expect(screen.getByTestId('route-agent_zed')).toBeTruthy())
    for (const role of ['agent_coder', 'agent_zed']) {
      const el = screen.getByTestId(`route-${role}`)
      expect(el.textContent).toContain(role)
      expect(el.textContent).toContain('agent role')
      expect(el.textContent).toContain('could not read the agents list — agents API not found (404)')
      expect(el.textContent).not.toContain('no agent by this name')
      expect(within(el).queryByRole('button', { name: `remove role ${role}` })).toBeNull()
    }
    // The built-ins are untouched by the agents failure.
    expect(screen.getByTestId('route-chat').textContent).toContain('Chat')
    expect(api.deleteRoute).not.toHaveBeenCalled()
  })

  it('shows the server\'s reason inline when a Remove fails', async () => {
    const api = renderSection({
      getRoutes: vi.fn(async () => ROUTES_WITH_AGENTS),
      deleteRoute: vi.fn(async () => { throw new Error('no stored chain for agent_zed (404)') }),
    })
    await waitFor(() => expect(screen.getByTestId('route-agent_zed')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-agent_zed')).getByRole('button', { name: 'remove role agent_zed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.deleteRoute).toHaveBeenCalledWith('agent_zed'))
    await waitFor(() => expect(screen.getByTestId('route-agent_zed-remove-error').textContent).toContain('no stored chain for agent_zed (404)'))
    // The row stays: a failed removal is stated, never shown as done.
    expect(screen.getByTestId('route-agent_zed')).toBeTruthy()
    expect(api.getRoutes).toHaveBeenCalledTimes(1)
  })

  it('adds a fallback from the catalogue and saves the chain through the API', async () => {
    const api = renderSection()
    await waitFor(() => expect(screen.getByTestId('route-scheduled')).toBeTruthy())
    const scheduled = screen.getByTestId('route-scheduled')
    fireEvent.change(within(scheduled).getByLabelText('add to scheduled'), { target: { value: 'ollama:qwen3:8b' } })
    fireEvent.click(within(scheduled).getByRole('button', { name: 'add scheduled' }))
    expect(within(scheduled).getByTestId('route-scheduled-link-1').textContent).toContain('ollama:qwen3:8b')
    fireEvent.click(within(scheduled).getByRole('button', { name: /save/i }))
    await waitFor(() => expect(api.putRoute).toHaveBeenCalledWith('scheduled', ['ollama:qwen3:8b']))
  })

  it('lists a walled provider with its reason and lets the owner clear it', async () => {
    const api = renderSection()
    await waitFor(() => expect(screen.getByTestId('routing-walls')).toBeTruthy())
    expect(screen.getByTestId('routing-walls').textContent).toContain('openrouter refused (402): insufficient credits')
    fireEvent.click(screen.getByRole('button', { name: 'clear wall openrouter' }))
    await waitFor(() => expect(api.clearWall).toHaveBeenCalledWith('openrouter'))
  })
})
