import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ModelSelector, cloudGroups, localChoices, pickIsSmaller, shortModelName } from './ModelSelector'
import type { CatalogRow, RouteExplain, SettingDef } from '../../lib/api'

/**
 * The chat's model switcher. Load-bearing behaviours (2026-10-05): it shows
 * the order chat walks — the pick, then the fallbacks Settings edits, each
 * once — and what would answer right now; a pick goes through the one pick
 * write (setChatPrimary), never chat.model alone, and reaches the parent only
 * after core stored it; it offers only models that can chat on a machine Nova
 * runs.
 */

const GEMINI = 'openrouter:google/gemini-3.8-flash'
const DELL = 'dell:qwen3:8b'

function row(id: string, over: Partial<CatalogRow> = {}): CatalogRow {
  const [provider, ...rest] = id.split(':')
  return {
    id,
    provider,
    model: rest.join(':'),
    label: rest.join(':'),
    kind: 'cloud',
    sources: [],
    facts: {},
    capabilities: {},
    suitability: {},
    actions: ['use'],
    ...over,
  } as CatalogRow
}

const ROWS: CatalogRow[] = [
  row('hub:qwen3:8b', { kind: 'local', installed: true, actions: ['use', 'probe'], facts: { params_b: { value: 8, basis: 'declared', source: 'x' } } }),
  // An embedding model and a library pick: neither can answer a chat turn.
  row('hub:nomic-embed-text:latest', { kind: 'local', installed: true, actions: ['probe', 'remove'] }),
  row('library:qwen3:14b', { kind: 'local', installed: false, actions: ['pull'], facts: { params_b: { value: 14, basis: 'vetted', source: 'curated' } } }),
  row('openrouter:openai/gpt-x'),
  row(GEMINI),
  row('cerebras:llama'),
]

function walk(servedBy: string, link: number, verdicts: { id: string; verdict: string; reason?: string }[]): RouteExplain {
  return {
    role: 'chat',
    chain: verdicts.map((v, i) => ({ link: i + 1, id: v.id, verdict: v.verdict, reason: v.reason ?? null })) as never,
    would_serve: { role: 'chat', link, reason: link > 1 ? 'fell back to link 2 — dell could not be reached' : null, served_by: servedBy, standby: false },
    reason: null,
  }
}

function fakeApi(
  over: { fallbacks?: string[]; explained?: RouteExplain; pickFails?: boolean; stored?: string; note?: string } = {},
) {
  return {
    // What core stored as chat.model; none unless a test says (the parent's
    // value then stands).
    getSettings: vi.fn(
      async (): Promise<SettingDef[]> =>
        over.stored === undefined
          ? []
          : [{ key: 'chat.model', type: 'str', default: '', description: '', value: over.stored } as SettingDef],
    ),
    getCatalog: vi.fn(async () => ({ fetched_at: 't', sources: [], rows: ROWS })),
    getRoutes: vi.fn(async () => ({ roles: [{ role: 'chat', chain: over.fallbacks ?? [GEMINI], reserved: false }], walls: [] })),
    explainRoute: vi.fn(async () => over.explained ?? walk(DELL, 1, [{ id: DELL, verdict: 'runnable' }, { id: GEMINI, verdict: 'runnable' }])),
    setChatPrimary: vi.fn(async (model: string) => {
      if (over.pickFails) throw new Error('the gateway refused the chain (400)')
      return { chat_model: model, chain: [DELL, GEMINI].filter(id => id !== model), ...(over.note ? { note: over.note } : {}) }
    }),
  }
}

async function renderSelector(props: React.ComponentProps<typeof ModelSelector>) {
  const utils = render(<ModelSelector {...props} />)
  await act(async () => {})
  return utils
}

async function openMenu() {
  fireEvent.click(screen.getByTestId('chat-model-trigger'))
  await waitFor(() => expect(screen.getByTestId('chat-model-menu')).toBeDefined())
  await act(async () => {})
}

