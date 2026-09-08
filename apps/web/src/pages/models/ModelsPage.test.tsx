import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ModelsPage, listsInstalled } from './ModelsPage'
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
  actions: ['use', 'probe', 'check_update', 'remove'],
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
  api: Partial<Record<'getCatalog' | 'searchHf' | 'getHfRepo' | 'resolveModel' | 'probeModel' | 'pullModel' | 'putSetting' | 'getSettings' | 'checkDrift' | 'removeModel', ReturnType<typeof vi.fn>>> = {},
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
    removeModel: vi.fn(async () => ({ removed: 'qwen3:8b', verified: true, installed_now: 0 })),
    checkDrift: vi.fn(async () => ({
      model: 'qwen3:8b',
      checked_at: '2026-09-07T12:00:00Z',
      installed_digest: 'sha256:' + 'a'.repeat(64),
      upstream_digest: 'sha256:' + 'a'.repeat(64),
      moved: false,
      basis: 'weights-digest',
      source: 'ollama-registry',
    })),
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

  it('a pull that saw the success line re-reads the catalogue and says installed only when it lists the model', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' })).toBeTruthy())
    // The re-read after the pull lists the model as installed.
    api.getCatalog.mockResolvedValue({ ...CATALOG, rows: [INSTALLED, { ...AVAILABLE, installed: true, actions: ['use', 'probe'] }, CLOUD] })
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() => expect(screen.getByTestId('pull-panel').textContent).toContain('installed'))
    expect(screen.getByTestId('pull-panel').textContent).toContain('size from registry.ollama.ai')
    expect(api.getCatalog).toHaveBeenCalledTimes(2)
    // Installed now lists it — the CATALOGUE's word, not the stream's.
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
    await waitFor(() => expect(screen.getByText('Qwen3 4B')).toBeTruthy())
  })

  it('a quiet stream is a stated failure and the catalogue is not re-read', async () => {
    const { api } = renderPage({ pullModel: vi.fn(() => lines([{ status: 'pulling manifest' }])) })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() =>
      expect(screen.getByTestId('pull-panel').textContent).toContain('ended without ollama reporting success'),
    )
    expect(api.getCatalog).toHaveBeenCalledTimes(1)
  })

  it('a success line the re-read catalogue does not confirm is a stated failure, never "installed"', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() =>
      expect(screen.getByTestId('pull-panel').textContent).toContain('does not list qwen3:4b as installed'),
    )
    expect(screen.getByTestId('pull-panel').textContent).not.toContain('qwen3:4binstalled')
    expect(api.getCatalog).toHaveBeenCalledTimes(2)

    // A re-read that fails is stated too.
    api.getCatalog.mockRejectedValue(new Error('gateway down'))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() => expect(screen.getByTestId('pull-panel').textContent).toContain('could not be re-read'))
  })

  it('listsInstalled matches the bare tag, its :latest form, and only installed local rows', () => {
    const cat = { ...CATALOG, rows: [{ ...AVAILABLE, installed: true }, row({ id: 'ollama:gemma', model: 'gemma:latest', installed: true })] }
    expect(listsInstalled(cat, 'qwen3:4b')).toBe(true)
    expect(listsInstalled(cat, 'gemma')).toBe(true)
    expect(listsInstalled(CATALOG, 'qwen3:4b')).toBe(false)
    expect(listsInstalled({ ...CATALOG, rows: [row({ id: 'openrouter:qwen3:4b', installed: true })] }, 'qwen3:4b')).toBe(false)
  })

  it('Cancel aborts the stream: no catalogue re-read, no "installed", and a new pull can start', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { api } = renderPage({
      pullModel: vi.fn(async function* () {
        yield { status: 'preflight', required_gb: 2.5, free_gb: 100, ok: true }
        yield { status: 'pulling sha256:ab', total: 1000, completed: 100 }
        await gate
        yield { status: 'success' }
      }),
    })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() => expect(screen.getByTestId('pull-panel').textContent).toContain('pulling sha256:ab'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByTestId('pull-panel').textContent).toContain('cancelled'))
    release()
    await new Promise(r => setTimeout(r, 20))
    expect(screen.getByTestId('pull-panel').textContent).not.toContain('installed')
    expect(api.getCatalog).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'pull ollama:qwen3:4b' }))
    await waitFor(() => expect(api.pullModel).toHaveBeenCalledTimes(2))
  })

  it('Use that the server rejects leaves the row uncurrent and states the reason', async () => {
    const { api } = renderPage({ putSetting: vi.fn(async () => { throw new Error('settings write refused (503)') }) })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Cloud/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'use openrouter:openai/gpt-x' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'use openrouter:openai/gpt-x' }))
    await waitFor(() => expect(screen.getAllByRole('alert').some(a => a.textContent?.includes('settings write refused (503)'))).toBe(true))
    expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'openrouter:openai/gpt-x')
    expect(screen.queryByText('current')).toBeNull()
    expect(screen.getByRole('button', { name: 'use openrouter:openai/gpt-x' })).toBeTruthy()
  })

  it('a slow earlier search cannot overwrite a newer one, and switching tabs does not re-search', async () => {
    let resolveFirst: (page: HfPage) => void = () => {}
    const first = new Promise<HfPage>(resolve => {
      resolveFirst = resolve
    })
    const later: HfPage = {
      rows: [row({ id: 'ollama:hf.co/org/Later-GGUF', label: 'Later-GGUF', kind: 'hub', installed: false, actions: ['pull'] })],
      next_cursor: null,
      fetched_at: '2026-09-06T12:00:00Z',
      cached: false,
    }
    const searchHf = vi.fn((q: string) => (q === 'qwen coder' ? first : Promise.resolve(later)))
    const { api } = renderPage({ searchHf })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. qwen coder'), { target: { value: 'qwen coder' } })
    await waitFor(() => expect(searchHf).toHaveBeenCalledWith('qwen coder', 'downloads', undefined))
    fireEvent.change(screen.getByPlaceholderText('e.g. qwen coder'), { target: { value: 'qwen later' } })
    await waitFor(() => expect(screen.getByText('Later-GGUF')).toBeTruthy())
    resolveFirst({ rows: [HUB], next_cursor: null, fetched_at: '2026-09-06T12:00:00Z', cached: false })
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByText('Qwen3-Coder-GGUF')).toBeNull()
    expect(screen.getByText('Later-GGUF')).toBeTruthy()
    const calls = api.searchHf.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    await new Promise(r => setTimeout(r, 20))
    expect(api.searchHf.mock.calls.length).toBe(calls)
  })

  it('a row whose source omitted actions renders with no buttons instead of throwing', async () => {
    const bare = { ...CLOUD, id: 'openrouter:bare/row', label: 'Bare Row', actions: undefined as unknown as CatalogRow['actions'] }
    renderPage({ getCatalog: vi.fn(async () => ({ ...CATALOG, rows: [INSTALLED, bare] })) })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Cloud/ }))
    await waitFor(() => expect(screen.getByText('Bare Row')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'use openrouter:bare/row' })).toBeNull()
  })

  it('an installed Hub repo is not offered again under Available', async () => {
    const held = { ...HUB, installed: true, note: 'installed as hf.co/unsloth/Qwen3-Coder-GGUF:Q4_K_M' }
    renderPage({ searchHf: vi.fn(async () => ({ rows: [held], next_cursor: null, fetched_at: '2026-09-06T12:00:00Z', cached: false })) })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. qwen coder'), { target: { value: 'qwen coder' } })
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByText('Qwen3-Coder-GGUF')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    await waitFor(() => expect(screen.getByText('Qwen3-Coder-GGUF')).toBeTruthy())
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

  it('Check for updates compares digests without pulling, and a moved source offers Update', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'check updates ollama:qwen3:8b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'check updates ollama:qwen3:8b' }))
    await waitFor(() => expect(screen.getByTestId('drift-ollama:qwen3:8b').textContent).toContain('up to date'))
    expect(api.checkDrift).toHaveBeenCalledWith('qwen3:8b')
    expect(api.pullModel).not.toHaveBeenCalled()

    api.checkDrift.mockResolvedValue({
      model: 'qwen3:8b',
      checked_at: '2026-09-07T12:00:00Z',
      installed_digest: 'sha256:' + 'a'.repeat(64),
      upstream_digest: 'sha256:' + 'b'.repeat(64),
      moved: true,
      basis: 'weights-digest',
      source: 'ollama-registry',
    })
    fireEvent.click(screen.getByRole('button', { name: 'check updates ollama:qwen3:8b' }))
    await waitFor(() => expect(screen.getByTestId('drift-ollama:qwen3:8b').textContent).toContain('update available'))
    fireEvent.click(screen.getByRole('button', { name: 'update ollama:qwen3:8b' }))
    await waitFor(() => expect(api.pullModel).toHaveBeenCalled())
    expect(api.pullModel.mock.calls[0][0]).toBe('qwen3:8b')

    api.checkDrift.mockResolvedValue({
      model: 'qwen3:8b',
      checked_at: '2026-09-07T12:00:00Z',
      installed_digest: 'sha256:' + 'a'.repeat(64),
      upstream_digest: null,
      moved: null,
      basis: 'weights-digest',
      source: null,
      note: 'the source could not be read — registry.ollama.ai timed out',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'check updates ollama:qwen3:8b' }))
    await waitFor(() => expect(screen.getByTestId('drift-ollama:qwen3:8b').textContent).toContain('could not tell: the source could not be read'))
  })

  it('a measured suitability tag links to the quality page', async () => {
    const measured = {
      ...INSTALLED,
      suitability: { agent_quality: { value: 0.857, basis: 'measured', source: 'core-evals', at: '2026-09-04T00:00:00Z' } },
    }
    renderPage({ getCatalog: vi.fn(async () => ({ ...CATALOG, rows: [measured] })) })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    const link = screen.getByRole('link', { name: /agent_quality 86%/ })
    expect(link.getAttribute('href')).toBe('/quality')
  })

  it('Compare lays the ticked rows side by side with scaled bars and each fact\'s basis', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    const compare = screen.getByRole('button', { name: 'compare selected' })
    expect(compare.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    await waitFor(() => expect(screen.getByLabelText('compare openrouter:openai/gpt-x')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('compare ollama:qwen3:8b'))
    fireEvent.click(screen.getByLabelText('compare openrouter:openai/gpt-x'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'compare selected' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'compare selected' }))
    const view = await screen.findByTestId('compare-view')
    expect(within(view).getByText('ollama:qwen3:8b')).toBeTruthy()
    expect(within(view).getByText('openrouter:openai/gpt-x')).toBeTruthy()
    // Context: both stated; the cloud row is the larger and draws the full bar.
    const local = within(view).getByTestId('compare-context_length-ollama:qwen3:8b')
    const cloud = within(view).getByTestId('compare-context_length-openrouter:openai/gpt-x')
    expect(local.textContent).toContain('41K')
    expect(cloud.textContent).toContain('1.05M')
    expect((cloud.querySelector('div > div') as HTMLElement).style.width).toBe('100%')
    expect(local.textContent).toContain('declared · ollama-show')
    // Size: only the local row states one; the cloud cell says so.
    expect(within(view).getByTestId('compare-size_bytes-openrouter:openai/gpt-x').textContent).toBe('not stated')
    // Suitability: coding is inferred on one and a third-party index on the other.
    expect(within(view).getByTestId('compare-coding-ollama:qwen3:8b').textContent).toContain('coding?')
    expect(within(view).getByTestId('compare-coding-openrouter:openai/gpt-x').textContent).toContain('coding 77')
  })

  it('Remove asks first, then deletes, and installed is what the re-read catalogue says', async () => {
    const { api } = renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'remove ollama:qwen3:8b' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'remove ollama:qwen3:8b' }))
    expect(api.removeModel).not.toHaveBeenCalled()
    api.getCatalog.mockResolvedValue({ ...CATALOG, rows: [{ ...INSTALLED, installed: false, actions: ['pull'] }, AVAILABLE, CLOUD] })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.removeModel).toHaveBeenCalledWith('qwen3:8b'))
    await waitFor(() => expect(api.getCatalog).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'remove ollama:qwen3:8b' })).toBeNull())

    // A 200 the gateway did not verify is not a removal.
    api.removeModel.mockResolvedValue({ removed: 'qwen3:4b', verified: false, installed_now: 1 })
  })

  it('an estimated Hub size is drawn dashed with ≈ and left out of the size facet unless inferred is included', async () => {
    const estimated = {
      ...HUB,
      facts: { ...HUB.facts, size_bytes: { value: 18_000_000_000, basis: 'inferred', source: 'hf-hub', note: '≈ Q4_K_M at 4.85 bits/weight from 30.5B params — pick a quant for the stated size' } },
    }
    renderPage({ searchHf: vi.fn(async () => ({ rows: [estimated], next_cursor: null, fetched_at: '2026-09-06T12:00:00Z', cached: false })) })
    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. qwen coder'), { target: { value: 'qwen coder' } })
    await waitFor(() => expect(screen.getByText('Qwen3-Coder-GGUF')).toBeTruthy())
    const size = screen.getByText('≈ 16.8 GB')
    expect(size.getAttribute('data-basis')).toBe('inferred')
  })
})
