import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { RoutingSection } from './RoutingSection'
import type { AgentSummary, CatalogRow, RouteExplain, Routes, SettingDef } from '../../lib/api'

function row(id: string, kind: 'local' | 'cloud', installed?: boolean): CatalogRow {
  const [provider, ...rest] = id.split(':')
  return {
    id, provider, model: rest.join(':'), label: rest.join(':'), kind, installed,
    sources: [], facts: {}, capabilities: {}, suitability: {}, actions: [],
  }
}

/** A decision model's row: the listing says it outputs decisions, and it is
 * offered no action (the gateway never offers one as the chat model). */
function decisionRow(id: string): CatalogRow {
  return { ...row(id, 'cloud'), suitability: { decisions: { value: true, basis: 'declared', source: 'provider-listing' } } }
}

// The gateway lists built-ins first (in its order), then stored roles by name.
const ROUTES: Routes = {
  roles: [
    { role: 'chat', chain: ['hub:qwen3:8b'], reserved: false, builtin: true, protocol: 'chat' },
    { role: 'scheduled', chain: [], reserved: false, builtin: true, protocol: 'chat' },
    { role: 'judge', chain: [], reserved: false, builtin: true, protocol: 'chat' },
    // The decision role: typed questions, never chat.
    { role: 'decisions', chain: [], reserved: false, builtin: true, protocol: 'systemone' },
    { role: 'coding', chain: [], reserved: true, builtin: true, protocol: 'chat' },
    { role: 'vision', chain: [], reserved: true, builtin: true, protocol: 'chat' },
  ],
  walls: [{ provider: 'openrouter', walled_until: '2026-09-08T10:00:00Z', reason: 'openrouter refused (402): insufficient credits', status: 402, strikes: 1 }],
}
// Two agent roles the gateway holds rows for: coder's agent is live, zed's is gone.
const ROUTES_WITH_AGENTS: Routes = {
  ...ROUTES,
  roles: [
    ...ROUTES.roles,
    { role: 'agent_coder', chain: ['cerebras:llama'], reserved: false, builtin: false },
    { role: 'agent_zed', chain: ['hub:qwen3:8b'], reserved: false, builtin: false },
  ],
}
const AGENTS: AgentSummary[] = [{ name: 'coder', purpose: 'writes and reviews code in a sandbox', role: 'agent_coder' }]
const EXPLAIN_CHAT: RouteExplain = {
  role: 'chat',
  chain: [
    { link: 1, id: 'openrouter:openai/gpt-x', verdict: 'walled', reason: 'openrouter refused (402): insufficient credits — walled for another 59 min' },
    { link: 2, id: 'hub:qwen3:8b', verdict: 'runnable', reason: null },
  ],
  would_serve: { role: 'chat', link: 2, reason: 'fell back to link 2 (hub:qwen3:8b) — openrouter:openai/gpt-x: openrouter refused (402)', served_by: 'hub:qwen3:8b', standby: false },
  reason: 'fell back to link 2 (hub:qwen3:8b) — openrouter:openai/gpt-x: openrouter refused (402)',
}

type ApiName = 'getRoutes' | 'putRoute' | 'putJevRouter' | 'explainRoute' | 'clearWall' | 'getCatalog' | 'deleteRoute' | 'listAgents' | 'putSetting'

function renderSection(
  over: Partial<Record<ApiName, ReturnType<typeof vi.fn>>> = {},
  props: Partial<{
    onChatModelChanged: (model: string) => void
    decisionSwitches: SettingDef[] | null
    onSettingChanged: (key: string, value: unknown) => void
  }> = {},
) {
  const api = {
    getRoutes: vi.fn(async () => ROUTES),
    putRoute: vi.fn(async (role: string, chain: string[]) => ({ role, chain })),
    putJevRouter: vi.fn(async (role: string, on: boolean) => ({ role, chain: [], router: { on, kept: null } })),
    explainRoute: vi.fn(async (role: string) => (role === 'chat' ? EXPLAIN_CHAT : { role, chain: [], would_serve: null, reason: 'no chain' })),
    clearWall: vi.fn(async () => ({ provider: 'openrouter', cleared: true })),
    getCatalog: vi.fn(async () => ({
      fetched_at: 't',
      sources: [],
      rows: [row('hub:qwen3:8b', 'local', true), row('library:qwen3:4b', 'local', false), row('openrouter:openai/gpt-x', 'cloud'), row('cerebras:llama', 'cloud')],
    })),
    deleteRoute: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => AGENTS),
    // PUT /api/v1/settings answers with what core stored.
    putSetting: vi.fn(async (key: string, value: boolean | string | number) => ({ key, value })),
    ...over,
  }
  render(<RoutingSection chatModel="openrouter:openai/gpt-x" api={api as never} onChatModelChanged={() => {}} {...props} />)
  return api
}

// The decision switches as core lists them (decision-role spec §6): local
// (alpha) ships off, cloud (beta) on, and each description is the notice.
const LOCAL_NOTICE =
  'A decision model on your own machine may answer before she replies. Off by default: on a GPU shared with your chat model, a local decision model often cannot answer within the 5 s budget; the step is then skipped and your message waits up to 5 s.'
const CLOUD_NOTICE =
  'A decision model at a cloud provider may answer before she replies. On by default: your message and its recalled notes go to the provider, at a small cost per message.'