describe('ModelSelector', () => {
  it('shows the pick verbatim in the chat-model element', async () => {
    await renderSelector({ currentModel: 'hub:qwen3:8b', onModelChanged: vi.fn(), api: fakeApi() })
    expect(screen.getByTestId('chat-model').textContent).toBe('qwen3:8b')
  })

  it('lists the chat order — pick first, each fallback once — with the pick selected', async () => {
    // The live state of 2026-10-05: link 1 and link 2 were both Gemini.
    const api = fakeApi({ fallbacks: [GEMINI, DELL] })
    await renderSelector({ currentModel: GEMINI, onModelChanged: vi.fn(), api })
    await openMenu()

    const order = screen.getByTestId('chat-model-order')
    const options = within(order).getAllByRole('option')
    expect(options.map(o => o.getAttribute('data-testid'))).toEqual([
      `chat-model-option-${GEMINI}`,
      `chat-model-option-${DELL}`,
    ])
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    expect(options[0].textContent).toContain('primary')
    expect(options[1].textContent).toContain('fallback 1')
  })

  it('offers installed chat models, never an embedding model or a library pick', async () => {
    await renderSelector({ currentModel: GEMINI, onModelChanged: vi.fn(), api: fakeApi() })
    await openMenu()
    await waitFor(() => expect(screen.getByTestId('chat-model-group-installed')).toBeDefined())
    expect(screen.getByTestId('chat-model-option-hub:qwen3:8b')).toBeDefined()
    expect(screen.queryByTestId('chat-model-option-hub:nomic-embed-text:latest')).toBeNull()
    expect(screen.queryByTestId('chat-model-option-library:qwen3:14b')).toBeNull()
    // A model in the order is listed there, not again in its provider group.
    expect(within(screen.getByTestId('chat-model-group-openrouter')).queryByTestId(`chat-model-option-${GEMINI}`)).toBeNull()
  })

  it('reads the catalogue only when the menu first opens', async () => {
    const api = fakeApi()
    await renderSelector({ currentModel: GEMINI, onModelChanged: vi.fn(), api })
    expect(api.getCatalog).not.toHaveBeenCalled()
    await openMenu()
    expect(api.getCatalog).toHaveBeenCalledTimes(1)
  })

  it('a model list in the wrong shape is a stated failed read, never a crash', async () => {
    const api = { ...fakeApi(), getCatalog: vi.fn(async () => ({ object: 'list', data: [] }) as never) }
    await renderSelector({ currentModel: GEMINI, onModelChanged: vi.fn(), api })
    await openMenu()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not read the model list'))
    expect(screen.getByTestId('chat-model-order')).toBeDefined()
  })

  it('a pick goes through the one pick write and reaches the parent only after it is stored', async () => {
    const api = fakeApi()
    const onModelChanged = vi.fn()
    await renderSelector({ currentModel: DELL, onModelChanged, api })
    await openMenu()
    await waitFor(() => expect(screen.getByTestId('chat-model-option-openrouter:openai/gpt-x')).toBeDefined())

    fireEvent.click(screen.getByTestId('chat-model-option-openrouter:openai/gpt-x'))

    await waitFor(() => expect(api.setChatPrimary).toHaveBeenCalledWith('openrouter:openai/gpt-x'))
    expect(onModelChanged).toHaveBeenCalledWith('openrouter:openai/gpt-x')
  })

  it('a refused pick states the reason and changes nothing', async () => {
    const api = fakeApi({ pickFails: true })
    const onModelChanged = vi.fn()
    await renderSelector({ currentModel: DELL, onModelChanged, api })
    await openMenu()
    await waitFor(() => expect(screen.getByTestId('chat-model-option-cerebras:llama')).toBeDefined())

    fireEvent.click(screen.getByTestId('chat-model-option-cerebras:llama'))

    await waitFor(() => expect(screen.getByText(/the gateway refused the chain/)).toBeDefined())
    expect(onModelChanged).not.toHaveBeenCalled()
  })

  it('picking the pick again writes nothing', async () => {
    const api = fakeApi()
    const onModelChanged = vi.fn()
    await renderSelector({ currentModel: DELL, onModelChanged, api })
    await openMenu()
    fireEvent.click(screen.getByTestId(`chat-model-option-${DELL}`))
    expect(api.setChatPrimary).not.toHaveBeenCalled()
    expect(onModelChanged).not.toHaveBeenCalled()
  })

  it('says when the pick cannot answer and a fallback does — on the trigger and in the menu', async () => {
    const api = fakeApi({
      explained: walk(GEMINI, 2, [
        { id: DELL, verdict: 'unreachable', reason: 'dell could not be reached' },
        { id: GEMINI, verdict: 'runnable' },
      ]),
    })
    await renderSelector({ currentModel: DELL, onModelChanged: vi.fn(), api })

    expect(screen.getByTestId('chat-model').textContent).toBe(DELL)
    expect(screen.getByTestId('chat-model-answering').textContent).toBe('gemini-3.8-flash')
    expect(screen.getByTestId('chat-model-trigger').getAttribute('title')).toContain('dell could not be reached')

    await openMenu()
    expect(screen.getByTestId('chat-model-serving').textContent).toContain(GEMINI)
    expect(screen.getByTestId(`chat-model-option-${DELL}`).textContent).toContain('unreachable')
  })

  it('follows a pick stored elsewhere instead of naming its own stale one', async () => {
    // A pick made on the phone left the laptop's switcher on the old model:
    // its value is a cache that moves only when this browser starts a turn.
    const onModelChanged = vi.fn()
    await renderSelector({ currentModel: DELL, onModelChanged, api: fakeApi({ stored: GEMINI }) })
    await waitFor(() => expect(onModelChanged).toHaveBeenCalledWith(GEMINI))
  })

  it('an empty stored pick is "no pick", not a cue to keep the stale one', async () => {
    // The Jev Router switch stores '' when the pick it replaced has no
    // provider any more.
    const onModelChanged = vi.fn()
    await renderSelector({ currentModel: DELL, onModelChanged, api: fakeApi({ stored: '' }) })
    await waitFor(() => expect(onModelChanged).toHaveBeenCalledWith(''))
  })

  it('keeps the parent\'s pick when the settings cannot be read', async () => {
    const onModelChanged = vi.fn()
    const api = { ...fakeApi(), getSettings: vi.fn(async () => { throw new Error('core is restarting (502)') }) }
    await renderSelector({ currentModel: DELL, onModelChanged, api })
    await waitFor(() => expect(api.explainRoute).toHaveBeenCalledWith('chat', DELL))
    expect(onModelChanged).not.toHaveBeenCalled()
  })

  it('says what a pick did not keep, beside the switch', async () => {
    const api = fakeApi({ note: "chat's fallbacks could not be saved — link 'gone:x' does not name a registered provider" })
    await renderSelector({ currentModel: DELL, onModelChanged: vi.fn(), api })
    await openMenu()
    await waitFor(() => expect(screen.getByTestId('chat-model-option-cerebras:llama')).toBeDefined())
    fireEvent.click(screen.getByTestId('chat-model-option-cerebras:llama'))
    await waitFor(() => expect(screen.getByTestId('chat-model-note').textContent).toContain('could not be saved'))
  })

  it('names no fallback while the pick itself would answer', async () => {
    await renderSelector({ currentModel: DELL, onModelChanged: vi.fn(), api: fakeApi() })
    expect(screen.queryByTestId('chat-model-answering')).toBeNull()
  })

  it('shows the accuracy note only while open, warmer when the pick is on the smaller end', async () => {
    await renderSelector({ currentModel: 'hub:qwen3:8b', onModelChanged: vi.fn(), api: fakeApi() })
    expect(screen.queryByTestId('chat-model-accuracy-note')).toBeNull()
    await openMenu()
    const note = await screen.findByTestId('chat-model-accuracy-note')
    expect(note.textContent).toMatch(/accuracy/i)
    expect(note.textContent).not.toMatch(/\d+%/)
    await waitFor(() => expect(note.className).toContain('text-warning'))
  })
})

