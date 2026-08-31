import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelSelector } from './ModelSelector'
import type { Suggestion } from '../../lib/api'

/**
 * The inline chat model selector. It reuses the model API (installed list +
 * curated catalog + PUT chat.model) via the same DI seam ModelsSection uses.
 * The load-bearing behaviours: it shows the current model verbatim (the
 * `chat-model` contract the header badge and the e2e spec rely on), it switches
 * through the real PUT, and it never fakes success — the change is reported to
 * the parent only after the PUT resolves ok.
 */

function suggestion(): Suggestion {
  return {
    tier: '8-12B',
    engine_suggestion: 'ollama',
    models: [
      { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: '' },
      { slug: 'qwen3:14b', label: 'Qwen3 14B', params_b: 14, min_vram_gb: 16, note: '' },
    ],
    rationale: '',
  }
}

function fakeApi(overrides: { putFails?: boolean } = {}) {
  return {
    getInstalledModels: vi.fn(async () => ['qwen3:8b', 'qwen3:14b']),
    getSuggestion: vi.fn(async () => suggestion()),
    putSetting: vi.fn(async () => {
      if (overrides.putFails) throw new Error('settings write refused')
    }),
  }
}

/** Render and let the mount catalog fetch settle inside act, so no state
 * update escapes it (and no act(...) warning is printed). */
async function renderSelector(props: React.ComponentProps<typeof ModelSelector>) {
  const utils = render(<ModelSelector {...props} />)
  await act(async () => {})
  return utils
}

describe('ModelSelector', () => {
  it('shows the current model verbatim in the chat-model element', async () => {
    await renderSelector({ currentModel: 'qwen3:8b', onModelChanged: vi.fn(), api: fakeApi() })
    expect(screen.getByTestId('chat-model').textContent).toBe('qwen3:8b')
  })

  it('opens a menu of models with the current one marked selected', async () => {
    await renderSelector({ currentModel: 'qwen3:8b', onModelChanged: vi.fn(), api: fakeApi() })
    fireEvent.click(screen.getByTestId('chat-model-trigger'))
    await waitFor(() => expect(screen.getByTestId('chat-model-option-qwen3:14b')).toBeDefined())
    expect(screen.getByTestId('chat-model-option-qwen3:8b').getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByTestId('chat-model-option-qwen3:14b').getAttribute('aria-selected')).toBe(
      'false',
    )
  })

  it('switching PUTs chat.model and reports the change only after the PUT resolves', async () => {
    const api = fakeApi()
    const onModelChanged = vi.fn()
    const { rerender } = await renderSelector({
      currentModel: 'qwen3:8b',
      onModelChanged,
      api,
    })

    fireEvent.click(screen.getByTestId('chat-model-trigger'))
    await waitFor(() => expect(screen.getByTestId('chat-model-option-qwen3:14b')).toBeDefined())
    fireEvent.click(screen.getByTestId('chat-model-option-qwen3:14b'))

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'qwen3:14b'))
    expect(onModelChanged).toHaveBeenCalledWith('qwen3:14b')

    // The parent reflects the change back down through the prop (chat-store's
    // setModel does this in the app); the selector then shows the new slug.
    rerender(<ModelSelector currentModel="qwen3:14b" onModelChanged={onModelChanged} api={api} />)
    expect(screen.getByTestId('chat-model').textContent).toBe('qwen3:14b')
  })

  it('does not report success when the PUT fails — it surfaces the reason instead', async () => {
    const api = fakeApi({ putFails: true })
    const onModelChanged = vi.fn()
    await renderSelector({ currentModel: 'qwen3:8b', onModelChanged, api })

    fireEvent.click(screen.getByTestId('chat-model-trigger'))
    await waitFor(() => expect(screen.getByTestId('chat-model-option-qwen3:14b')).toBeDefined())
    fireEvent.click(screen.getByTestId('chat-model-option-qwen3:14b'))

    await waitFor(() => expect(screen.getByText(/settings write refused/)).toBeDefined())
    expect(onModelChanged).not.toHaveBeenCalled()
  })

  it('selecting the already-current model does nothing (no PUT)', async () => {
    const api = fakeApi()
    const onModelChanged = vi.fn()
    await renderSelector({ currentModel: 'qwen3:8b', onModelChanged, api })
    fireEvent.click(screen.getByTestId('chat-model-trigger'))
    await waitFor(() => expect(screen.getByTestId('chat-model-option-qwen3:8b')).toBeDefined())
    fireEvent.click(screen.getByTestId('chat-model-option-qwen3:8b'))
    expect(api.putSetting).not.toHaveBeenCalled()
    expect(onModelChanged).not.toHaveBeenCalled()
  })

  it('exposes a light accuracy note only while the dropdown is open, with no fabricated number', async () => {
    const api = fakeApi()
    await renderSelector({ currentModel: 'qwen3:8b', onModelChanged: vi.fn(), api })

    // Not cluttering the compact, always-visible trigger.
    expect(screen.queryByTestId('chat-model-accuracy-note')).toBeNull()

    fireEvent.click(screen.getByTestId('chat-model-trigger'))
    const note = await screen.findByTestId('chat-model-accuracy-note')
    expect(note.textContent).toMatch(/accuracy/i)
    expect(note.textContent).not.toMatch(/\d+%/)
  })

  it("emphasizes the inline note's tone when the current model is on the smaller end of the catalog", async () => {
    const api = fakeApi()
    await renderSelector({ currentModel: 'qwen3:8b', onModelChanged: vi.fn(), api })
    fireEvent.click(screen.getByTestId('chat-model-trigger'))
    const note = await screen.findByTestId('chat-model-accuracy-note')
    // qwen3:8b is the smaller of the two catalog entries (8B vs 14B).
    expect(note.className).toContain('text-warning')
  })
})
