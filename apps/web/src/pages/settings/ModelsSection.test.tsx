import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ModelsSection } from './ModelsSection'
import type { BackendConfig, PullLine, Suggestion } from '../../lib/api'

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
    putSetting: vi.fn(async () => {}),
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

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'qwen3:14b'))
    expect(onModelChanged).toHaveBeenCalledWith('qwen3:14b')
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