function switches(local: boolean, cloud: boolean): SettingDef[] {
  return [
    { key: 'decisions.local', type: 'bool', default: false, description: LOCAL_NOTICE, value: local },
    { key: 'decisions.cloud', type: 'bool', default: true, description: CLOUD_NOTICE, value: cloud },
  ]
}
const KEV = 'dell-kev:kev-latest'
const JEV = 'openrouter:~typesafe/jev-latest'
const ROUTES_DECIDING: Routes = {
  ...ROUTES,
  roles: ROUTES.roles.map(r => (r.role === 'decisions' ? { ...r, chain: [KEV, JEV] } : r)),
}
const LOCAL_OFF = 'local decision models are switched off in Settings (alpha)'
const EXPLAIN_LOCAL_OFF: RouteExplain = {
  role: 'decisions',
  chain: [
    { link: 1, id: KEV, verdict: 'kind_off', reason: LOCAL_OFF, local: true },
    { link: 2, id: JEV, verdict: 'runnable', reason: null, local: false },
  ],
  would_serve: { role: 'decisions', link: 2, reason: `fell back to link 2 (${JEV}) — ${KEV}: ${LOCAL_OFF}`, served_by: JEV, standby: false },
  reason: `fell back to link 2 (${JEV}) — ${KEV}: ${LOCAL_OFF}`,
}
const EXPLAIN_EVERY_KIND: RouteExplain = {
  role: 'decisions',
  chain: [
    { link: 1, id: KEV, verdict: 'runnable', reason: null, local: true },
    { link: 2, id: JEV, verdict: 'runnable', reason: null, local: false },
  ],
  would_serve: { role: 'decisions', link: 1, reason: null, served_by: KEV, standby: false },
  reason: null,
}

/** The roles on the page, top to bottom, by their data-testid. */
function rolesOnPage(): string[] {
  return Array.from(screen.getByTestId('routing-section').querySelectorAll<HTMLElement>('[data-testid^="route-"]'))
    .map(el => el.dataset.testid ?? '')
    .filter(id => /^route-[^-]+$/.test(id) || /^route-agent_[^-]+$/.test(id))
    .map(id => id.slice('route-'.length))
}

// The switch applies to chat, scheduled and agent roles; the gateway says so per role.
const ROUTES_SWITCH: Routes = {
  ...ROUTES,
  roles: ROUTES.roles.map(r => ({ ...r, router: r.role === 'chat' || r.role === 'scheduled' ? { on: false, kept: null } : null })),
}
const ROUTER_ROW = row('openrouter:typesafe/jev-router', 'cloud')
function catalogWith(...rows: CatalogRow[]) {
  return vi.fn(async () => ({ fetched_at: 't', sources: [], rows }))
}

