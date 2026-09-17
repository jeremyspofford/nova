import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { ProvidersSection, fillPlaceholders, formatContext, formatPrice } from './ProvidersSection'
import type { Provider, ProviderListing, ProviderPreset } from '../../lib/api'

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'openrouter',
    adapter: 'openai-chat',
    base_url: 'https://openrouter.ai/api/v1',
    auth_shape: 'static-bearer',
    api_key: '•••4242',
    default_model: null,
    model_note: null,
    preset: 'openrouter',
    builtin: false,
    is_default: false,
    // RELATIVE to now, not a fixed instant (2026-09-12): the row's clause
    // switches from "N ago" to an absolute date once a check is old enough, so
    // a hardcoded date made this suite pass until the calendar caught up with
    // it and then fail every run for a reason nothing had changed.
    verified_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    listing: 'available',
    listing_note: '431 models listed',
    key_proven: true,
    verify_note: '431 models listed; the listing accepted the key',
    created_at: '2026-09-05T00:00:00Z',
    updated_at: '2026-09-05T00:00:00Z',
    ...overrides,
  }
}

const OLLAMA = provider({
  name: 'ollama',
  adapter: 'ollama',
  base_url: 'http://ollama:11434',
  auth_shape: 'none',
  api_key: null,
  preset: null,
  builtin: true,
  is_default: true,
  // Never verified through the registry — the gateway seeds it.
  verified_at: null,
  listing: 'unknown',
  listing_note: null,
  key_proven: null,
  verify_note: null,
})

const PRESETS: ProviderPreset[] = [
  {
    name: 'openrouter',
    label: 'OpenRouter',
    adapter: 'openai-chat',
    base_url: 'https://openrouter.ai/api/v1',
    auth_shape: 'static-bearer',
    docs_url: 'https://openrouter.ai/docs',
    model_note: 'vendor/model ids',
  },
  {
    name: 'azure-openai',
    label: 'Azure OpenAI',
    adapter: 'openai-chat',
    base_url: 'https://{resource}.openai.azure.com/openai/v1',
    auth_shape: 'api-key-header',
    placeholders: ['resource'],
  },
]

const LISTING: ProviderListing = {
  source: 'openrouter',
  fetched_at: '2026-09-05T12:00:00Z',
  models: [
    {
      id: 'anthropic/claude-sonnet-5',
      owned_by: 'openrouter',
      name: 'Anthropic: Claude Sonnet 5',
      context_length: 1_000_000,
      pricing: { prompt: 0.000002, completion: 0.00001 },
    },
    { id: 'openai/gpt-x', owned_by: 'openrouter' },
  ],
}

function renderSection(
  api: Partial<{
    getProviders: ReturnType<typeof vi.fn>
    getProviderPresets: ReturnType<typeof vi.fn>
    createProvider: ReturnType<typeof vi.fn>
    updateProvider: ReturnType<typeof vi.fn>
    deleteProvider: ReturnType<typeof vi.fn>
    makeDefaultProvider: ReturnType<typeof vi.fn>
    getProviderModels: ReturnType<typeof vi.fn>
    putSetting: ReturnType<typeof vi.fn>
  }> = {},
  chatModel = 'qwen3:8b',
) {
  const full = {
    getProviders: vi.fn(async () => [OLLAMA, provider()]),
    getProviderPresets: vi.fn(async () => PRESETS),
    createProvider: vi.fn(async (p: { name: string }) => provider({ name: p.name })),
    updateProvider: vi.fn(async (name: string) => provider({ name })),
    deleteProvider: vi.fn(async (name: string) => ({ deleted: name })),
    makeDefaultProvider: vi.fn(async (name: string) => provider({ name, is_default: true })),
    getProviderModels: vi.fn(async () => LISTING),
    putSetting: vi.fn(async () => undefined),
    ...api,
  }
  const onModelChanged = vi.fn()
  return {
    ...render(<ProvidersSection chatModel={chatModel} onModelChanged={onModelChanged} api={full} />),
    api: full,
    onModelChanged,
  }
}

