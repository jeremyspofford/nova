import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { SpendPage } from './SpendPage'
import { MODEL_PALETTE, usd } from './spendFormat'
import type { SpendCap, SpendPrice, SpendReport } from '../../lib/api'
import { modelName } from '../../lib/modelFormat'

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
    { provider: 'hub', local: true, usd: 0, calls: 9, unmetered: 0, refusals: 0, gpu_seconds: 750, month_usd: null, cap_usd: null, remaining_usd: null },
  ],
  by_model: [
    { key: 'openrouter:openai/gpt-x', local: false, usd: 3.0, calls: 4, unmetered: 2, prompt_tokens: 12000, completion_tokens: 3000, gpu_seconds: 0 },
    { key: 'hub:qwen3:8b', local: true, usd: 0, calls: 9, unmetered: 0, prompt_tokens: 9000, completion_tokens: 4000, gpu_seconds: 750 },
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
        { key: 'hub:qwen3:8b', local: true, usd: 0, calls: 2, gpu_seconds: 0 },
      ],
    },
    {
      day: '2026-09-05',
      usd: 1.5,
      calls: 9,
      gpu_seconds: 750,
      models: [
        { key: 'openrouter:openai/gpt-x', local: false, usd: 1.5, calls: 2, gpu_seconds: 0 },
        { key: 'hub:qwen3:8b', local: true, usd: 0, calls: 7, gpu_seconds: 750 },
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
    expect(gaps).toContain('2 calls were unmetered') // T21: words, not call(s)
    expect(gaps).toContain('openrouter:gpt-free (1)')
    expect(gaps).toContain('1 call was refused')
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
    expect(screen.queryByTestId('spend-day-2026-09-02-hub:qwen3:8b')).toBeNull()
    // The key: most used first, each with its colour; the local model says "no dollars".
    const key = screen.getByTestId('spend-key')
    const entries = Array.from(key.querySelectorAll('li[data-testid^="spend-key-"]')).map(li => li.getAttribute('data-testid'))
    expect(entries).toEqual(['spend-key-openrouter:openai/gpt-x', 'spend-key-anthropic:claude-opus-5', 'spend-key-hub:qwen3:8b'])
    expect(screen.getByTestId('spend-key-hub:qwen3:8b').textContent).toContain('local, no dollars')
    const gptColour = seg.className
    expect(screen.getByTestId('spend-key-openrouter:openai/gpt-x').querySelector('span')?.className).toContain(gptColour.split(' ').pop() ?? '')
    // Calls: the local model appears, and the tallest day is the one with more calls.
    fireEvent.click(screen.getByRole('button', { name: 'Calls' }))
    expect(screen.getByTestId('spend-day-2026-09-05').style.height).toBe('100%')
    expect(screen.getByTestId('spend-day-2026-09-05-hub:qwen3:8b').style.height).toBe(`${(7 / 9) * 100}%`)
    expect(screen.getByTestId('spend-key-hub:qwen3:8b').textContent).toContain('9 calls')
  })

  it('a provider card shows month vs cap and saves a new cap through the API', async () => {
    const api = renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-provider-openrouter')).toBeTruthy())
    const card = screen.getByTestId('spend-provider-openrouter')
    expect(card.textContent).toContain('$3.00 of $10.00 this month')
    expect(card.textContent).toContain('2 unmetered')
    expect(screen.getByTestId('spend-provider-hub').textContent).toContain('12.5 min of GPU time over 9 calls — not money')
    fireEvent.change(within(card).getByLabelText('monthly cap openrouter'), { target: { value: '20' } })
    fireEvent.click(within(card).getByRole('button', { name: /save/i }))
    await waitFor(() => expect(api.putSpendCap).toHaveBeenCalledWith('openrouter', 20))
    await waitFor(() => expect(api.getSpend).toHaveBeenCalledTimes(2))
  })

  it('a month spanning the rename shows the old rows under their old name, both local', async () => {
    // usage_events keep provider='ollama' for every call served before S40:
    // it was true when written, and a measurement row never changes meaning.
    const report = { ...REPORT, by_provider: [
      ...REPORT.by_provider.filter(p => p.provider !== 'hub'),
      { provider: 'ollama', local: true, usd: 0, calls: 5, unmetered: 0, refusals: 0, gpu_seconds: 300, month_usd: null, cap_usd: null, remaining_usd: null },
      { provider: 'hub', local: true, usd: 0, calls: 4, unmetered: 0, refusals: 0, gpu_seconds: 450, month_usd: null, cap_usd: null, remaining_usd: null },
    ] }
    renderPage({ getSpend: vi.fn(async () => report) })
    await waitFor(() => expect(screen.getByTestId('spend-provider-hub')).toBeTruthy())
    expect(screen.getByTestId('spend-provider-ollama').textContent).toContain('5.0 min of GPU time over 5 calls — not money')
    expect(screen.getByTestId('spend-provider-hub').textContent).toContain('7.5 min of GPU time over 4 calls — not money')
  })

  it('rollups by model, purpose and person read the server\'s words, local rows in minutes', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-by-model')).toBeTruthy())
    const models = screen.getByTestId('spend-by-model').textContent ?? ''
    expect(models).toContain('openrouter:openai/gpt-x')
    expect(models).toContain('$3.00') // T21: two decimals for display
    expect(models).not.toContain('$3.0000')
    expect(models).toContain('12.5 min local')
    expect(models).toContain('4 (2 unmetered)')
    expect(screen.getByTestId('spend-by-purpose').textContent).toContain('Quality judging')
    const people = screen.getByTestId('spend-by-person').textContent ?? ''
    expect(people).toContain('jeremy')
    expect(people).toContain('(no longer exists)')
    // The refusal reads by its cause (R12); the server's words are its title.
    expect(screen.getByText('out of credits').getAttribute('title')).toBe('insufficient credits')
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

describe('SpendPage — recent refusals (R12)', () => {
  it('folds repeats into one line per provider, cause and purpose, with the count and the full message on hover', async () => {
    const dell = (model: string, at: string) => ({
      at, provider: 'dell', model, status: 502, purpose: 'review_commitments',
      error: 'could not reach dell at http://100.122.40.93:11435/v1 — ConnectTimeout',
    })
    renderPage({
      getSpend: vi.fn(async () => ({
        ...REPORT,
        recent_refusals: [
          dell('qwen3:8b', '2026-09-07T10:00:00Z'),
          dell('qwen3.8:27b', '2026-09-07T09:00:00Z'),
          dell('qwen3:8b', '2026-09-07T08:00:00Z'),
        ],
      })),
    })
    const list = await screen.findByTestId('refusal-groups')
    const items = list.querySelectorAll('li')
    expect(items).toHaveLength(1)
    expect(items[0].textContent).toContain('unreachable')
    expect(items[0].textContent).toContain('3 times')
    expect(items[0].textContent).toContain('qwen3:8b, qwen3.8:27b')
    expect(items[0].textContent).not.toContain('100.122.40.93')
    expect(within(items[0] as HTMLElement).getByText('unreachable').getAttribute('title')).toContain('ConnectTimeout')
  })
})

describe('SpendPage — T21: dollars at two decimals, calls in words', () => {
  // A dollar figure with three or more decimals ("$3.0000", "$0.0042").
  const LONG_DOLLARS = /\$[\d,]+\.\d{3,}/
  // Each element's OWN text (its direct text nodes joined), one string per
  // element. Never a container's textContent: that glues adjacent cells with
  // no separator, so a "$3.00" Cost cell beside a "4" Calls cell reads
  // "$3.004". Joining an element's own nodes still catches a "$" literal and
  // its figure split into two nodes inside one element.
  const ownTexts = (root: Element): string[] =>
    [root, ...Array.from(root.querySelectorAll('*'))]
      .map(el =>
        Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent ?? '')
          .join(''),
      )
      .filter(t => t.includes('$'))

  it('C2: no visible dollar figure has more than two decimals; the day-bar titles keep four', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-by-model')).toBeTruthy())
    const shown = ownTexts(document.body)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.filter(t => LONG_DOLLARS.test(t))).toEqual([])
    // hover text keeps the precision
    const bar = screen.getByTestId('spend-day-2026-09-02').parentElement!
    expect(bar.getAttribute('title')).toContain('$2.0000')
  })

  it('C3: the key total, each provider\'s window spend and the rollup Cost read usd(v)', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-by-model')).toBeTruthy())
    const keyText = screen.getByTestId('spend-key-openrouter:openai/gpt-x').textContent ?? ''
    expect(keyText).toContain('$3.00')
    expect(keyText).not.toContain('$3.0000')
    const openrouter = screen.getByTestId('spend-provider-openrouter').textContent ?? ''
    expect(openrouter).toContain('$3.00 in this window')
    expect(openrouter).not.toContain('$3.0000')
    expect(screen.getByTestId('spend-provider-anthropic').textContent).toContain('$0.50 in this window')
    const byModel = screen.getByTestId('spend-by-model')
    expect(byModel.textContent ?? '').toContain(usd(3.0))
    const cells = ownTexts(byModel)
    expect(cells).toContain(usd(3.0))
    expect(cells.filter(t => LONG_DOLLARS.test(t))).toEqual([])
  })

  it('C3/C4: a sub-cent provider reads "< $0.01 in this window" with its exact figure on hover', async () => {
    const report = {
      ...REPORT,
      by_provider: REPORT.by_provider.map(p => (p.provider === 'anthropic' ? { ...p, usd: 0.0042 } : p)),
    }
    renderPage({ getSpend: vi.fn(async () => report) })
    await waitFor(() => expect(screen.getByTestId('spend-provider-anthropic')).toBeTruthy())
    const card = screen.getByTestId('spend-provider-anthropic')
    expect(card.textContent).toContain('< $0.01 in this window')
    expect(card.textContent).not.toContain('$0.0042')
    const shown = within(card).getByText(/< \$0\.01/)
    let el: HTMLElement | null = shown
    let title: string | null = null
    while (el && card.contains(el) && title === null) {
      if (el.getAttribute('title')?.includes('$0.0042')) title = el.getAttribute('title')
      el = el.parentElement
    }
    expect(title).toContain(usd(0.0042, 4))
  })

  it('C4 (coverage): every "< $0.01" in a provider card, the model key and the rollup keeps its exact figure on hover', async () => {
    const report = {
      ...REPORT,
      by_provider: REPORT.by_provider.map(p => (p.provider === 'anthropic' ? { ...p, usd: 0.0042, month_usd: 0.0042 } : p)),
      by_model: REPORT.by_model.map(m => (m.local ? m : { ...m, usd: 0.0042 })),
      by_day: REPORT.by_day.map(d => ({ ...d, models: d.models.map(m => (m.local ? m : { ...m, usd: 0.0021 })) })),
    }
    renderPage({ getSpend: vi.fn(async () => report) })
    await waitFor(() => expect(screen.getByTestId('spend-by-model')).toBeTruthy())
    const roots = [
      screen.getByTestId('spend-provider-anthropic'),
      screen.getByTestId('spend-key-openrouter:openai/gpt-x'),
      screen.getByTestId('spend-by-model'),
    ]
    let seen = 0
    const bare: string[] = []
    for (const root of roots) {
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? '').join('')
        if (!own.includes('< $0.01')) continue
        seen += 1
        let at: Element | null = el
        let title: string | null = null
        while (at && root.contains(at) && title === null) {
          if (at.getAttribute('title')?.includes(usd(0.0042, 4))) title = at.getAttribute('title')
          at = at.parentElement
        }
        if (title === null) bare.push(own)
      }
    }
    // every "< $0.01" found an ancestor title with the exact figure
    expect(bare).toEqual([])
    // the card's window figure and month figure, the key total, the rollup Cost
    expect(seen).toBeGreaterThanOrEqual(4)
  })

  it('C4 (coverage): a sub-cent Spent or This-month tile keeps its exact figure on hover', async () => {
    const report = { ...REPORT, totals: { ...REPORT.totals, usd: 0.0042, month_usd: 0.0031 } }
    renderPage({ getSpend: vi.fn(async () => report) })
    await waitFor(() => expect(screen.getByTestId('spend-tiles')).toBeTruthy())
    const tiles = screen.getByTestId('spend-tiles')
    const shown = Array.from(tiles.querySelectorAll('*')).filter(el =>
      Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes('< $0.01')),
    )
    // both money tiles round to "< $0.01" ...
    expect(shown).toHaveLength(2)
    // ... and each carries its own exact figure in a title
    const titles = shown.map(el => el.closest('[title]')?.getAttribute('title') ?? '')
    expect(titles[0]).toContain(usd(0.0042, 4))
    expect(titles[1]).toContain(usd(0.0031, 4))
  })

  it('C6: the gaps read in words — "N calls were", "1 call was", never call(s)', async () => {
    const report = { ...REPORT, totals: { ...REPORT.totals, ledger_write_failures: 1 } }
    renderPage({ getSpend: vi.fn(async () => report) })
    await waitFor(() => expect(screen.getByTestId('spend-gaps')).toBeTruthy())
    const gaps = screen.getByTestId('spend-gaps').textContent ?? ''
    expect(gaps).toContain('2 calls were unmetered')
    expect(gaps).toContain('1 call was refused')
    expect(gaps).toContain('1 call since the gateway started could not be recorded at all')
    expect(gaps).not.toContain('call(s)')
  })

  it('C6: a single call is "1 call" in every text and title on the page', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-provider-anthropic')).toBeTruthy())
    expect(screen.getByTestId('spend-provider-anthropic').textContent).toContain('· 1 call')
    const page = document.body
    const titles = Array.from(page.querySelectorAll('[title]')).map(e => e.getAttribute('title') ?? '')
    for (const text of [page.textContent ?? '', ...titles]) {
      expect(text).not.toContain('call(s)')
      expect(text).not.toMatch(/\b1 calls\b/)
    }
    // the per-model segment titles name one call in the singular
    fireEvent.click(screen.getByRole('button', { name: 'Calls' }))
    expect(screen.getByTestId('spend-day-2026-09-02-anthropic:claude-opus-5').getAttribute('title')).toContain('1 call')
    expect(screen.getByTestId('spend-day-2026-09-02-anthropic:claude-opus-5').getAttribute('title')).not.toMatch(/\b1 calls\b/)
  })
})

