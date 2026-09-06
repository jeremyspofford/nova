import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ModelsPage } from './ModelsPage'
import { ChatProvider } from '../../stores/chat-store'
import type { Catalog, CatalogRow, HfPage, PullLine, ResolvedRef, SettingDef } from '../../lib/api'

function row(overrides: Partial<CatalogRow> & { id: string }): CatalogRow {
  const [provider, ...rest] = overrides.id.split(':')
  return {
    provider,
    model: rest.join(':'),
    label: overrides.id,
    kind: provider === 'ollama' ? 'local' : 'cloud',
    sources: [{ key: provider === 'ollama' ? 'ollama-show' : 'provider-listing', fetched_at: '2026-09-06T12:00:00Z' }],
    facts: {},
    capabilities: {},
    suitability: {},
    actions: [],
    ...overrides,
  }
}

const INSTALLED = row({
  id: 'ollama:qwen3:8b',
  label: 'Qwen3 8B',
  installed: true,
  facts: {
    size_bytes: { value: 5_225_388_164, basis: 'declared', source: 'ollama-tags' },
    context_length: { value: 40960, basis: 'declared', source: 'ollama-show' },
  },
  capabilities: { tools: { value: true, basis: 'declared', source: 'ollama-show' } },
  suitability: { 'coding:inferred': { value: true, basis: 'inferred', source: 'name', note: 'name matches /coder/' } },
  fit: { verdict: 'comfortable', needed_gb: 10, free_gb: 24, total_gb: 24, source: 'estimated', reason: null },
  actions: ['use', 'probe'],
})
const AVAILABLE = row({ id: 'ollama:qwen3:4b', label: 'Qwen3 4B', installed: false, actions: ['pull'] })
const CLOUD = row({
  id: 'openrouter:openai/gpt-x',
  label: 'GPT X',
  facts: {
    context_length: { value: 1_050_000, basis: 'declared', source: 'provider-listing' },
    price_prompt: { value: 0.00001, basis: 'declared', source: 'provider-listing' },
    price_completion: { value: 0.00005, basis: 'declared', source: 'provider-listing' },
  },
  capabilities: { tools: { value: true, basis: 'declared', source: 'provider-listing' } },
  suitability: { coding: { value: 76.9, basis: 'declared', source: 'provider-listing', note: 'third-party' } },
  actions: ['use'],
})
const HUB = row({
  id: 'ollama:hf.co/unsloth/Qwen3-Coder-GGUF',
  label: 'Qwen3-Coder-GGUF',
  kind: 'hub',
  installed: false,
  sources: [{ key: 'hf-hub', fetched_at: '2026-09-06T12:00:00Z' }],
  facts: { params_b: { value: 30.5, basis: 'declared', source: 'hf-hub' } },
  capabilities: { tools: { value: true, basis: 'inferred', source: 'hf-hub', note: 'chat_template mentions tools' } },
  actions: ['pull'],
})

const CATALOG: Catalog = {
  fetched_at: '2026-09-06T12:00:00Z',
  sources: [
    { key: 'ollama', ok: true, rows: 2, fetched_at: '2026-09-06T12:00:00Z' },
    { key: 'openrouter', ok: true, rows: 1, fetched_at: '2026-09-06T12:00:00Z' },
    { key: 'anthropic', ok: false, rows: 0, note: 'the listing was refused (401): invalid x-api-key' },
  ],
  rows: [INSTALLED, AVAILABLE, CLOUD],
}

const SETTINGS: SettingDef[] = [{ key: 'chat.model', type: 'str', default: '', description: '', value: 'ollama:qwen3:8b' }]

async function* lines(items: PullLine[]) {
  for (const line of items) yield line
}