describe('RoutingSection', () => {
  it('shows every role, link 1 of chat as the current pick, and each link\'s live verdict', async () => {
    const api = renderSection()
    await waitFor(() => expect(screen.getByTestId('route-chat')).toBeTruthy())
    const chat = screen.getByTestId('route-chat')
    expect(within(chat).getByTestId('route-chat-link-1').textContent).toContain('openrouter:openai/gpt-x')
    expect(within(chat).getByTestId('route-chat-link-1').textContent).toContain('your current pick')
    expect(within(chat).getByTestId('route-chat-link-1').querySelector('[data-verdict]')?.getAttribute('data-verdict')).toBe('walled')
    expect(within(chat).getByTestId('route-chat-link-2').textContent).toContain('hub:qwen3:8b')
    expect(within(chat).getByTestId('route-chat-would-serve').textContent).toContain('hub:qwen3:8b would answer — fell back to link 2')
    expect(api.explainRoute).toHaveBeenCalledWith('chat', 'openrouter:openai/gpt-x')
    expect(screen.getByTestId('route-scheduled').textContent).toContain('uses the chat chain')
    expect(screen.getByTestId('route-coding').textContent).toContain('no user yet')
  })

  it('renders the roles the server returns, in the server\'s order, with the built-ins\' own words', async () => {
    // Not the canonical order: proves the page follows the response, not a list of its own.
    const byName = Object.fromEntries(ROUTES.roles.map(r => [r.role, r]))
    const order = ['chat', 'judge', 'decisions', 'scheduled', 'vision', 'coding']
    const shuffled: Routes = { ...ROUTES, roles: order.map(name => byName[name]) }
    renderSection({ getRoutes: vi.fn(async () => shuffled) })
    await waitFor(() => expect(screen.getByTestId('route-vision')).toBeTruthy())
    expect(rolesOnPage()).toEqual(order)
    expect(screen.getByTestId('route-judge').textContent).toContain('Quality judging')
    expect(screen.getByTestId('route-decisions').textContent).toContain('Decisions')
    expect(screen.getByTestId('route-vision').textContent).toContain('reserved — nothing routes here yet')
    for (const role of order) {
      expect(within(screen.getByTestId(`route-${role}`)).queryByRole('button', { name: `remove role ${role}` })).toBeNull()
    }
  })

  it('names a live agent\'s role after the agent, links to it, and offers no Remove', async () => {
    renderSection({ getRoutes: vi.fn(async () => ROUTES_WITH_AGENTS) })
    await waitFor(() => expect(screen.getByTestId('route-agent_coder')).toBeTruthy())
    expect(rolesOnPage()).toEqual(['chat', 'scheduled', 'judge', 'decisions', 'coding', 'vision', 'agent_coder', 'agent_zed'])
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
    fireEvent.change(within(scheduled).getByLabelText('add to scheduled'), { target: { value: 'hub:qwen3:8b' } })
    fireEvent.click(within(scheduled).getByRole('button', { name: 'add scheduled' }))
    expect(within(scheduled).getByTestId('route-scheduled-link-1').textContent).toContain('hub:qwen3:8b')
    fireEvent.click(within(scheduled).getByRole('button', { name: /save/i }))
    await waitFor(() => expect(api.putRoute).toHaveBeenCalledWith('scheduled', ['hub:qwen3:8b']))
  })

  it('a model on no machine yet is never offered as a link', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByTestId('route-scheduled')).toBeTruthy())
    const picker = within(screen.getByTestId('route-scheduled')).getByLabelText('add to scheduled') as HTMLSelectElement
    const offered = [...picker.options].map(o => o.value)
    expect(offered).toContain('hub:qwen3:8b')
    expect(offered).not.toContain('library:qwen3:4b')
  })

  it('words a switched-off machine and a link that could not be reached, naming no engine of its own', async () => {
    // S40 (ruling G4): the gateway judges a link on a machine the owner
    // switched off `switched_off`, and a link whose provider did not answer
    // the dial `unreachable` — for any provider, cloud or engine, so the
    // words name none. They used to say "ollama unreachable".
    const explain: RouteExplain = {
      role: 'chat',
      chain: [
        { link: 1, id: 'openrouter:openai/gpt-x', verdict: 'unreachable', reason: 'could not reach openrouter — ConnectError: connection refused' },
        { link: 2, id: 'hub:qwen3:8b', verdict: 'switched_off', reason: 'hub is switched off' },
      ],
      would_serve: null,
      reason: 'no link in the chat chain can run right now',
    }
    renderSection({ explainRoute: vi.fn(async (role: string) => (role === 'chat' ? explain : { role, chain: [], would_serve: null, reason: 'no chain' })) })
    await waitFor(() => expect(screen.getByTestId('route-chat-link-2').querySelector('[data-verdict]')).toBeTruthy())
    const chat = screen.getByTestId('route-chat')
    const badge = (n: number) => within(chat).getByTestId(`route-chat-link-${n}`).querySelector('[data-verdict]')
    expect(badge(1)?.getAttribute('data-verdict')).toBe('unreachable')
    expect(badge(1)?.textContent).toBe('could not be reached')
    expect(badge(1)?.getAttribute('title')).toBe('could not reach openrouter — ConnectError: connection refused')
    expect(badge(2)?.getAttribute('data-verdict')).toBe('switched_off')
    expect(badge(2)?.textContent).toBe('switched off')
    expect(badge(2)?.getAttribute('title')).toBe('hub is switched off')
    // The owner's choice, not a failure: never drawn in the failure colour.
    expect(badge(2)?.innerHTML).not.toContain('danger')
    expect(badge(1)?.innerHTML).toContain('danger')
    expect(chat.textContent).not.toContain('ollama')
  })

  it('lists a walled provider with its reason and lets the owner clear it', async () => {
    const api = renderSection()
    await waitFor(() => expect(screen.getByTestId('routing-walls')).toBeTruthy())
    expect(screen.getByTestId('routing-walls').textContent).toContain('openrouter refused (402): insufficient credits')
    fireEvent.click(screen.getByRole('button', { name: 'clear wall openrouter' }))
    await waitFor(() => expect(api.clearWall).toHaveBeenCalledWith('openrouter'))
  })

  it('shows the decision role in its own words and offers it decision models only', async () => {
    renderSection({
      getCatalog: vi.fn(async () => ({
        fetched_at: 't',
        sources: [],
        rows: [row('hub:qwen3:8b', 'local', true), row('cerebras:llama', 'cloud'), decisionRow('openrouter:~typesafe/jev-latest'), decisionRow('dell-kev:kev-latest')],
      })),
    })
    await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
    const decisions = screen.getByTestId('route-decisions')
    expect(decisions.textContent).toContain('a decision model answers typed questions before she replies')
    expect(decisions.textContent).toContain('no decision model — her turns run without one')
    expect(decisions.textContent).not.toContain('uses the chat chain')
    const offered = [...(within(decisions).getByLabelText('add to decisions') as HTMLSelectElement).options].map(o => o.value).filter(Boolean)
    expect(offered).toEqual(['openrouter:~typesafe/jev-latest', 'dell-kev:kev-latest'])
    // And never the other way round: a chat role is offered no decision model.
    const scheduled = [...(within(screen.getByTestId('route-scheduled')).getByLabelText('add to scheduled') as HTMLSelectElement).options].map(o => o.value)
    expect(scheduled).toContain('hub:qwen3:8b')
    expect(scheduled).not.toContain('openrouter:~typesafe/jev-latest')
    expect(scheduled).not.toContain('dell-kev:kev-latest')
  })

  it('saves a decision chain through the same API as any role', async () => {
    const api = renderSection({
      getCatalog: vi.fn(async () => ({ fetched_at: 't', sources: [], rows: [decisionRow('dell-kev:kev-latest'), decisionRow('openrouter:~typesafe/jev-latest')] })),
    })
    await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
    const decisions = screen.getByTestId('route-decisions')
    for (const id of ['dell-kev:kev-latest', 'openrouter:~typesafe/jev-latest']) {
      fireEvent.change(within(decisions).getByLabelText('add to decisions'), { target: { value: id } })
      fireEvent.click(within(decisions).getByRole('button', { name: 'add decisions' }))
    }
    fireEvent.click(within(decisions).getByRole('button', { name: /save/i }))
    await waitFor(() => expect(api.putRoute).toHaveBeenCalledWith('decisions', ['dell-kev:kev-latest', 'openrouter:~typesafe/jev-latest']))
  })

  it('words a link that cannot answer its role as that, not as a failure of the provider', async () => {
    const explain: RouteExplain = {
      role: 'decisions',
      chain: [{ link: 1, id: 'hub:qwen3:8b', verdict: 'wrong_protocol', reason: 'hub answers chat — this role needs typed questions' }],
      would_serve: null,
      reason: 'no model in the \'decisions\' chain can serve right now',
    }
    const routes: Routes = { ...ROUTES, roles: ROUTES.roles.map(r => (r.role === 'decisions' ? { ...r, chain: ['hub:qwen3:8b'] } : r)) }
    renderSection({
      getRoutes: vi.fn(async () => routes),
      explainRoute: vi.fn(async (role: string) => (role === 'decisions' ? explain : { role, chain: [], would_serve: null, reason: 'no chain' })),
    })
    await waitFor(() => expect(screen.getByTestId('route-decisions-link-1').querySelector('[data-verdict]')).toBeTruthy())
    const badge = screen.getByTestId('route-decisions-link-1').querySelector('[data-verdict]')
    expect(badge?.textContent).toBe('cannot answer this role')
    expect(badge?.getAttribute('title')).toBe('hub answers chat — this role needs typed questions')
  })

  it('switches Jev Router on with the link the catalogue lists, then re-reads the chains', async () => {
    const api = renderSection({ getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(row('hub:qwen3:8b', 'local', true), ROUTER_ROW) })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    const panel = screen.getByTestId('route-chat-router')
    expect(panel.textContent).toContain('balancing quality, speed and cost')
    expect(panel.textContent).toContain(
      'Switching on puts Jev Router in place of the first cloud model a chat turn reaches: the model picked in chat when that is a cloud model, otherwise the first cloud link after it. Local links keep their places.',
    )
    const toggle = within(panel).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    await waitFor(() => expect(api.putJevRouter).toHaveBeenCalledWith('chat', true, 'openrouter:typesafe/jev-router'))
    await waitFor(() => expect(api.getRoutes).toHaveBeenCalledTimes(2))
  })

  it('says what the switch took the place of, and switches off with no link', async () => {
    const on: Routes = { ...ROUTES_SWITCH, roles: ROUTES_SWITCH.roles.map(r => (r.role === 'scheduled' ? { ...r, chain: ['openrouter:typesafe/jev-router'], router: { on: true, kept: 'openrouter:openai/gpt-x' } } : r)) }
    // The kept link's provider (openrouter) is still among the catalogue's
    // sources, so the promise that it comes back holds.
    const api = renderSection({
      getRoutes: vi.fn(async () => on),
      getCatalog: vi.fn(async () => ({ fetched_at: 't', sources: [{ key: 'openrouter' }], rows: [ROUTER_ROW] })),
    })
    await waitFor(() => expect(screen.getByTestId('route-scheduled-router-kept')).toBeTruthy())
    expect(screen.getByTestId('route-scheduled-router-kept').textContent).toBe(
      'in place of openrouter:openai/gpt-x, which comes back when you switch it off',
    )
    fireEvent.click(within(screen.getByTestId('route-scheduled-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(api.putJevRouter).toHaveBeenCalledWith('scheduled', false, undefined))
  })

  it('says the kept link\'s provider is gone when the catalogue no longer lists it', async () => {
    const on: Routes = { ...ROUTES_SWITCH, roles: ROUTES_SWITCH.roles.map(r => (r.role === 'scheduled' ? { ...r, chain: ['openrouter:typesafe/jev-router'], router: { on: true, kept: 'openrouter:openai/gpt-x' } } : r)) }
    // catalogWith's sources are always [] — no provider is registered, so
    // the kept link's own provider (openrouter) is not among them.
    renderSection({ getRoutes: vi.fn(async () => on), getCatalog: catalogWith(ROUTER_ROW) })
    await waitFor(() => expect(screen.getByTestId('route-scheduled-router-kept')).toBeTruthy())
    expect(screen.getByTestId('route-scheduled-router-kept').textContent).toBe(
      'in place of openrouter:openai/gpt-x — its provider is gone, so switching off will not put it back',
    )
  })

  it('offers no switch where it does not apply', async () => {
    renderSection({ getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(ROUTER_ROW) })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    for (const role of ['judge', 'decisions', 'coding', 'vision']) {
      expect(screen.queryByTestId(`route-${role}-router`)).toBeNull()
    }
  })

  it('cannot switch on while no provider lists Jev Router, and says why', async () => {
    const api = renderSection({ getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(row('hub:qwen3:8b', 'local', true)) })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    const panel = screen.getByTestId('route-chat-router')
    const toggle = within(panel).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    // The whole string, not a substring: an unconditional suffix must fail this.
    expect(screen.getByTestId('route-chat-router-unavailable').textContent).toBe(
      'no provider lists typesafe/jev-router right now (OpenRouter serves it)',
    )
    fireEvent.click(toggle)
    expect(api.putJevRouter).not.toHaveBeenCalled()
  })

  it('names a catalogue source that failed to list, alongside the no-provider reason', async () => {
    renderSection({
      getRoutes: vi.fn(async () => ROUTES_SWITCH),
      getCatalog: vi.fn(async () => ({
        fetched_at: 't',
        sources: [{ key: 'openrouter', ok: false, note: 'rate limited (429)' }],
        rows: [],
      })),
    })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    expect(screen.getByTestId('route-chat-router-unavailable').textContent).toBe(
      'no provider lists typesafe/jev-router right now (OpenRouter serves it) — these model lists could not be read: openrouter (rate limited (429))',
    )
  })

  it('joins several failed catalogue sources with a comma', async () => {
    renderSection({
      getRoutes: vi.fn(async () => ROUTES_SWITCH),
      getCatalog: vi.fn(async () => ({
        fetched_at: 't',
        sources: [
          { key: 'openrouter', ok: false, note: 'rate limited (429)' },
          { key: 'cerebras', ok: false, note: 'timed out' },
        ],
        rows: [],
      })),
    })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    expect(screen.getByTestId('route-chat-router-unavailable').textContent).toBe(
      'no provider lists typesafe/jev-router right now (OpenRouter serves it) — these model lists could not be read: openrouter (rate limited (429)), cerebras (timed out)',
    )
  })

  it('shows a refused switch in the gateway\'s words and keeps what the page knew', async () => {
    const refusal = 'scheduled has no chain of its own — it walks the chat chain; switch Jev Router on for chat, or give scheduled its own chain first'
    const api = renderSection({
      getRoutes: vi.fn(async () => ROUTES_SWITCH),
      getCatalog: catalogWith(ROUTER_ROW),
      putJevRouter: vi.fn(async () => { throw new Error(refusal) }),
    })
    await waitFor(() => expect(screen.getByTestId('route-scheduled-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-scheduled-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(screen.getByTestId('route-scheduled-router-error').textContent).toBe(`could not switch — ${refusal}`))
    expect(api.getRoutes).toHaveBeenCalledTimes(1)
  })

  it('shows what the switch could not put back, in the gateway\'s words', async () => {
    const note = 'the link Jev Router replaced, openrouter:openai/gpt-old, names a provider that no longer exists, so it was not put back'
    renderSection({
      getRoutes: vi.fn(async () => ROUTES_SWITCH),
      getCatalog: catalogWith(ROUTER_ROW),
      putJevRouter: vi.fn(async (role: string, on: boolean) => ({ role, chain: [], router: { on, kept: null }, note })),
    })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(screen.getByTestId('route-chat-router-note').textContent).toBe(note))
  })

  it('tells its parent the chat model changed when the switch answer names one', async () => {
    const onChatModelChanged = vi.fn()
    renderSection(
      {
        getRoutes: vi.fn(async () => ROUTES_SWITCH),
        getCatalog: catalogWith(ROUTER_ROW),
        putJevRouter: vi.fn(async () => ({
          role: 'chat',
          chain: [],
          router: { on: true, kept: '' },
          chat_model: 'openrouter:typesafe/jev-router',
        })),
      },
      { onChatModelChanged },
    )
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(onChatModelChanged).toHaveBeenCalledWith('openrouter:typesafe/jev-router'))
  })

  it('tells its parent nothing when the switch answer names no chat model', async () => {
    const onChatModelChanged = vi.fn()
    const api = renderSection(
      { getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(ROUTER_ROW) },
      { onChatModelChanged },
    )
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(api.getRoutes).toHaveBeenCalledTimes(2))
    expect(onChatModelChanged).not.toHaveBeenCalled()
  })

  it('reloads chat\'s explanation with the model the switch just set, never a stale one still in flight', async () => {
    // A real parent (SettingsPage) re-renders with the new chatModel once
    // onChatModelChanged fires, which starts a SECOND reload racing the
    // click's own. Whichever started later must win, however they finish.
    const OLD_MODEL = 'openrouter:openai/gpt-x'
    const NEW_MODEL = 'openrouter:typesafe/jev-router'
    let resolveOld: (value: RouteExplain) => void = () => {}
    const oldExplain = new Promise<RouteExplain>(resolve => {
      resolveOld = resolve
    })
    const explainRoute = vi.fn(async (role: string, model?: string) => {
      if (role !== 'chat') return { role, chain: [], would_serve: null, reason: 'no chain' }
      if (model === OLD_MODEL) return oldExplain
      return {
        role: 'chat',
        chain: [{ link: 1, id: NEW_MODEL, verdict: 'runnable', reason: null }],
        would_serve: { role: 'chat', link: 1, reason: null, served_by: NEW_MODEL, standby: false },
        reason: null,
      }
    })
    const api = {
      getRoutes: vi.fn(async () => ROUTES_SWITCH),
      putRoute: vi.fn(async (role: string, chain: string[]) => ({ role, chain })),
      putJevRouter: vi.fn(async () => ({ role: 'chat', chain: [], router: { on: true, kept: '' }, chat_model: NEW_MODEL })),
      explainRoute,
      clearWall: vi.fn(async () => ({ provider: 'openrouter', cleared: true })),
      getCatalog: catalogWith(ROUTER_ROW),
      deleteRoute: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => AGENTS),
    }
    function Parent() {
      const [chatModel, setChatModel] = useState(OLD_MODEL)
      return <RoutingSection chatModel={chatModel} api={api as never} onChatModelChanged={setChatModel} />
    }
    render(<Parent />)
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(screen.getByTestId('route-chat-would-serve').textContent).toContain(NEW_MODEL))
    // The old, still-pending explanation finally lands — late — and must not
    // un-write the fresh one.
    resolveOld({
      role: 'chat',
      chain: [{ link: 1, id: OLD_MODEL, verdict: 'walled', reason: 'stale' }],
      would_serve: null,
      reason: 'old model still walled',
    })
    await new Promise(r => setTimeout(r, 20))
    expect(screen.getByTestId('route-chat-would-serve').textContent).toContain(NEW_MODEL)
  })

  it('says the switch was added after the local links when it kept nothing', async () => {
    const on: Routes = { ...ROUTES_SWITCH, roles: ROUTES_SWITCH.roles.map(r => (r.role === 'chat' ? { ...r, router: { on: true, kept: '' } } : r)) }
    renderSection({ getRoutes: vi.fn(async () => on), getCatalog: catalogWith(ROUTER_ROW) })
    await waitFor(() => expect(screen.getByTestId('route-chat-router-kept')).toBeTruthy())
    expect(screen.getByTestId('route-chat-router-kept').textContent).toBe('added after the local links; switching it off removes it')
  })

  it('disables the toggle while a switch is in flight', async () => {
    let resolvePut: (value: { role: string; chain: string[]; router: { on: boolean; kept: string | null } }) => void = () => {}
    const putJevRouter = vi.fn(
      () =>
        new Promise<{ role: string; chain: string[]; router: { on: boolean; kept: string | null } }>(resolve => {
          resolvePut = resolve
        }),
    )
    renderSection({ getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(ROUTER_ROW), putJevRouter })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    const toggle = within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.disabled).toBe(true))
    resolvePut({ role: 'chat', chain: [], router: { on: true, kept: null } })
    await waitFor(() => expect(toggle.disabled).toBe(false))
  })

  it('offers the switch on an agent role too', async () => {
    const withRouter: Routes = {
      ...ROUTES_WITH_AGENTS,
      roles: ROUTES_WITH_AGENTS.roles.map(r => (r.role === 'agent_coder' ? { ...r, router: { on: false, kept: null } } : r)),
    }
    const api = renderSection({ getRoutes: vi.fn(async () => withRouter), getCatalog: catalogWith(ROUTER_ROW) })
    await waitFor(() => expect(screen.getByTestId('route-agent_coder-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-agent_coder-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(api.putJevRouter).toHaveBeenCalledWith('agent_coder', true, 'openrouter:typesafe/jev-router'))
  })

  it('clears a stale refusal once a reload shows the role\'s router state actually changed', async () => {
    const refusal = 'scheduled has no chain of its own — it walks the chat chain; switch Jev Router on for chat, or give scheduled its own chain first'
    let reloaded = false
    const getRoutes = vi.fn(async () =>
      reloaded
        ? {
            ...ROUTES_SWITCH,
            roles: ROUTES_SWITCH.roles.map(r =>
              r.role === 'scheduled' ? { ...r, chain: ['openrouter:typesafe/jev-router'], router: { on: true, kept: '' } } : r,
            ),
          }
        : ROUTES_SWITCH,
    )
    renderSection({
      getRoutes,
      getCatalog: catalogWith(ROUTER_ROW),
      putJevRouter: vi.fn(async () => { throw new Error(refusal) }),
    })
    await waitFor(() => expect(screen.getByTestId('route-scheduled-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-scheduled-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(screen.getByTestId('route-scheduled-router-error')).toBeTruthy())
    reloaded = true
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => {
      const toggle = within(screen.getByTestId('route-scheduled-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
      expect(toggle.checked).toBe(true)
    })
    expect(screen.queryByTestId('route-scheduled-router-error')).toBeNull()
  })

  it('keeps the note when a later reload changes the router state', async () => {
    const note = 'the link Jev Router replaced, openrouter:openai/gpt-old, names a provider that no longer exists, so it was not put back'
    let reloaded = false
    const getRoutes = vi.fn(async () =>
      reloaded
        ? {
            ...ROUTES_SWITCH,
            roles: ROUTES_SWITCH.roles.map(r =>
              r.role === 'chat' ? { ...r, chain: ['openrouter:typesafe/jev-router'], router: { on: true, kept: '' } } : r,
            ),
          }
        : ROUTES_SWITCH,
    )
    renderSection({
      getRoutes,
      getCatalog: catalogWith(ROUTER_ROW),
      putJevRouter: vi.fn(async (role: string, on: boolean) => ({ role, chain: [], router: { on, kept: null }, note })),
    })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(screen.getByTestId('route-chat-router-note').textContent).toBe(note))
    // A later, unrelated reload changes this role's router state...
    reloaded = true
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => {
      const toggle = within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
      expect(toggle.checked).toBe(true)
    })
    // ...and the note, which is about that same original switch, must stay.
    expect(screen.getByTestId('route-chat-router-note').textContent).toBe(note)
  })

  it('reloads with the switch answer\'s own chat_model, even when nothing else changes it', async () => {
    const NEW_MODEL = 'openrouter:typesafe/jev-router'
    const explainRoute = vi.fn(async (role: string) => ({ role, chain: [], would_serve: null, reason: 'no chain' }))
    renderSection(
      {
        getRoutes: vi.fn(async () => ROUTES_SWITCH),
        getCatalog: catalogWith(ROUTER_ROW),
        putJevRouter: vi.fn(async () => ({ role: 'chat', chain: [], router: { on: true, kept: '' }, chat_model: NEW_MODEL })),
        explainRoute,
      },
      // A no-op onChatModelChanged: the parent never re-renders with a new
      // chatModel, so the click's OWN reload is the only reload there is.
      // This checks the reload's override (the answer's own chat_model) on
      // its own, apart from the race between two reloads it also settles.
      { onChatModelChanged: () => {} },
    )
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
    await waitFor(() => expect(explainRoute).toHaveBeenCalledWith('chat', NEW_MODEL))
  })

  it('still turns off when no catalogue row lists Jev Router any more', async () => {
    // A guard reduced to `!routerLink` would refuse this: turning OFF never
    // needed the link: only turning on does.
    const on: Routes = { ...ROUTES_SWITCH, roles: ROUTES_SWITCH.roles.map(r => (r.role === 'chat' ? { ...r, chain: ['openrouter:typesafe/jev-router'], router: { on: true, kept: 'openrouter:openai/gpt-x' } } : r)) }
    const api = renderSection({ getRoutes: vi.fn(async () => on), getCatalog: catalogWith(row('hub:qwen3:8b', 'local', true)) })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    const toggle = within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    await waitFor(() => expect(api.putJevRouter).toHaveBeenCalledWith('chat', false, undefined))
  })

  it('waits for the load that actually landed, not a superseded one, before clearing busy', async () => {
    let callCount = 0
    let resolveSecond: (value: Routes) => void = () => {}
    let resolveThird: (value: Routes) => void = () => {}
    const secondRoutes = new Promise<Routes>(resolve => {
      resolveSecond = resolve
    })
    const thirdRoutes = new Promise<Routes>(resolve => {
      resolveThird = resolve
    })
    const freshRoutes: Routes = { ...ROUTES_SWITCH, roles: ROUTES_SWITCH.roles.map(r => (r.role === 'chat' ? { ...r, router: { on: true, kept: '' } } : r)) }
    const getRoutes = vi.fn(async () => {
      callCount += 1
      if (callCount === 1) return ROUTES_SWITCH
      if (callCount === 2) return secondRoutes
      return thirdRoutes
    })
    const api = renderSection({
      getRoutes,
      getCatalog: catalogWith(ROUTER_ROW),
      putJevRouter: vi.fn(async () => ({ role: 'chat', chain: [], router: { on: true, kept: '' }, note: 'a note from the switch' })),
    })
    await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
    const toggle = within(screen.getByTestId('route-chat-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
    fireEvent.click(toggle)
    await waitFor(() => expect(getRoutes).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => expect(getRoutes).toHaveBeenCalledTimes(3))
    // The click's own (second) load finishes its own round trip and finds
    // itself superseded by Re-check's (third, still held) — it must not
    // clear busy or show the note until the load that actually landed does.
    resolveSecond(ROUTES_SWITCH)
    await new Promise(r => setTimeout(r, 20))
    expect(toggle.disabled).toBe(true)
    expect(screen.queryByTestId('route-chat-router-note')).toBeNull()
    resolveThird(freshRoutes)
    await waitFor(() => expect(toggle.disabled).toBe(false))
    expect(toggle.checked).toBe(true)
    expect(screen.getByTestId('route-chat-router-note').textContent).toBe('a note from the switch')
    expect(api.putJevRouter).toHaveBeenCalledTimes(1)
  })

  describe('the two decision switches (decision-role spec §6)', () => {
    it('sits in the decisions panel: each switch with its stage and core\'s notice, as core stored it', async () => {
      renderSection({ getRoutes: vi.fn(async () => ROUTES_DECIDING) }, { decisionSwitches: switches(false, true) })
      await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
      const panel = screen.getByTestId('route-decisions')
      const local = within(panel).getByTestId('decision-switch-decisions.local')
      const cloud = within(panel).getByTestId('decision-switch-decisions.cloud')
      expect((within(local).getByRole('switch', { name: 'Local decision model' }) as HTMLInputElement).checked).toBe(false)
      expect((within(cloud).getByRole('switch', { name: 'Cloud decision model' }) as HTMLInputElement).checked).toBe(true)
      expect(within(local).getByTestId('decision-switch-stage').textContent).toBe('alpha')
      expect(within(cloud).getByTestId('decision-switch-stage').textContent).toBe('beta')
      expect(within(local).getByTestId('decision-switch-notice').textContent).toBe(LOCAL_NOTICE)
      expect(within(cloud).getByTestId('decision-switch-notice').textContent).toBe(CLOUD_NOTICE)
      // Beside the decisions chain and nowhere else.
      for (const role of ['chat', 'scheduled', 'judge']) {
        expect(within(screen.getByTestId(`route-${role}`)).queryByRole('switch', { name: 'Local decision model' })).toBeNull()
      }
    })

    it('draws no switch on a core that does not list them', async () => {
      renderSection({}, { decisionSwitches: null })
      await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
      expect(screen.queryByRole('switch', { name: 'Local decision model' })).toBeNull()
      expect(screen.queryByRole('switch', { name: 'Cloud decision model' })).toBeNull()
    })

    it('writes the setting, moves only with what core stored, and reloads the decisions explanation', async () => {
      let allowed: 'cloud' | 'every' = 'cloud'
      const explainRoute = vi.fn(async (role: string) =>
        role === 'decisions'
          ? allowed === 'cloud' ? EXPLAIN_LOCAL_OFF : EXPLAIN_EVERY_KIND
          : { role, chain: [], would_serve: null, reason: 'no chain' },
      )
      const putSetting = vi.fn(async (key: string, value: boolean | string | number) => {
        allowed = 'every'
        return { key, value }
      })
      const onSettingChanged = vi.fn()
      const api = {
        getRoutes: vi.fn(async () => ROUTES_DECIDING),
        putRoute: vi.fn(),
        putJevRouter: vi.fn(),
        explainRoute,
        clearWall: vi.fn(),
        getCatalog: catalogWith(),
        deleteRoute: vi.fn(),
        listAgents: vi.fn(async () => AGENTS),
        putSetting,
      }
      function Parent() {
        const [defs, setDefs] = useState(switches(false, true))
        return (
          <RoutingSection
            chatModel=""
            api={api as never}
            onChatModelChanged={() => {}}
            decisionSwitches={defs}
            onSettingChanged={(key, value) => {
              onSettingChanged(key, value)
              setDefs(prev => prev.map(d => (d.key === key ? { ...d, value } : d)))
            }}
          />
        )
      }
      render(<Parent />)
      await waitFor(() => expect(screen.getByTestId('route-decisions-would-serve').textContent).toContain(`${JEV} would answer`))
      const badge = screen.getByTestId('route-decisions-link-1').querySelector('[data-verdict]')
      expect(badge?.getAttribute('data-verdict')).toBe('kind_off')
      const local = screen.getByRole('switch', { name: 'Local decision model' }) as HTMLInputElement
      fireEvent.click(local)
      await waitFor(() => expect(putSetting).toHaveBeenCalledWith('decisions.local', true))
      await waitFor(() => expect(local.checked).toBe(true))
      expect(onSettingChanged).toHaveBeenCalledWith('decisions.local', true)
      await waitFor(() => expect(screen.getByTestId('route-decisions-would-serve').textContent).toBe(`right now: ${KEV} would answer`))
      expect(explainRoute.mock.calls.filter(([role]) => role === 'decisions').length).toBe(2)
    })

    it('leaves a refused switch where it was and says why in core\'s words', async () => {
      const onSettingChanged = vi.fn()
      renderSection(
        { putSetting: vi.fn(async () => { throw new Error('setting decisions.cloud expects bool, got str') }) },
        { decisionSwitches: switches(false, true), onSettingChanged },
      )
      await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
      const cloud = screen.getByRole('switch', { name: 'Cloud decision model' }) as HTMLInputElement
      fireEvent.click(cloud)
      await waitFor(() =>
        expect(within(screen.getByTestId('decision-switch-decisions.cloud')).getByRole('alert').textContent).toBe(
          'could not switch — setting decisions.cloud expects bool, got str',
        ),
      )
      expect(cloud.checked).toBe(true)
      expect(onSettingChanged).not.toHaveBeenCalled()
    })

    it('never shows a write as done when the answer does not say what core stored', async () => {
      const onSettingChanged = vi.fn()
      renderSection({ putSetting: vi.fn(async () => ({})) }, { decisionSwitches: switches(false, true), onSettingChanged })
      await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
      fireEvent.click(screen.getByRole('switch', { name: 'Local decision model' }))
      await waitFor(() =>
        expect(within(screen.getByTestId('decision-switch-decisions.local')).getByRole('alert').textContent).toBe(
          'could not switch — the write of decisions.local did not say what core stored, so the switch is shown as it was; reload the page to read it',
        ),
      )
      expect(onSettingChanged).not.toHaveBeenCalled()
    })

    it('with both off, says the step is off and costs nothing', async () => {
      const explainRoute = vi.fn(async (role: string) =>
        role === 'decisions'
          ? {
              role,
              chain: [
                { link: 1, id: KEV, verdict: 'kind_off', reason: LOCAL_OFF },
                { link: 2, id: JEV, verdict: 'kind_off', reason: 'cloud decision models are switched off in Settings (beta)' },
              ],
              would_serve: null,
              reason: 'no model in the \'decisions\' chain can serve right now',
            }
          : { role, chain: [], would_serve: null, reason: 'no chain' },
      )
      renderSection({ getRoutes: vi.fn(async () => ROUTES_DECIDING), explainRoute }, { decisionSwitches: switches(false, false) })
      await waitFor(() => expect(screen.getByTestId('route-decisions-would-serve')).toBeTruthy())
      expect(screen.getByTestId('route-decisions-would-serve').textContent).toBe(
        'right now: the decision step is off — both decision models are switched off, so no decision model is asked and it costs nothing',
      )
      expect(screen.getByTestId('route-decisions').textContent).not.toContain('nothing could answer')
    })

    it('words a link whose kind is switched off as the owner\'s choice, never a failure', async () => {
      renderSection(
        { getRoutes: vi.fn(async () => ROUTES_DECIDING), explainRoute: vi.fn(async (role: string) => (role === 'decisions' ? EXPLAIN_LOCAL_OFF : { role, chain: [], would_serve: null, reason: 'no chain' })) },
        { decisionSwitches: switches(false, true) },
      )
      await waitFor(() => expect(screen.getByTestId('route-decisions-link-1').querySelector('[data-verdict]')).toBeTruthy())
      const badge = screen.getByTestId('route-decisions-link-1').querySelector('[data-verdict]')
      expect(badge?.textContent).toBe('switched off in Settings')
      expect(badge?.getAttribute('title')).toBe(LOCAL_OFF)
      expect(badge?.innerHTML).not.toContain('danger')
      expect(screen.getByTestId('route-decisions-would-serve').textContent).toBe(
        `right now: ${JEV} would answer — fell back to link 2 (${JEV}) — ${KEV}: ${LOCAL_OFF}`,
      )
    })
  })
})