describe('ProvidersSection — formatting helpers', () => {
  it('prices are per million tokens and absent when the provider stated none', () => {
    expect(formatPrice(LISTING.models[0])).toBe('$2 / $10 per 1M')
    expect(formatPrice(LISTING.models[1])).toBeNull()
  })

  it('context length is human-sized and absent when unstated', () => {
    expect(formatContext(LISTING.models[0])).toBe('1M ctx')
    expect(formatContext({ id: 'x', owned_by: 'y', context_length: 128_000 })).toBe('128K ctx')
    expect(formatContext(LISTING.models[1])).toBeNull()
  })

  it('placeholders fill from typed values and stay visible when unfilled', () => {
    expect(
      fillPlaceholders('https://{resource}.openai.azure.com/openai/v1', { resource: 'acme' }),
    ).toBe('https://acme.openai.azure.com/openai/v1')
    expect(fillPlaceholders('https://{region}.x', {})).toBe('https://{region}.x')
  })
})

describe('ProvidersSection', () => {
  it('lists every provider with its protocol, masked key and default marker', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByTestId('provider-openrouter')).toBeTruthy())
    const ollama = screen.getByTestId('provider-ollama')
    expect(ollama.textContent).toContain('Bundled Ollama')
    expect(ollama.textContent).toContain('default for bare model ids')
    expect(within(ollama).queryByRole('button', { name: /remove ollama/i })).toBeNull()
    const openrouter = screen.getByTestId('provider-openrouter')
    expect(openrouter.textContent).toContain('•••4242')
    expect(openrouter.textContent).toContain('OpenAI-compatible chat')
    expect(within(openrouter).getByRole('button', { name: /remove openrouter/i })).toBeTruthy()
  })

  it('a failed load states the reason', async () => {
    renderSection({
      getProviders: vi.fn(async () => {
        throw new Error('the gateway is unreachable — ConnectError')
      }),
    })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('the gateway is unreachable'),
    )
  })

  it('adding from the OpenRouter preset sends the preset shape and shows the new row', async () => {
    const { api } = renderSection({ getProviders: vi.fn(async () => [OLLAMA]) })
    await waitFor(() => expect(screen.getByRole('button', { name: /add a provider/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add a provider/i }))
    const form = screen.getByTestId('provider-form')
    expect((within(form).getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://openrouter.ai/api/v1',
    )
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'sk-or-1' } })
    fireEvent.submit(form)

    await waitFor(() => expect(api.createProvider).toHaveBeenCalledTimes(1))
    expect(api.createProvider.mock.calls[0][0]).toEqual({
      name: 'openrouter',
      adapter: 'openai-chat',
      base_url: 'https://openrouter.ai/api/v1',
      auth_shape: 'static-bearer',
      api_key: 'sk-or-1',
      preset: 'openrouter',
      model_note: 'vendor/model ids',
    })
    await waitFor(() => expect(screen.queryByTestId('provider-form')).toBeNull())
  })

  it('a refused verify shows the provider\'s reason and keeps the form open', async () => {
    const { api } = renderSection({
      getProviders: vi.fn(async () => [OLLAMA]),
      createProvider: vi.fn(async () => {
        throw new Error("could not verify provider 'openrouter' — Invalid API key")
      }),
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /add a provider/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add a provider/i }))
    const form = screen.getByTestId('provider-form')
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'bad' } })
    fireEvent.submit(form)

    await waitFor(() => expect(api.createProvider).toHaveBeenCalled())
    await waitFor(() =>
      expect(within(screen.getByTestId('provider-form')).getByRole('alert').textContent).toContain(
        'Invalid API key',
      ),
    )
  })

  it('a preset with a placeholder cannot be saved until it is filled', async () => {
    renderSection({ getProviders: vi.fn(async () => [OLLAMA]) })
    await waitFor(() => expect(screen.getByRole('button', { name: /add a provider/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add a provider/i }))
    const form = screen.getByTestId('provider-form')
    fireEvent.change(within(form).getByLabelText('Preset'), { target: { value: 'azure-openai' } })
    const save = within(form).getByRole('button', { name: /verify and save/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(within(form).getByLabelText('resource'), { target: { value: 'acme' } })
    expect((within(form).getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://acme.openai.azure.com/openai/v1',
    )
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'k' } })
    expect(save.disabled).toBe(false)
  })

  it('opening a provider fetches its live listing, labelled, and Use switches the model', async () => {
    const { api, onModelChanged } = renderSection()
    await waitFor(() => expect(screen.getByTestId('provider-openrouter')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-openrouter'))

    await waitFor(() => expect(screen.getByTestId('model-anthropic/claude-sonnet-5')).toBeTruthy())
    expect(api.getProviderModels).toHaveBeenCalledWith('openrouter')
    const panel = screen.getByTestId('provider-models-openrouter')
    expect(panel.textContent).toContain('2 models from openrouter')
    const row = screen.getByTestId('model-anthropic/claude-sonnet-5')
    expect(row.textContent).toContain('1M ctx')
    expect(row.textContent).toContain('$2 / $10 per 1M')
    // A model the provider stated nothing about shows no invented numbers.
    expect(screen.getByTestId('model-openai/gpt-x').textContent).not.toContain('ctx')

    fireEvent.click(within(row).getByRole('button', { name: /use anthropic\/claude-sonnet-5/i }))
    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'openrouter:anthropic/claude-sonnet-5'),
    )
    expect(onModelChanged).toHaveBeenCalledWith('openrouter:anthropic/claude-sonnet-5')
  })

  it('the current model is marked, not offered again', async () => {
    renderSection({}, 'openrouter:anthropic/claude-sonnet-5')
    await waitFor(() => expect(screen.getByTestId('provider-openrouter')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-openrouter'))
    await waitFor(() => expect(screen.getByTestId('model-anthropic/claude-sonnet-5')).toBeTruthy())
    const row = screen.getByTestId('model-anthropic/claude-sonnet-5')
    expect(row.textContent).toContain('current')
    expect(within(row).queryByRole('button', { name: /use/i })).toBeNull()
  })

  it('a provider with no listing offers a typed model id instead of an empty list', async () => {
    const { api, onModelChanged } = renderSection({
      getProviders: vi.fn(async () => [
        OLLAMA,
        provider({ name: 'azure', listing: 'unavailable', model_note: 'deployment name' }),
      ]),
      getProviderModels: vi.fn(async () => {
        throw new Error('https://x/models answered 404 — no model listing; type a model id')
      }),
    })
    await waitFor(() => expect(screen.getByTestId('provider-azure')).toBeTruthy())
    expect(screen.getByTestId('provider-azure').textContent).toContain('no model listing')
    fireEvent.click(screen.getByTestId('toggle-models-azure'))
    await waitFor(() => expect(screen.getByLabelText('Model id for azure')).toBeTruthy())
    expect(screen.queryByText(/models from/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Model id for azure'), { target: { value: 'gpt-5-deploy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'azure:gpt-5-deploy'))
    expect(onModelChanged).toHaveBeenCalledWith('azure:gpt-5-deploy')
  })

  it('a failed switch states the reason and does not report a change', async () => {
    const { api, onModelChanged } = renderSection({
      putSetting: vi.fn(async () => {
        throw new Error('the server refused (500)')
      }),
    })
    await waitFor(() => expect(screen.getByTestId('provider-openrouter')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-openrouter'))
    await waitFor(() => expect(screen.getByTestId('model-openai/gpt-x')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('model-openai/gpt-x')).getByRole('button', { name: /use/i }))
    await waitFor(() => expect(api.putSetting).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
    expect(onModelChanged).not.toHaveBeenCalled()
  })

  it('removing asks first, then deletes and drops the row', async () => {
    const { api } = renderSection()
    await waitFor(() => expect(screen.getByTestId('provider-openrouter')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /remove openrouter/i }))
    expect(api.deleteProvider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.deleteProvider).toHaveBeenCalledWith('openrouter'))
    await waitFor(() => expect(screen.queryByTestId('provider-openrouter')).toBeNull())
  })

  it('make default moves the marker only after the server said so', async () => {
    const { api } = renderSection()
    await waitFor(() => expect(screen.getByTestId('provider-openrouter')).toBeTruthy())
    fireEvent.click(
      within(screen.getByTestId('provider-openrouter')).getByRole('button', { name: /make default/i }),
    )
    await waitFor(() => expect(api.makeDefaultProvider).toHaveBeenCalledWith('openrouter'))
    await waitFor(() =>
      expect(screen.getByTestId('provider-openrouter').textContent).toContain('default for bare model ids'),
    )
    expect(screen.getByTestId('provider-ollama').textContent).not.toContain('default for bare model ids')
  })
})


describe('ProvidersSection — the local row writes a qualified id too', () => {
  it('Use on the bundled ollama row writes ollama:<model>, never a bare id', async () => {
    const { api, onModelChanged } = renderSection({
      getProviderModels: vi.fn(async () => ({
        source: 'ollama',
        fetched_at: '2026-09-05T12:00:00Z',
        models: [{ id: 'qwen3:14b', owned_by: 'ollama' }],
      })),
    })
    await waitFor(() => expect(screen.getByTestId('provider-ollama')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-ollama'))
    await waitFor(() => expect(screen.getByTestId('model-qwen3:14b')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('model-qwen3:14b')).getByRole('button', { name: /use/i }))
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('chat.model', 'ollama:qwen3:14b'))
    expect(onModelChanged).toHaveBeenCalledWith('ollama:qwen3:14b')
  })

  it('a bare chat.model written before the registry still reads as current on the ollama row', async () => {
    renderSection(
      {
        getProviderModels: vi.fn(async () => ({
          source: 'ollama',
          fetched_at: '2026-09-05T12:00:00Z',
          models: [{ id: 'qwen3:8b', owned_by: 'ollama' }],
        })),
      },
      'qwen3:8b',
    )
    await waitFor(() => expect(screen.getByTestId('provider-ollama')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-ollama'))
    await waitFor(() => expect(screen.getByTestId('model-qwen3:8b').textContent).toContain('current'))
  })
})


describe('ProvidersSection — the owner can see the verdict and find the models', () => {
  it('a proven key reads "Key verified <when> — <how>", green, from the structured verdict', async () => {
    renderSection({
      getProviders: vi.fn(async () => [
        OLLAMA,
        provider({
          verified_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
          key_proven: true,
          verify_note:
            '430 models listed; the listing is public, so the key was proven with a 1-token completion on x/y',
          // The listing has since been re-fetched and its note rewritten —
          // the verdict must not read from it.
          listing_note: '430 models listed',
        }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId('provider-status-openrouter')).toBeTruthy())
    const el = screen.getByTestId('provider-status-openrouter')
    expect(el.textContent).toBe(
      'Key verified 2m ago — 430 models listed; the listing is public, so the key was proven with a 1-token completion on x/y',
    )
    expect(el.className).toContain('text-success')
    expect(el.className).not.toContain('text-warning')
    // The bundled row is never verified through the registry: no invented line.
    expect(screen.queryByTestId('provider-status-ollama')).toBeNull()
  })

  it('an unproven key is the warning colour on key_proven=false regardless of the wording', async () => {
    renderSection({
      getProviders: vi.fn(async () => [
        provider({ key_proven: false, verify_note: 'a 1-token test answered 402 (no credits)' }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId('provider-status-openrouter')).toBeTruthy())
    const el = screen.getByTestId('provider-status-openrouter')
    expect(el.textContent).toContain('Checked')
    expect(el.textContent).toContain('402')
    expect(el.className).toContain('text-warning')
    expect(el.className).not.toContain('text-success')
  })

  it('a row whose key was never tested says so and is neither success nor warning', async () => {
    renderSection({
      getProviders: vi.fn(async () => [
        provider({ name: 'legacy', key_proven: null, verify_note: null }),
        provider({
          name: 'azure',
          listing: 'unavailable',
          key_proven: null,
          verify_note: 'x/models answered 404 — the key was not tested; the first chat turn will tell',
        }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId('provider-status-legacy')).toBeTruthy())
    // A row with no server verdict text gets NO clause — nothing invented.
    expect(screen.getByTestId('provider-status-legacy').textContent).toMatch(/^Checked \S+ ago$|^Checked just now$/)
    expect(screen.getByTestId('provider-status-azure').textContent).toContain('the key was not tested')
    for (const name of ['legacy', 'azure']) {
      const el = screen.getByTestId(`provider-status-${name}`)
      expect(el.textContent.startsWith('Checked')).toBe(true)
      expect(el.className).not.toContain('text-success')
      expect(el.className).not.toContain('text-warning')
    }
  })

  it('a refused listing is shown as a warning beside a still-true verdict', async () => {
    renderSection({
      getProviders: vi.fn(async () => [
        provider({
          listing: 'unknown',
          listing_note: 'the last listing was refused (401): key revoked',
          key_proven: true,
        }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId('provider-listing-warning-openrouter')).toBeTruthy())
    expect(screen.getByTestId('provider-listing-warning-openrouter').textContent).toContain('key revoked')
    expect(screen.getByTestId('provider-status-openrouter').className).toContain('text-success')
  })

  it('after a listing fetch the row re-reads its server state', async () => {
    const before = provider({ listing: 'available', listing_note: '431 models listed' })
    const after = provider({ listing: 'unknown', listing_note: 'the last listing was refused (401): revoked' })
    const getProviders = vi.fn(async () => [OLLAMA, before])
    const { api } = renderSection({
      getProviders,
      getProviderModels: vi.fn(async () => {
        getProviders.mockImplementation(async () => [OLLAMA, after])
        throw new Error('the last listing was refused (401): revoked')
      }),
    })
    await waitFor(() => expect(screen.getByTestId('toggle-models-openrouter')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-openrouter'))
    await waitFor(() => expect(screen.getByTestId('provider-listing-warning-openrouter')).toBeTruthy())
    expect(api.getProviders).toHaveBeenCalledTimes(2)
  })

  it('every row carries an explicit Show models control that opens the list', async () => {
    const { api } = renderSection()
    await waitFor(() => expect(screen.getByTestId('toggle-models-openrouter')).toBeTruthy())
    const toggle = screen.getByTestId('toggle-models-openrouter')
    expect(toggle.textContent).toContain('Show models')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByTestId('provider-models-openrouter')).toBeTruthy())
    expect(api.getProviderModels).toHaveBeenCalledWith('openrouter')
    expect(screen.getByTestId('toggle-models-openrouter').textContent).toContain('Hide models')
    expect(screen.getByTestId('provider-models-openrouter').textContent).toContain('press Use')
  })

  it('a provider with no listing says Pick a model instead of Show models', async () => {
    renderSection({
      getProviders: vi.fn(async () => [provider({ name: 'azure', listing: 'unavailable' })]),
    })
    await waitFor(() => expect(screen.getByTestId('toggle-models-azure')).toBeTruthy())
    expect(screen.getByTestId('toggle-models-azure').textContent).toContain('Pick a model')
  })

  it('the row just added opens itself with its models loaded', async () => {
    const { api } = renderSection({
      getProviders: vi.fn(async () => [OLLAMA]),
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /add a provider/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add a provider/i }))
    const form = screen.getByTestId('provider-form')
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'sk-or-1' } })
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByTestId('provider-models-openrouter')).toBeTruthy())
    expect(api.getProviderModels).toHaveBeenCalledWith('openrouter')
    await waitFor(() => expect(screen.getByTestId('model-openai/gpt-x')).toBeTruthy())
    expect(screen.getByTestId('toggle-models-openrouter').getAttribute('aria-expanded')).toBe('true')
    // The verdict shown is the server's returned row, not the draft.
    expect(screen.getByTestId('provider-status-openrouter').textContent).toContain(
      'the listing accepted the key',
    )
  })

  it('the panel never says press Use when there is nothing to use', async () => {
    renderSection({
      getProviderModels: vi.fn(async () => ({ source: 'openrouter', fetched_at: '2026-09-05T12:00:00Z', models: [] })),
    })
    await waitFor(() => expect(screen.getByTestId('toggle-models-openrouter')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-openrouter'))
    await waitFor(() => expect(screen.getByTestId('provider-models-openrouter')).toBeTruthy())
    const panel = screen.getByTestId('provider-models-openrouter').textContent ?? ''
    expect(panel).toContain('listed no models')
    expect(panel).not.toContain('press Use')
  })

  it('an unlisted provider\'s open button says Hide, not Hide models', async () => {
    renderSection({
      getProviders: vi.fn(async () => [provider({ name: 'azure', listing: 'unavailable' })]),
      getProviderModels: vi.fn(async () => {
        throw new Error('no model listing; type a model id')
      }),
    })
    await waitFor(() => expect(screen.getByTestId('toggle-models-azure')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-azure'))
    await waitFor(() => expect(screen.getByLabelText('Model id for azure')).toBeTruthy())
    expect(screen.getByTestId('toggle-models-azure').textContent).toBe('Hide')
  })
})


describe('ProvidersSection — Re-verify', () => {
  it('a row saved before the verdict existed can be re-verified in place, key untouched', async () => {
    const stale = provider({ key_proven: null, verify_note: null })
    const proven = provider({
      key_proven: true,
      verify_note: '430 models listed; the listing is public, so the key was proven with a 1-token completion on a/b',
    })
    const { api } = renderSection({
      getProviders: vi.fn(async () => [OLLAMA, stale]),
      updateProvider: vi.fn(async () => proven),
    })
    await waitFor(() => expect(screen.getByTestId('provider-status-openrouter')).toBeTruthy())
    expect(screen.getByTestId('provider-status-openrouter').textContent).toMatch(/^Checked /)
    fireEvent.click(screen.getByRole('button', { name: /re-verify openrouter/i }))
    await waitFor(() =>
      expect(screen.getByTestId('provider-status-openrouter').textContent).toContain('key was proven'),
    )
    // An EMPTY update: the stored key is kept server-side, nothing is re-pasted.
    expect(api.updateProvider).toHaveBeenCalledWith('openrouter', {})
    expect(screen.getByTestId('provider-status-openrouter').className).toContain('text-success')
    // The bundled row has nothing to re-verify.
    expect(screen.queryByRole('button', { name: /re-verify ollama/i })).toBeNull()
  })

  it('a refused re-verify states the reason and leaves the row as it was', async () => {
    renderSection({
      updateProvider: vi.fn(async () => {
        throw new Error("could not verify provider 'openrouter' — the key was refused on a test completion")
      }),
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /re-verify openrouter/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /re-verify openrouter/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refused on a test completion'))
    expect(screen.getByTestId('provider-status-openrouter').textContent).toContain('the listing accepted the key')
  })
})


describe('ProvidersSection — a listing refresh never touches another row\'s default', () => {
  it('merges only the listing and verdict fields, not is_default', async () => {
    const stale = provider({ is_default: true })
    const other = provider({ name: 'other', is_default: false })
    const getProviders = vi.fn(async () => [OLLAMA, stale, other])
    const { api } = renderSection({
      getProviders,
      makeDefaultProvider: vi.fn(async () => provider({ name: 'other', is_default: true })),
      getProviderModels: vi.fn(async () => {
        // The snapshot the refresh will read still says openrouter is default.
        getProviders.mockImplementation(async () => [
          OLLAMA,
          provider({ is_default: true, listing_note: 'refreshed' }),
          other,
        ])
        return LISTING
      }),
    })
    await waitFor(() => expect(screen.getByTestId('toggle-models-openrouter')).toBeTruthy())
    fireEvent.click(screen.getByTestId('toggle-models-openrouter'))
    fireEvent.click(within(screen.getByTestId('provider-other')).getByRole('button', { name: /make default/i }))
    await waitFor(() => expect(api.makeDefaultProvider).toHaveBeenCalledWith('other'))
    await waitFor(() => expect(api.getProviders).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('provider-other').textContent).toContain('default for bare model ids'),
    )
    expect(screen.getByTestId('provider-openrouter').textContent).not.toContain('default for bare model ids')
  })
})