function renderPage(
  api: Partial<Record<'getCatalog' | 'searchHf' | 'getHfRepo' | 'resolveModel' | 'probeModel' | 'pullModel' | 'putSetting' | 'getSettings', ReturnType<typeof vi.fn>>> = {},
) {
  const full = {
    getCatalog: vi.fn(async () => CATALOG),
    searchHf: vi.fn(async (): Promise<HfPage> => ({ rows: [HUB], next_cursor: null, fetched_at: '2026-09-06T12:00:00Z', cached: false })),
    getHfRepo: vi.fn(async () => ({
      ...HUB,
      pull: {
        target: HUB.model,
        quants: [
          { tag: 'Q4_K_M', filename: 'x-Q4_K_M.gguf', size_bytes: 18_000_000_000, is_default: true },
          { tag: 'Q8_0', filename: 'x-Q8_0.gguf', size_bytes: 32_000_000_000, is_default: false },
        ],
      },
    })),
    resolveModel: vi.fn(async (): Promise<ResolvedRef> => ({
      model: 'qwen3:4b',
      source: 'ollama-registry',
      fetched_at: '2026-09-06T12:00:00Z',
      facts: {
        size_bytes: { value: 2_500_000_000, basis: 'declared', source: 'ollama-registry' },
        quant: { value: 'Q4_K_M', basis: 'declared', source: 'ollama-registry' },
      },
    })),
    probeModel: vi.fn(async () => ({ id: 1, model: 'qwen3:8b', kind: 'ollama', ok: true, latency_ms: 812, vram_mb: 9318, error: null, created_at: '2026-09-06T12:00:00Z' })),
    pullModel: vi.fn(() =>
      lines([
        { status: 'preflight', required_gb: 2.5, free_gb: 100, ok: true, size_source: 'ollama-registry' },
        { status: 'pulling sha256:ab', total: 1000, completed: 1000 },
        { status: 'success' },
      ]),
    ),
    putSetting: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => SETTINGS),
    ...api,
  }
  return {
    ...render(
      <MemoryRouter>
        <ChatProvider>
          <ModelsPage api={full} />
        </ChatProvider>
      </MemoryRouter>,
    ),
    api: full,
  }
}

