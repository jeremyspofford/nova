import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { RoutingSection } from './RoutingSection'
import type { CatalogRow, RouteExplain, Routes } from '../../lib/api'

function row(id: string, kind: 'local' | 'cloud', installed?: boolean): CatalogRow {
  const [provider, ...rest] = id.split(':')
  return {
    id, provider, model: rest.join(':'), label: rest.join(':'), kind, installed,
    sources: [], facts: {}, capabilities: {}, suitability: {}, actions: [],
  }
}

const ROUTES: Routes = {
  roles: [
    { role: 'chat', chain: ['ollama:qwen3:8b'], reserved: false },
    { role: 'scheduled', chain: [], reserved: false },
    { role: 'judge', chain: [], reserved: false },
    { role: 'coding', chain: [], reserved: true },
    { role: 'vision', chain: [], reserved: true },
  ],
  walls: [{ provider: 'openrouter', walled_until: '2026-09-08T10:00:00Z', reason: 'openrouter refused (402): insufficient credits', status: 402, strikes: 1 }],
}
const EXPLAIN_CHAT: RouteExplain = {
  role: 'chat',
  chain: [
    { link: 1, id: 'openrouter:openai/gpt-x', verdict: 'walled', reason: 'openrouter refused (402): insufficient credits — walled for another 59 min' },
    { link: 2, id: 'ollama:qwen3:8b', verdict: 'runnable', reason: null },
  ],
  would_serve: { role: 'chat', link: 2, reason: 'fell back to link 2 (ollama:qwen3:8b) — openrouter:openai/gpt-x: openrouter refused (402)', served_by: 'ollama:qwen3:8b', standby: false },
  reason: 'fell back to link 2 (ollama:qwen3:8b) — openrouter:openai/gpt-x: openrouter refused (402)',
}

function renderSection(over: Partial<Record<'getRoutes' | 'putRoute' | 'explainRoute' | 'clearWall' | 'getCatalog', ReturnType<typeof vi.fn>>> = {}) {
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
    ...over,
  }
  render(<RoutingSection chatModel="openrouter:openai/gpt-x" api={api as never} />)
  return api
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