describe('the switcher helpers', () => {
  it('cloudGroups never lists a decision model among the chat models', () => {
    // Picking one would end every chat turn. The gateway offers it no `use`
    // action; the picker lists only what it offers.
    const gpt = row('openrouter:openai/gpt-x')
    const jev = row('openrouter:~typesafe/jev-latest', {
      suitability: { decisions: { value: true, basis: 'declared', source: 'provider-listing' } },
      actions: [],
    })
    expect(cloudGroups([gpt, jev])).toEqual([{ provider: 'openrouter', rows: [gpt] }])
  })

  it('localChoices keeps only installed models the gateway offers for chat', () => {
    expect(localChoices(ROWS).map(r => r.id)).toEqual(['hub:qwen3:8b'])
  })

  it('shortModelName keeps the model part of an id', () => {
    expect(shortModelName(GEMINI)).toBe('gemini-3.8-flash')
    expect(shortModelName(DELL)).toBe('qwen3:8b')
    expect(shortModelName('qwen3:8b')).toBe('8b')
  })

  it('pickIsSmaller needs two stated sizes and a sized pick', () => {
    expect(pickIsSmaller(ROWS, 'hub:qwen3:8b')).toBe(true)
    expect(pickIsSmaller(ROWS, 'qwen3:8b')).toBe(true)
    expect(pickIsSmaller(ROWS, GEMINI)).toBe(false)
    expect(pickIsSmaller([ROWS[0]], 'hub:qwen3:8b')).toBe(false)
  })
})