describe('SpendPage — T22: the chart paints with the fixed model palette', () => {
  // A theme-following colour class: the accent and the status tiers (which
  // all read teal-ish under Nova) and stock teal.
  const THEMED = /(^|\s)bg-(accent|info|success|warning|danger|teal-\d+)(\/\d+)?(?=\s|$)/
  const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/)

  it.each(['Dollars', 'Calls'])(
    'C4 (%s): each model\'s key swatch and bar segments carry MODEL_PALETTE[i] in key order; nothing in the chart is a theme colour',
    async measure => {
      renderPage()
      await waitFor(() => expect(screen.getByTestId('spend-key')).toBeTruthy())
      if (measure === 'Calls') fireEvent.click(screen.getByRole('button', { name: 'Calls' }))
      const items = Array.from(screen.getByTestId('spend-key').querySelectorAll('li[data-testid^="spend-key-"]'))
      expect(items.length).toBe(3)
      items.forEach((li, i) => {
        const model = li.getAttribute('data-testid')!.slice('spend-key-'.length)
        const swatch = li.querySelector('span[aria-hidden]')!
        expect(classes(swatch), `${model} swatch`).toContain(MODEL_PALETTE[i])
        const segments = Array.from(document.querySelectorAll('[data-model]')).filter(el => el.getAttribute('data-model') === model)
        // in Dollars a local model draws no segment (it cost nothing)
        if (measure === 'Calls' || model !== 'hub:qwen3:8b') expect(segments.length, `${model} segments`).toBeGreaterThan(0)
        for (const seg of segments) expect(classes(seg), `${model} segment`).toContain(MODEL_PALETTE[i])
      })
      const painted = [
        ...Array.from(screen.getByTestId('spend-days').querySelectorAll('*')),
        ...Array.from(screen.getByTestId('spend-key').querySelectorAll('*')),
      ]
      const themed = painted.map(el => el.getAttribute('class') ?? '').filter(c => THEMED.test(c))
      expect(themed).toEqual([])
    },
  )
})

