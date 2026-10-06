import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModelsSection } from './ModelsSection'
import type { BackendConfig } from '../../lib/api'

function backend(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return { kind: 'ollama', url: null, provider: null, model: null, api_key: null, ...overrides }
}

function fakeApi({
  backendConfig = backend(),
  backendFails = false,
  seers = [] as string[],
  seersReason,
  visionWriteFails = false,
}: {
  backendConfig?: BackendConfig
  backendFails?: boolean
  seers?: string[]
  seersReason?: string
  visionWriteFails?: boolean
} = {}) {
  return {
    getBackend: vi.fn(async () => {
      if (backendFails) throw new Error('backend unreachable')
      return backendConfig
    }),
    // putSetting answers with what core stored — the fake echoes the write.
    putSetting: vi.fn(async (key: string, value: boolean | string | number) => {
      if (visionWriteFails) throw new Error('settings write refused (503)')
      return { key, value }
    }),
    // S28: installed models that can SEE.
    visionModels: vi.fn(async () => (seersReason ? { models: seers, reason: seersReason } : { models: seers })),
  }
}

function renderSection(api = fakeApi(), props: Partial<React.ComponentProps<typeof ModelsSection>> = {}) {
  const onVisionChanged = vi.fn()
  const onRerunSetup = vi.fn(async () => {})
  render(<ModelsSection onVisionChanged={onVisionChanged} onRerunSetup={onRerunSetup} api={api} {...props} />)
  return { api, onVisionChanged, onRerunSetup }
}

describe('ModelsSection', () => {
  it('carries no second model list and no chat model of its own — Models and Routing hold those', async () => {
    // 2026-10-05, owner: reduce the duplicated model pages. The list with its
    // own Use and Pull, and the "current chat model" line, were copies.
    renderSection()
    await waitFor(() => expect(screen.getByTestId('models-catalog-link')).toBeDefined())
    expect(screen.queryByTestId('current-chat-model')).toBeNull()
    expect(screen.queryByText('Use this model')).toBeNull()
    expect(screen.getByTestId('models-catalog-link').textContent).toContain('Routing')
  })

  it('shows the accuracy disclaimer with no fabricated number', async () => {
    renderSection()
    const note = await screen.findByTestId('model-accuracy-disclaimer')
    expect(note.textContent).toMatch(/accuracy|wander|incorrect/i)
    expect(note.textContent).not.toMatch(/\d+%/)
  })

  it('shows the active backend with the api key already masked, never the raw value', async () => {
    renderSection(fakeApi({ backendConfig: backend({ kind: 'cloud', url: 'https://api.example.com', api_key: '•••abcd' }) }))
    await waitFor(() => expect(screen.getByText('•••abcd')).toBeDefined())
    expect(screen.getByText('https://api.example.com')).toBeDefined()
    expect(screen.queryByText(/sk-/)).toBeNull()
  })

  it('re-run setup calls the provided callback', async () => {
    const { onRerunSetup } = renderSection()
    await waitFor(() => expect(screen.getByText('Re-run setup')).toBeDefined())
    fireEvent.click(screen.getByText('Re-run setup'))
    await waitFor(() => expect(onRerunSetup).toHaveBeenCalled())
  })

  it('surfaces a re-run failure instead of hiding it', async () => {
    renderSection(fakeApi(), {
      onRerunSetup: vi.fn(async () => {
        throw new Error('write refused')
      }),
    })
    await waitFor(() => expect(screen.getByText('Re-run setup')).toBeDefined())
    fireEvent.click(screen.getByText('Re-run setup'))
    await waitFor(() => expect(screen.getByText('write refused')).toBeDefined())
  })
})

describe('ModelsSection — which model reads an image (S28)', () => {
  it('offers the models that can actually see, and defaults to letting her choose', async () => {
    renderSection(fakeApi({ seers: ['gemma4:12b', 'qwen3.8:27b'] }))
    const picker = (await screen.findByLabelText('Model that reads images')) as HTMLSelectElement
    expect([...picker.options].map(o => o.value)).toEqual(['', 'gemma4:12b', 'qwen3.8:27b'])
    // Empty is "choose automatically" — the honest default when he has no
    // preference, and what she already does.
    expect(picker.value).toBe('')
  })

  it('writes his pick to chat.vision_model and hands back only the image model', async () => {
    // 2026-10-05: the stored image model went to the CHAT model's handler,
    // so the page and the chat badge named it as the chat model.
    const { api, onVisionChanged } = renderSection(fakeApi({ seers: ['gemma4:12b'] }))
    const picker = await screen.findByLabelText('Model that reads images')

    fireEvent.change(picker, { target: { value: 'gemma4:12b' } })

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('chat.vision_model', 'gemma4:12b'))
    expect(onVisionChanged).toHaveBeenCalledWith('gemma4:12b')
    expect(api.putSetting).not.toHaveBeenCalledWith('chat.model', expect.anything())
  })

  it('a refused image-model write says so and reports no change', async () => {
    const { onVisionChanged } = renderSection(fakeApi({ seers: ['gemma4:12b'], visionWriteFails: true }))
    const picker = await screen.findByLabelText('Model that reads images')

    fireEvent.change(picker, { target: { value: 'gemma4:12b' } })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('503'))
    expect(onVisionChanged).not.toHaveBeenCalled()
  })

  it('says plainly when nothing installed can see', async () => {
    // "State if we don't have one" — and it must not read as a picker with
    // no options, which looks broken rather than empty.
    renderSection(fakeApi({ seers: [] }))
    const said = await screen.findByTestId('no-vision-model')
    expect(said.textContent).toContain('No installed model can see images')
    expect(screen.queryByLabelText('Model that reads images')).toBeNull()
  })

  it('does not report an unreadable catalogue as "nothing can see"', async () => {
    // One is a fact about his machine, the other about a request that failed.
    renderSection(fakeApi({ seers: [], seersReason: 'the model catalogue could not be read' }))
    const said = await screen.findByTestId('no-vision-model')
    expect(said.textContent).toContain('Could not tell')
    expect(said.textContent).not.toContain('No installed model can see')
  })
})
