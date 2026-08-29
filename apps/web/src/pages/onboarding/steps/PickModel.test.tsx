import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { PickModel } from './PickModel'
import type { ModelFit, Suggestion } from '../../../lib/api'

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

function mockSuggestion(suggestion: Suggestion) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(suggestion),
      json: async () => suggestion,
    })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const noop = () => {}

describe('PickModel fit rendering (slice-02e-model-surface T2)', () => {
  it('renders each candidate\'s fit verdict label before it can be picked', async () => {
    mockSuggestion({
      tier: '27B-class',
      engine_suggestion: 'ollama',
      rationale: 'fits the tier',
      models: [
        {
          slug: 'qwen3.8:27b',
          label: 'Qwen3.8 27B',
          params_b: 27,
          min_vram_gb: 24,
          note: '',
          fit: fit({ verdict: 'tight', needed_gb: 22, total_gb: 24 }),
        },
        {
          slug: 'qwen3:8b',
          label: 'Qwen3 8B',
          params_b: 8,
          min_vram_gb: 10,
          note: '',
          fit: fit({ verdict: 'comfortable' }),
        },
      ],
    })

    render(
      <PickModel engine="ollama" selected="" onSelect={noop} onConfigured={noop} onNext={noop} onBack={noop} />,
    )

    await waitFor(() => expect(screen.getByText('Qwen3.8 27B')).toBeDefined())
    expect(screen.getByText('tight fit — ~22/24 GB')).toBeDefined()
    expect(screen.getByText('comfortable')).toBeDefined()
  })

  it('shows a wont_fit candidate with an explicit warning before the operator can pick it', async () => {
    mockSuggestion({
      tier: '27B-class',
      engine_suggestion: 'ollama',
      rationale: 'fits the tier',
      models: [
        {
          slug: 'qwen3.8:27b',
          label: 'Qwen3.8 27B',
          params_b: 27,
          min_vram_gb: 24,
          note: '',
          fit: fit({ verdict: 'wont_fit', needed_gb: 40, total_gb: 24, source: 'verified' }),
        },
      ],
    })

    render(
      <PickModel engine="ollama" selected="" onSelect={noop} onConfigured={noop} onNext={noop} onBack={noop} />,
    )

    await waitFor(() => expect(screen.getByText('Qwen3.8 27B')).toBeDefined())
    const card = screen.getByText('Qwen3.8 27B').closest('button') as HTMLElement
    const warning = within(card).getByRole('alert')
    expect(warning.textContent).toContain("won't fit on this GPU")
    expect(within(card).getByText('verified on your hardware')).toBeDefined()
  })

  it('shows "fit unknown" when a candidate carries no fit at all', async () => {
    mockSuggestion({
      tier: '27B-class',
      engine_suggestion: 'ollama',
      rationale: 'fits the tier',
      models: [
        { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: '' },
      ],
    })

    render(
      <PickModel engine="ollama" selected="" onSelect={noop} onConfigured={noop} onNext={noop} onBack={noop} />,
    )

    await waitFor(() => expect(screen.getByText('Qwen3 8B')).toBeDefined())
    expect(screen.getByText('fit unknown')).toBeDefined()
  })
})
