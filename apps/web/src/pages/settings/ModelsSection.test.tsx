import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ModelsSection } from './ModelsSection'
import type { BackendConfig, ModelFit, PullLine, Suggestion } from '../../lib/api'

function fit(overrides: Partial<ModelFit> = {}): ModelFit {
  return {
    verdict: 'comfortable',
    needed_gb: 5,
    free_gb: 20,
    total_gb: 24,
    source: 'estimated',
    reason: null,
    ...overrides,
  }
}

function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    tier: '8-12B',
    engine_suggestion: 'ollama',
    models: [
      { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: 'a daily driver' },
      { slug: 'qwen3:14b', label: 'Qwen3 14B', params_b: 14, min_vram_gb: 16, note: 'bigger' },
    ],
    rationale: 'fits the tier',
    ...overrides,
  }
}

function backend(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return { kind: 'ollama', url: null, provider: null, model: null, api_key: null, ...overrides }
}

async function* linesOf(lines: PullLine[]): AsyncGenerator<PullLine> {
  for (const line of lines) yield line
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

async function* pausableLines(gate: Promise<void>): AsyncGenerator<PullLine> {
  yield { status: 'pulling' }
  await gate
  yield { status: 'success' }
}

function fakeApi({
  installed = ['qwen3:8b'],
  installedFails = false,
  suggest = suggestion(),
  suggestFails = false,
  backendConfig = backend(),
  backendFails = false,
  pullLines = [{ status: 'pulling' }, { status: 'success' }] as PullLine[],
}: {
  installed?: string[]
  installedFails?: boolean
  suggest?: Suggestion
  suggestFails?: boolean
  backendConfig?: BackendConfig
  backendFails?: boolean
  pullLines?: PullLine[]
} = {}) {
  return {
    getInstalledModels: vi.fn(async () => {
      if (installedFails) throw new Error('gateway unreachable')
      return installed
    }),
    getSuggestion: vi.fn(async () => {
      if (suggestFails) throw new Error('no hardware.json')
      return suggest
    }),
    getBackend: vi.fn(async () => {
      if (backendFails) throw new Error('backend unreachable')
      return backendConfig
    }),
    // 2026-09-08 (S11): putSetting answers with what core stored — the
    // fake echoes the write rather than returning nothing.
    putSetting: vi.fn(async (key: string, value: boolean | string | number) => ({ key, value })),
    pullModel: vi.fn(() => linesOf(pullLines)),
  }
}

describe('ModelsSection', () => {
  it('renders the curated and installed models merged, with the current one marked', async () => {
    const api = fakeApi()
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getByTestId('current-chat-model').textContent).toBe('qwen3:8b'))
    expect(screen.getAllByText('Current')).toHaveLength(1)
    expect(screen.getByText('Qwen3 8B')).toBeDefined()
    expect(screen.getByText('Qwen3 14B')).toBeDefined()
    expect(screen.getByText('Available to pull')).toBeDefined()
  })

  it('selecting an installed, non-current model PUTs chat.model and reports the change', async () => {
    const api = fakeApi({
      installed: ['qwen3:8b', 'qwen3:14b'],
    })
    const onModelChanged = vi.fn()
    render(
      <ModelsSection
        chatModel="qwen3:8b"
        onModelChanged={onModelChanged}
        onRerunSetup={vi.fn()}
        api={api}
      />,
    )

    await waitFor(() => expect(screen.getByText('Use this model')).toBeDefined())
    fireEvent.click(screen.getByText('Use this model'))

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'ollama:qwen3:14b'))
    expect(onModelChanged).toHaveBeenCalledWith('ollama:qwen3:14b')
  })

  it('pulling a not-installed model streams progress and it becomes selectable on success', async () => {
    const api = fakeApi({
      installed: ['qwen3:8b'],
      pullLines: [
        { status: 'preflight', required_gb: 9, free_gb: 500, ok: true },
        { status: 'pulling manifest', total: 100, completed: 10 },
        { status: 'success' },
      ],
    })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getByText('Qwen3 14B')).toBeDefined())
    const card = screen.getByText('Qwen3 14B').closest('div.rounded-lg') as HTMLElement
    fireEvent.click(within(card).getByText('Pull'))

    expect(api.pullModel).toHaveBeenCalledWith('qwen3:14b', expect.anything())
    await waitFor(() =>
      expect(within(card).getByText(/Installed — pick/)).toBeDefined(),
    )
    // Now selectable: the card exposes "Use this model" once installed.
    expect(within(card).getByText('Use this model')).toBeDefined()
  })

  it('blocks starting a second pull while one is already in flight, and unblocks once it finishes', async () => {
    const gate = deferred()
    const api = fakeApi({
      installed: ['qwen3:8b'],
      suggest: suggestion({
        models: [
          { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: '' },
          { slug: 'qwen3:14b', label: 'Qwen3 14B', params_b: 14, min_vram_gb: 16, note: '' },
          { slug: 'qwen3:27b', label: 'Qwen3 27B', params_b: 27, min_vram_gb: 24, note: '' },
        ],
      }),
    })
    api.pullModel.mockImplementation(() => pausableLines(gate.promise))

    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getByText('Qwen3 27B')).toBeDefined())
    const card14b = screen.getByText('Qwen3 14B').closest('div.rounded-lg') as HTMLElement
    const card27b = screen.getByText('Qwen3 27B').closest('div.rounded-lg') as HTMLElement

    fireEvent.click(within(card14b).getByText('Pull'))

    await waitFor(() =>
      expect((within(card27b).getByText('Pull') as HTMLButtonElement).disabled).toBe(true),
    )

    gate.resolve()
    await waitFor(() => expect(within(card14b).getByText(/Installed — pick/)).toBeDefined())
    await waitFor(() =>
      expect((within(card27b).getByText('Pull') as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it('shows the active backend with the api key already masked, never the raw value', async () => {
    const api = fakeApi({
      backendConfig: backend({ kind: 'cloud', url: 'https://api.example.com', provider: 'openai', api_key: '•••abcd' }),
    })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getByText('•••abcd')).toBeDefined())
    expect(screen.getByText('https://api.example.com')).toBeDefined()
    expect(screen.queryByText(/sk-/)).toBeNull()
  })

  it('re-run setup calls the provided callback', async () => {
    const api = fakeApi()
    const onRerunSetup = vi.fn(async () => {})
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={onRerunSetup} api={api} />,
    )

    await waitFor(() => expect(screen.getByText('Re-run setup')).toBeDefined())
    fireEvent.click(screen.getByText('Re-run setup'))
    await waitFor(() => expect(onRerunSetup).toHaveBeenCalled())
  })

  it('surfaces a re-run failure instead of hiding it', async () => {
    const api = fakeApi()
    const onRerunSetup = vi.fn(async () => {
      throw new Error('write refused')
    })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={onRerunSetup} api={api} />,
    )

    await waitFor(() => expect(screen.getByText('Re-run setup')).toBeDefined())
    fireEvent.click(screen.getByText('Re-run setup'))
    await waitFor(() => expect(screen.getByText('write refused')).toBeDefined())
  })

  it('renders a wont_fit verdict as a visible warning before the pick, and a tight fit as a caution', async () => {
    const api = fakeApi({
      installed: ['qwen3:8b'],
      suggest: suggestion({
        models: [
          { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: '', fit: fit({ verdict: 'comfortable' }) },
          {
            slug: 'qwen3.8:27b',
            label: 'Qwen3.8 27B',
            params_b: 27,
            min_vram_gb: 24,
            note: '',
            fit: fit({ verdict: 'wont_fit', needed_gb: 30, total_gb: 24, source: 'verified' }),
          },
        ],
      }),
    })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getByText('Qwen3.8 27B')).toBeDefined())
    const card27b = screen.getByText('Qwen3.8 27B').closest('div.rounded-lg') as HTMLElement
    const warning = within(card27b).getByRole('alert')
    expect(warning.textContent).toContain("won't fit on this GPU")
    expect(within(card27b).getByText('verified on your hardware')).toBeDefined()

    const card8b = screen.getByText('Qwen3 8B').closest('div.rounded-lg') as HTMLElement
    expect(within(card8b).getByText('comfortable')).toBeDefined()
    expect(within(card8b).getByText('estimated')).toBeDefined()
  })

  it('shows "fit unknown" for a model the curated catalog does not cover', async () => {
    const api = fakeApi({ installed: ['qwen3:8b', 'llama3.4:9b'] })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getAllByText('llama3.4:9b').length).toBeGreaterThan(0))
    const extraCard = screen.getAllByText('llama3.4:9b')[0].closest('div.rounded-lg') as HTMLElement
    expect(within(extraCard).getByText('fit unknown')).toBeDefined()
  })

  it('gives every card a slug-keyed testid, unambiguous even for the current model', async () => {
    // qwen3:8b is both chatModel (rendered verbatim in the "Current chat
    // model" line) AND a card slug — the exact ambiguity that made the e2e
    // helper's old text-walk-to-ancestor locator resolve two elements and
    // throw a strict-mode violation on every walk (scenario 1 always sets
    // the current model). Confirms the slug text is genuinely duplicated on
    // the page, then confirms the testid still picks exactly one card.
    const api = fakeApi({ installed: ['qwen3:8b'] })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getByTestId('current-chat-model').textContent).toBe('qwen3:8b'))
    expect(screen.getAllByText('qwen3:8b', { exact: true })).toHaveLength(2)

    const currentCard = screen.getByTestId('model-card-qwen3:8b')
    const otherCard = screen.getByTestId('model-card-qwen3:14b')
    expect(currentCard).not.toBe(otherCard)
    expect(within(currentCard).getByText('Current', { exact: true })).toBeDefined()
    expect(within(otherCard).getByText('Available to pull', { exact: true })).toBeDefined()
  })

  it('shows the accuracy disclaimer with no fabricated number, not emphasized when the current model is not on the smaller end', async () => {
    // Two models the same size (both 8B): no spread to be "smaller" relative
    // to, so isSmallerTier is false for both — the base note still shows.
    const api = fakeApi({
      installed: ['qwen3:8b'],
      suggest: suggestion({
        models: [
          { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: '' },
          { slug: 'llama3.5:8b', label: 'Llama3.5 8B', params_b: 8, min_vram_gb: 10, note: '' },
        ],
      }),
    })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    const note = await screen.findByTestId('model-accuracy-disclaimer')
    expect(note.textContent).toContain('Smaller and local models trade some accuracy for speed')
    expect(note.textContent).toContain('qualitative')
    // No invented figure anywhere in the note (no-fake-numbers rail).
    expect(note.textContent).not.toMatch(/\d+%/)
    // Not emphasized: same size on both sides means nothing is "smaller".
    expect(note.textContent).not.toContain('on the smaller end of what')
    expect(note.className).toContain('border-info/30')
  })

  it('emphasizes the accuracy disclaimer when the current model is on the smaller end of the catalog', async () => {
    const api = fakeApi({
      installed: ['qwen3:8b'],
      suggest: suggestion({
        models: [
          { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: '' },
          { slug: 'qwen3:27b', label: 'Qwen3 27B', params_b: 27, min_vram_gb: 24, note: '' },
        ],
      }),
    })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    const note = await screen.findByTestId('model-accuracy-disclaimer')
    expect(note.textContent).toContain("on the smaller end of what's offered here")
    expect(note.className).toContain('border-warning/30')
  })

  it('degrades honestly when the installed-models fetch fails: nothing is claimed installed, and the current model never shows as pullable', async () => {
    const api = fakeApi({ installedFails: true })
    render(
      <ModelsSection chatModel="qwen3:8b" onModelChanged={vi.fn()} onRerunSetup={vi.fn()} api={api} />,
    )

    await waitFor(() => expect(screen.getByText(/Could not confirm which models are installed/)).toBeDefined())
    // qwen3:8b is chat.model, so it is still marked Current even though the
    // installed-fetch failed — but nothing else claims to be Installed.
    expect(screen.queryByText('Installed')).toBeNull()

    // The bug this pins: "Current" and "Available to pull" (plus a live
    // Pull button) must never both render on the model the operator is
    // actually chatting with, no matter why installed-detection came back
    // false for it — the badges are mutually exclusive by isCurrent, not
    // independently true/false.
    const currentCard = screen.getByText('Qwen3 8B').closest('div.rounded-lg') as HTMLElement
    expect(within(currentCard).getByText('Current')).toBeDefined()
    expect(within(currentCard).queryByText('Available to pull')).toBeNull()
    expect(within(currentCard).queryByText('Pull')).toBeNull()
  })
})
