import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { SpendPage } from './SpendPage'
import type { SpendCap, SpendPrice, SpendReport } from '../../lib/api'

const REPORT: SpendReport = {
  window: 'month',
  since: '2026-09-01T00:00:00-06:00',
  until: '2026-09-08T04:00:00+00:00',
  timezone: 'America/Denver',
  totals: {
    usd: 3.5,
    usd_by_basis: { 'provider-reported': 3.0, 'curated-price': 0.5 },
    gpu_seconds: 750,
    calls: 14,
    unmetered: 2,
    refusals: 1,
    probes: 3,
    ledger_write_failures: 0,
    month_usd: 3.5,
    month_cap_usd: 25,
    in_flight_note: 'caps are checked against recorded spend; calls in flight are not yet counted',
  },
  by_provider: [
    { provider: 'openrouter', local: false, usd: 3.0, calls: 4, unmetered: 2, refusals: 1, gpu_seconds: null, month_usd: 3.0, cap_usd: 10, remaining_usd: 7 },
    { provider: 'anthropic', local: false, usd: 0.5, calls: 1, unmetered: 0, refusals: 0, gpu_seconds: null, month_usd: 0.5, cap_usd: null, remaining_usd: null },
    { provider: 'ollama', local: true, usd: 0, calls: 9, unmetered: 0, refusals: 0, gpu_seconds: 750, month_usd: null, cap_usd: null, remaining_usd: null },
  ],
  by_model: [
    { key: 'openrouter:openai/gpt-x', local: false, usd: 3.0, calls: 4, unmetered: 2, prompt_tokens: 12000, completion_tokens: 3000, gpu_seconds: 0 },
    { key: 'ollama:qwen3:8b', local: true, usd: 0, calls: 9, unmetered: 0, prompt_tokens: 9000, completion_tokens: 4000, gpu_seconds: 750 },
  ],
  by_purpose: [
    { key: 'chat', local: false, usd: 3.0, calls: 10, unmetered: 2, prompt_tokens: 0, completion_tokens: 0, gpu_seconds: 0 },
    { key: 'judge', local: false, usd: 0.5, calls: 4, unmetered: 0, prompt_tokens: 0, completion_tokens: 0, gpu_seconds: 0 },
  ],
  by_role: [],
  by_person: [
    { key: 'p1', local: false, usd: 3.5, calls: 14, unmetered: 2, prompt_tokens: 0, completion_tokens: 0, gpu_seconds: 0, person: { name: 'jeremy', role: 'owner' } },
    { key: 'p2', local: false, usd: 0, calls: 1, unmetered: 0, prompt_tokens: 0, completion_tokens: 0, gpu_seconds: 0, person: { name: '(no longer exists)', role: null } },
  ],
  by_day: [
    {
      day: '2026-09-02',
      usd: 2.0,
      calls: 5,
      gpu_seconds: 0,
      models: [
        { key: 'openrouter:openai/gpt-x', local: false, usd: 1.5, calls: 2, gpu_seconds: 0 },
        { key: 'anthropic:claude-opus-5', local: false, usd: 0.5, calls: 1, gpu_seconds: 0 },
        { key: 'ollama:qwen3:8b', local: true, usd: 0, calls: 2, gpu_seconds: 0 },
      ],
    },
    {
      day: '2026-09-05',
      usd: 1.5,
      calls: 9,
      gpu_seconds: 750,
      models: [
        { key: 'openrouter:openai/gpt-x', local: false, usd: 1.5, calls: 2, gpu_seconds: 0 },
        { key: 'ollama:qwen3:8b', local: true, usd: 0, calls: 7, gpu_seconds: 750 },
      ],
    },
  ],
  unpriced: [{ provider: 'openrouter', model: 'gpt-free', calls: 1 }],
  recent_refusals: [{ at: '2026-09-07T10:00:00Z', provider: 'openrouter', model: 'gpt-x', status: 402, error: 'insufficient credits', purpose: 'chat' }],
  caps: { '*': 25, openrouter: 10 },
}
const CAPS: SpendCap[] = [
  { provider: '*', monthly_usd: 25, spent_usd: 3.5, remaining_usd: 21.5 },
  { provider: 'openrouter', monthly_usd: 10, spent_usd: 3.0, remaining_usd: 7 },
]
const PRICES: SpendPrice[] = [
  { provider: 'anthropic', model: 'claude-opus-5', basis: 'curated', prompt_usd_per_token: 5e-6, completion_usd_per_token: 2.5e-5, cache_read_multiplier: 0.1, cache_write_multiplier: 1.25, verified_at: '2026-09-08T00:00:00Z', source: 'file' },
  { provider: 'openrouter', model: 'gpt-free', basis: 'owner', prompt_usd_per_token: 1e-6, completion_usd_per_token: 2e-6, cache_read_multiplier: null, cache_write_multiplier: null, verified_at: '2026-09-08T00:00:00Z', source: 'entered by the owner' },
]

function renderPage(over: Partial<Record<'getSpend' | 'getSpendCaps' | 'putSpendCap' | 'getSpendPrices' | 'putOwnerPrice' | 'deleteOwnerPrice', ReturnType<typeof vi.fn>>> = {}) {
  const api = {
    getSpend: vi.fn(async () => REPORT),
    getSpendCaps: vi.fn(async () => ({ caps: CAPS, month_since: '2026-09-01T00:00:00-06:00', timezone: 'America/Denver' })),
    putSpendCap: vi.fn(async (provider: string, monthly_usd: number | null) => ({ provider, monthly_usd })),
    getSpendPrices: vi.fn(async () => ({ prices: PRICES })),
    putOwnerPrice: vi.fn(async () => ({ provider: 'x', model: 'y', basis: 'owner' as const })),
    deleteOwnerPrice: vi.fn(async () => ({ removed: true })),
    ...over,
  }
  render(<SpendPage api={api} />)
  return api
}