describe('ModelsPage', () => {
  it('shows every source with its fetch time, and a failed source in its own words', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('catalog-sources')).toBeTruthy())
    const chips = screen.getByTestId('catalog-sources').textContent ?? ''
    expect(chips).toContain('ollama · 2')
    expect(chips).toContain('anthropic · 0 · the listing was refused (401): invalid x-api-key')
  })

  it('opens on Installed, tabs carry counts, and the current model is marked', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    expect(screen.queryByText('GPT X')).toBeNull()
    expect(screen.getByText('current')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Cloud/ }))
    await waitFor(() => expect(screen.getByText('GPT X')).toBeTruthy())
    expect(screen.getByText('$10 / $50 per 1M')).toBeTruthy()
    expect(screen.getByText('1.05M ctx')).toBeTruthy()
  })

  it('an inferred tag is dashed and off by default in the suitability filter', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    const inferred = screen.getByText('coding?')
    expect(inferred.getAttribute('data-basis')).toBe('inferred')
    expect(inferred.className).toContain('border-dashed')
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    fireEvent.change(screen.getByLabelText('Suitability'), { target: { value: 'coding' } })
    await waitFor(() => expect(screen.queryByText('Qwen3 8B')).toBeNull())
    expect(screen.getByText('GPT X')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/include inferred/i))
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
  })

  it('a numeric facet hides rows lacking the fact and says how many', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    fireEvent.change(screen.getByLabelText('Size ≤ GB'), { target: { value: '10' } })
    await waitFor(() => expect(screen.getByTestId('hidden-counts').textContent).toContain('2 rows have no stated size'))
    expect(screen.queryByText('GPT X')).toBeNull()
  })

  it('Use writes the provider-qualified id and marks the row current only after the PUT', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Cloud/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'use openrouter:openai/gpt-x' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'use openrouter:openai/gpt-x' }))
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'openrouter:openai/gpt-x'))
    await waitFor(() => expect(screen.getByText('current')).toBeTruthy())
  })

  it('a Hugging Face search appends hub rows and Pull offers the repo quants with the default marked', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. qwen coder'), { target: { value: 'qwen coder' } })
    await waitFor(() => expect(api.searchHf).toHaveBeenCalledWith('qwen coder', 'downloads', undefined))
    await waitFor(() => expect(screen.getByText('Qwen3-Coder-GGUF')).toBeTruthy())
    expect(screen.getByText('tools?').getAttribute('data-basis')).toBe('inferred')
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:hf.co/unsloth/Qwen3-Coder-GGUF' }))
    await waitFor(() => expect(screen.getByTestId('quant-menu')).toBeTruthy())
    const menu = screen.getByTestId('quant-menu')
    expect(within(menu).getByText('Q4_K_M')).toBeTruthy()
    expect(within(menu).getByText('default')).toBeTruthy()
    fireEvent.click(within(menu).getByText('Q8_0'))
    await waitFor(() => expect(api.pullModel).toHaveBeenCalled())
    expect(api.pullModel.mock.calls[0][0]).toBe('hf.co/unsloth/Qwen3-Coder-GGUF:Q8_0')
  })

  it('a pull that saw the success line re-reads the catalogue; a quiet stream is a stated failure', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() => expect(screen.getByTestId('pull-panel').textContent).toContain('installed'))
    expect(screen.getByTestId('pull-panel').textContent).toContain('size from registry.ollama.ai')
    expect(api.getCatalog).toHaveBeenCalledTimes(2)

    api.pullModel.mockImplementation(() => lines([{ status: 'pulling manifest' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() =>
      expect(screen.getByTestId('pull-panel').textContent).toContain('ended without ollama reporting success'),
    )
    expect(api.getCatalog).toHaveBeenCalledTimes(2)
  })

  it('pull by name resolves live before pulling, and a refusal is the gateway\'s words', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'qwen3:4b' } })
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    await waitFor(() => expect(screen.getByTestId('resolved-preview')).toBeTruthy())
    expect(screen.getByTestId('resolved-preview').textContent).toContain('2.3 GB')
    expect(screen.getByTestId('resolved-preview').textContent).toContain('ollama-registry')
    fireEvent.click(within(screen.getByTestId('resolved-preview')).getByRole('button', { name: /pull/i }))
    await waitFor(() => expect(api.pullModel).toHaveBeenCalled())
    expect(api.pullModel.mock.calls[0][0]).toBe('qwen3:4b')

    api.resolveModel.mockImplementation(async () => {
      throw new Error("'nope:1b' is not in the ollama library (registry answered 404)")
    })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'nope:1b' } })
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    await waitFor(() => expect(screen.getAllByRole('alert').some(a => a.textContent?.includes('registry answered 404'))).toBe(true))
  })

  it('Probe records the measurement and re-reads the catalogue', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'probe ollama:qwen3:8b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'probe ollama:qwen3:8b' }))
    await waitFor(() => expect(api.probeModel).toHaveBeenCalledWith('ollama:qwen3:8b'))
    await waitFor(() => expect(screen.getByText('812 ms · 9.1 GB')).toBeTruthy())
    expect(api.getCatalog).toHaveBeenCalledTimes(2)
  })

  it('Details opens the sheet with every fact\'s basis and source', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'details ollama:qwen3:8b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'details ollama:qwen3:8b' }))
    await waitFor(() => expect(screen.getByTestId('model-details-ollama:qwen3:8b')).toBeTruthy())
    const sheet = screen.getByTestId('model-details-ollama:qwen3:8b').textContent ?? ''
    expect(sheet).toContain('4.9 GB')
    expect(sheet).toContain('declared · ollama-tags')
    expect(sheet).toContain('name matches /coder/')
  })

  it('a failed catalogue load states the reason', async () => {
    renderPage({
      getCatalog: vi.fn(async () => {
        throw new Error('the gateway is unreachable — ConnectError')
      }),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('the gateway is unreachable'))
  })
})