// T31 (verification-2-7, VISUAL 4): the Spend model key showed raw mono ids
// ("openrouter:anthropic/claude-sonnet-4.5"). It names each model through
// lib/modelFormat in body text, with the full id as the name's title; two
// models whose names collide still read apart.
describe('SpendPage — T31: the model key reads model names', () => {
  const keyNames = () =>
    Array.from(screen.getByTestId('spend-key').querySelectorAll('li[data-testid^="spend-key-"]')).map(li => ({
      id: li.getAttribute('data-testid')!.slice('spend-key-'.length),
      li,
      name: li.querySelector('[data-testid="spend-key-name"]'),
    }))

  it('C3: each key entry shows modelName(id) with the full id as its title, no mono, no provider prefix', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('spend-key')).toBeTruthy())
    const entries = keyNames()
    expect(entries.map(e => e.id)).toEqual(['openrouter:openai/gpt-x', 'anthropic:claude-opus-5', 'hub:qwen3:8b'])
    for (const { id, li, name } of entries) {
      expect(name, `${id} has a spend-key-name`).not.toBeNull()
      expect(name!.textContent, id).toBe(modelName(id))
      expect(name!.getAttribute('title'), id).toBe(id)
      const mono = [li, ...Array.from(li.querySelectorAll('*'))].filter(el => (el.getAttribute('class') ?? '').split(/\s+/).includes('font-mono'))
      expect(mono.length, `${id} mono elements`).toBe(0)
    }
    const text = screen.getByTestId('spend-key').textContent ?? ''
    for (const raw of ['openrouter:', 'openai/', 'anthropic:', 'hub:']) expect(text).not.toContain(raw)
  })

  it('C4: two models whose names collide each name their provider, so no two key labels read the same', async () => {
    const day = (models: { key: string; usd: number; calls: number; local?: boolean }[]) => ({
      day: '2026-09-02',
      usd: models.reduce((n, m) => n + m.usd, 0),
      calls: models.reduce((n, m) => n + m.calls, 0),
      gpu_seconds: 0,
      models: models.map(m => ({ key: m.key, local: m.local ?? false, usd: m.usd, calls: m.calls, gpu_seconds: 0 })),
    })
    const report = {
      ...REPORT,
      by_day: [
        day([
          { key: 'openrouter:google/gemini-3.8-flash', usd: 3, calls: 3 },
          { key: 'gemini:gemini-3.8-flash', usd: 2, calls: 2 },
          { key: 'anthropic:claude-opus-5', usd: 1, calls: 1 },
          { key: 'dell:qwen3:8b', usd: 0, calls: 5, local: true },
          { key: 'qwen3:8b', usd: 0, calls: 4, local: true },
        ]),
      ],
    }
    renderPage({ getSpend: vi.fn(async () => report) })
    await waitFor(() => expect(screen.getByTestId('spend-key')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Calls' }))
    const labels = Object.fromEntries(keyNames().map(e => [e.id, e.name?.textContent ?? null]))
    expect(labels['openrouter:google/gemini-3.8-flash']).toBe('gemini-3.8-flash (openrouter)')
    expect(labels['gemini:gemini-3.8-flash']).toBe('gemini-3.8-flash (gemini)')
    // a name unique in the key carries no provider
    expect(labels['anthropic:claude-opus-5']).toBe('claude-opus-5')
    // a bare id and a machine's copy of it still read apart
    expect(labels['dell:qwen3:8b']).toBe('qwen3:8b (dell)')
    const shown = Object.values(labels)
    expect(new Set(shown).size).toBe(shown.length)
  })
})