describe('SpendPage', () => {
  it('shows the totals with their bases, GPU time as its own unit, and names what the totals leave out', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-tiles')).toBeTruthy())
    const tiles = screen.getByTestId('spend-tiles').textContent ?? ''
    expect(tiles).toContain('$3.50')
    expect(tiles).toContain('$3.50 / $25.00')
    expect(tiles).toContain('12.5 min')
    const gaps = screen.getByTestId('spend-gaps').textContent ?? ''
    expect(gaps).toContain('2 call(s) were unmetered')
    expect(gaps).toContain('openrouter:gpt-free (1)')
    expect(gaps).toContain('1 call(s) were refused')
    expect(screen.getByText(/calls in flight are not yet counted/)).toBeTruthy()
  })

  it('draws a bar per day, stacked by model with a key, in dollars by default and calls on demand', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-days')).toBeTruthy())
    expect(screen.getByTestId('spend-day-2026-09-02').style.height).toBe('100%')
    expect(screen.getByTestId('spend-day-2026-09-05').style.height).toBe('75%')
    expect(screen.getByTestId('spend-day-2026-09-03').style.height).toBe('0%')
    // Dollars: the two priced models are segments; the local one has none.
    const seg = screen.getByTestId('spend-day-2026-09-02-openrouter:openai/gpt-x')
    expect(seg.style.height).toBe('75%')
    expect(screen.getByTestId('spend-day-2026-09-02-anthropic:claude-opus-5').style.height).toBe('25%')
    expect(screen.queryByTestId('spend-day-2026-09-02-ollama:qwen3:8b')).toBeNull()
    // The key: most used first, each with its colour; the local model says "no dollars".
    const key = screen.getByTestId('spend-key')
    const entries = Array.from(key.querySelectorAll('li[data-testid^="spend-key-"]')).map(li => li.getAttribute('data-testid'))
    expect(entries).toEqual(['spend-key-openrouter:openai/gpt-x', 'spend-key-anthropic:claude-opus-5', 'spend-key-ollama:qwen3:8b'])
    expect(screen.getByTestId('spend-key-ollama:qwen3:8b').textContent).toContain('local, no dollars')
    const gptColour = seg.className
    expect(screen.getByTestId('spend-key-openrouter:openai/gpt-x').querySelector('span')?.className).toContain(gptColour.split(' ').pop() ?? '')
    // Calls: the local model appears, and the tallest day is the one with more calls.
    fireEvent.click(screen.getByRole('button', { name: 'Calls' }))
    expect(screen.getByTestId('spend-day-2026-09-05').style.height).toBe('100%')
    expect(screen.getByTestId('spend-day-2026-09-05-ollama:qwen3:8b').style.height).toBe(`${(7 / 9) * 100}%`)
    expect(screen.getByTestId('spend-key-ollama:qwen3:8b').textContent).toContain('9 calls')
  })

  it('a provider card shows month vs cap and saves a new cap through the API', async () => {
    const api = renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-provider-openrouter')).toBeTruthy())
    const card = screen.getByTestId('spend-provider-openrouter')
    expect(card.textContent).toContain('$3.00 of $10.00 this month')
    expect(card.textContent).toContain('2 unmetered')
    expect(screen.getByTestId('spend-provider-ollama').textContent).toContain('12.5 min of GPU time over 9 calls — not money')
    fireEvent.change(within(card).getByLabelText('monthly cap openrouter'), { target: { value: '20' } })
    fireEvent.click(within(card).getByRole('button', { name: /save/i }))
    await waitFor(() => expect(api.putSpendCap).toHaveBeenCalledWith('openrouter', 20))
    await waitFor(() => expect(api.getSpend).toHaveBeenCalledTimes(2))
  })

  it('rollups by model, purpose and person read the server\'s words, local rows in minutes', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-by-model')).toBeTruthy())
    const models = screen.getByTestId('spend-by-model').textContent ?? ''
    expect(models).toContain('openrouter:openai/gpt-x')
    expect(models).toContain('$3.0000')
    expect(models).toContain('12.5 min local')
    expect(models).toContain('4 (2 unmetered)')
    expect(screen.getByTestId('spend-by-purpose').textContent).toContain('Quality judging')
    const people = screen.getByTestId('spend-by-person').textContent ?? ''
    expect(people).toContain('jeremy')
    expect(people).toContain('(no longer exists)')
    expect(screen.getByText(/insufficient credits/)).toBeTruthy()
  })

  it('an owner price is entered per million tokens and stored per token; a stored one can be removed', async () => {
    const api = renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-prices')).toBeTruthy())
    expect(screen.getByLabelText('price target')).toHaveProperty('value', 'openrouter:gpt-free')
    fireEvent.change(screen.getByLabelText('price per million prompt tokens'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByLabelText('price per million completion tokens'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'save price' }))
    await waitFor(() => expect(api.putOwnerPrice).toHaveBeenCalledWith('openrouter', 'gpt-free', 1.5e-6, 6e-6))
    fireEvent.click(screen.getByRole('button', { name: 'remove price openrouter:gpt-free' }))
    await waitFor(() => expect(api.deleteOwnerPrice).toHaveBeenCalledWith('openrouter', 'gpt-free'))
  })

  it('a failed load states the reason', async () => {
    renderPage({ getSpend: vi.fn(async () => { throw new Error('the gateway timed out') }) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('the gateway timed out'))
  })
})
