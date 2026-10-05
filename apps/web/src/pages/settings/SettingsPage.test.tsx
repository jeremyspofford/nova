import { afterEach, describe, it, expect, onTestFinished, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'
import { ChatProvider } from '../../stores/chat-store'
import { ChatPage } from '../chat/ChatPage'
import { AuthProvider } from '../../stores/auth-store'
import { ThemeProvider } from '../../stores/theme-store'
import {
  explainRoute,
  getCatalog,
  getRoutes,
  getSettings,
  listAgents,
  putSetting,
  setChatPrimary,
  type Conversation,
  type StoredMessage,
} from '../../lib/api'

/**
 * Slice 2f Fix A, end to end: a switch made in Settings->Models has to be
 * visible in BOTH places without a message being sent — the Settings
 * list's own "Current" marker, and the chat badge on an entirely different
 * page. Rendering the real SettingsPage and the real ChatPage side by side
 * under one ChatProvider (exactly the App.tsx wiring) is the only way to
 * prove the two are not two independently-updated pieces of state that
 * could silently disagree.
 *
 * SettingsPage/ModelsSection's DEFAULT_API reaches the real lib/api module
 * (ModelsSection takes an injectable `api` prop for its OWN tests, but
 * SettingsPage does not thread one through — this proves the real wiring
 * end to end rather than adding a seam only this test would use), so that
 * module is mocked wholesale. ChatPage's `api`/`fetchImpl` seams are used
 * as-is, the same idiom ChatPage.test.tsx already uses.
 */
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getAuthState: vi.fn(async () => ({ has_users: false })),
    getSettings: vi.fn(async () => [
      { key: 'chat.model', type: 'str', default: '', description: '', value: 'qwen3:8b' },
      {
        key: 'appearance.default_preset',
        type: 'str',
        default: 'nova',
        description: '',
        value: 'nova',
      },
    ]),
    // 2026-09-08 (S11): putSetting answers with what core stored — the
    // fake echoes the write the way the real call does.
    putSetting: vi.fn(async (key: string, value: boolean | string | number) => ({ key, value })),
    getInstalledModels: vi.fn(async () => ['qwen3:8b', 'qwen3:14b']),
    getSuggestion: vi.fn(async () => ({
      tier: '8-12B',
      engine_suggestion: 'ollama',
      models: [
        { slug: 'qwen3:8b', label: 'Qwen3 8B', params_b: 8, min_vram_gb: 10, note: '' },
        { slug: 'qwen3:14b', label: 'Qwen3 14B', params_b: 14, min_vram_gb: 16, note: '' },
      ],
      rationale: 'fits the tier',
    })),
    getBackend: vi.fn(async () => ({
      kind: 'ollama',
      url: null,
      provider: null,
      model: null,
      api_key: null,
    })),
    pullModel: vi.fn(),
    getMachines: vi.fn(async () => ({ machines: [] })),
    // The one pick write: answers with what core stored.
    setChatPrimary: vi.fn(async (model: string) => ({ chat_model: model, chain: ['qwen3:8b'] })),
    // The Routing section's reads: the real calls unless a test says
    // otherwise, so every other test here sees exactly what it saw before.
    getRoutes: vi.fn(actual.getRoutes),
    getCatalog: vi.fn(actual.getCatalog),
    explainRoute: vi.fn(actual.explainRoute),
    listAgents: vi.fn(actual.listAgents),
  }
})

const noopFetch = vi.fn(
  async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '',
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    }) as unknown as Response,
)

function chatApi() {
  const conversation: Conversation = {
    id: 'c1',
    title: null,
    created_at: '',
    pending_turn: false,
    pending_turn_id: null,
    queued: [],
  }
  return {
    getActiveConversation: vi.fn(async () => conversation),
    // S24: the transcript read carries each message's room reply-count, so
    // the page can draw stubs from the same fetch that brings the messages.
    getMessages: vi.fn(
      async (): Promise<{ messages: StoredMessage[]; threads: Record<string, number> }> => ({
        messages: [],
        threads: {},
      }),
    ),
    getConversationState: vi.fn(async () => conversation),
    openThread: vi.fn(async () => {
      throw new Error('this test did not expect a room to be opened')
    }),
  } as never
}

/**
 * Settings is tabbed as of 2026-09-15, and the tab lives in the PATH — so
 * these render it at a route rather than bare, and each caller says which
 * tab its assertions live under. Rendering bare threw
 * "Cannot destructure property 'future'", which is react-router's way of
 * saying there is no Router above it.
 */
function renderApp(tab = 'models') {
  // initialModel mirrors what App.tsx's Gate feeds ChatPage in production —
  // its OWN settings fetch, read once at app start. It is exactly the
  // snapshot Fix A's bug left stale after a switch; passing it here (rather
  // than leaving ChatPage to default to '') makes the pre-switch assertion
  // below meaningful: the badge already agrees with Settings BEFORE any
  // switch, same as the real app.
  return render(
    <MemoryRouter initialEntries={[`/settings/${tab}`]}>
      <ThemeProvider>
        <AuthProvider>
          <ChatProvider fetchImpl={noopFetch}>
            <Routes>
              <Route path="/settings/:tab" element={<SettingsPage />} />
            </Routes>
            <ChatPage api={chatApi()} initialModel="qwen3:8b" />
          </ChatProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  )
}

describe('one pick, seen everywhere (Fix A, and 2026-10-05)', () => {
  it('Make primary in Routing moves the chat badge too, with no message sent', async () => {
    // The server's chat.model moves with the pick, as the real one does: the
    // switcher reads the STORED pick and follows it.
    let stored = 'qwen3:8b'
    const settingsBefore = vi.mocked(getSettings).getMockImplementation()
    const pickBefore = vi.mocked(setChatPrimary).getMockImplementation()
    onTestFinished(() => {
      vi.mocked(getSettings).mockImplementation(settingsBefore!)
      vi.mocked(setChatPrimary).mockImplementation(pickBefore!)
    })
    vi.mocked(getSettings).mockImplementation(async () => [
      { key: 'chat.model', type: 'str', default: '', description: '', value: stored },
      { key: 'appearance.default_preset', type: 'str', default: 'nova', description: '', value: 'nova' },
    ])
    vi.mocked(setChatPrimary).mockImplementation(async (model: string) => {
      stored = model
      return { chat_model: model, chain: ['qwen3:8b'] }
    })
    vi.mocked(getRoutes).mockImplementation(async () => ({
      roles: [{ role: 'chat', chain: ['hub:qwen3:14b'], reserved: false, builtin: true, protocol: 'chat' as const }],
      walls: [],
    }))
    vi.mocked(explainRoute).mockImplementation(async role => ({ role, chain: [], would_serve: null, reason: null }))
    vi.mocked(getCatalog).mockImplementation(async () => ({ fetched_at: 't', sources: [], rows: [] }))
    vi.mocked(listAgents).mockImplementation(async () => [])
    renderApp()

    // Pre-switch: qwen3:8b is the pick everywhere, no turn has run.
    await waitFor(() => expect(screen.getByTestId('route-chat-link-1').textContent).toContain('qwen3:8b'))
    await waitFor(() => expect(screen.getByTestId('chat-model').textContent).toBe('qwen3:8b'))

    fireEvent.click(screen.getByRole('button', { name: 'make primary chat hub:qwen3:14b' }))

    // The one pick write — never chat.model alone.
    await waitFor(() => expect(setChatPrimary).toHaveBeenCalledWith('hub:qwen3:14b'))
    expect(putSetting).not.toHaveBeenCalledWith('chat.model', expect.anything())
    // Settings and the chat badge both follow it — no message was ever sent.
    await waitFor(() => expect(screen.getByTestId('route-chat-link-1').textContent).toContain('hub:qwen3:14b'))
    await waitFor(() => expect(screen.getByTestId('chat-model').textContent).toBe('qwen3:14b'))
  })
})


describe('SettingsPage — the instance default theme', () => {
  it('reads a pre-redesign stored key as the theme that replaced it', async () => {
    vi.mocked(getSettings).mockResolvedValueOnce([
      { key: 'chat.model', type: 'str', default: '', description: '', value: 'qwen3:8b' },
      { key: 'appearance.default_preset', type: 'str', default: 'nova', description: '', value: 'ocean' },
    ])
    renderApp('appearance')
    const slate = await screen.findByRole('radio', { name: 'Slate' })
    await waitFor(() => expect(within(slate).getByText('Default')).toBeDefined())
    expect(screen.queryByText('ocean')).toBeNull()
  })
})

/**
 * S11: the proactive settings are only configurable if the section is
 * actually MOUNTED — a section that exists as a file and is never rendered
 * leaves the slice unswitchable from the app, which is exactly the gap this
 * work closed. It is mounted off the keys core reports, so a core that
 * predates the slice draws no switch whose write it would refuse by name.
 */
describe('SettingsPage — the proactive section', () => {
  const PROACTIVE = [
    { key: 'chat.model', type: 'str', default: '', description: '', value: 'qwen3:8b' },
    {
      key: 'proactive.enabled',
      type: 'bool',
      default: false,
      description: '',
      value: true,
    },
    {
      key: 'proactive.digest_at',
      type: 'str',
      default: '08:00',
      description: '',
      value: '07:15',
    },
    {
      key: 'proactive.max_notices_per_day',
      type: 'int',
      default: 20,
      description: '',
      value: 12,
    },
  ] as const

  it('renders the stored proactive settings when core exposes them', async () => {
    vi.mocked(getSettings).mockResolvedValueOnce([...PROACTIVE])
    renderApp('behaviour')

    const hour = (await screen.findByLabelText('Daily digest at')) as HTMLInputElement
    expect(hour.value).toBe('07:15')
    expect((screen.getByLabelText('Most findings in one digest') as HTMLInputElement).value).toBe('12')
    expect(screen.queryByTestId('proactive-off')).toBeNull()
  })

  it('draws no proactive controls on a core that does not have the keys', async () => {
    renderApp('behaviour')

    // Response quality is unconditional on the Behaviour tab, so waiting on
    // its heading proves the tab RENDERED before concluding the digest
    // fields are absent — otherwise this passes just as well on a blank page.
    await screen.findByText('Response quality')
    expect(screen.queryByLabelText('Daily digest at')).toBeNull()
    expect(screen.queryByTestId('proactive-meaning')).toBeNull()
  })
})

/**
 * The decision role's two switches (decision-role spec §6) are only
 * switchable if the Routing section is handed them — off the same one
 * settings fetch, and written back into it, the way every other section's
 * settings are. A core that does not list the keys draws no switch.
 */
describe('SettingsPage — the decision switches', () => {
  const WITH_SWITCHES = [
    { key: 'chat.model', type: 'str', default: '', description: '', value: 'qwen3:8b' },
    { key: 'decisions.local', type: 'bool', default: false, description: 'the local notice', value: false },
    { key: 'decisions.cloud', type: 'bool', default: true, description: 'the cloud notice', value: true },
  ] as const

  function routingReads() {
    vi.mocked(getRoutes).mockResolvedValue({
      roles: [{ role: 'decisions', chain: [], reserved: false, builtin: true, protocol: 'systemone', router: null }],
      walls: [],
    })
    vi.mocked(getCatalog).mockResolvedValue({ fetched_at: 't', sources: [], rows: [] })
    vi.mocked(listAgents).mockResolvedValue([])
    vi.mocked(explainRoute).mockResolvedValue({ role: 'decisions', chain: [], would_serve: null, reason: 'no chain' })
  }

  // Back to the real calls, so no other test here reads these answers.
  afterEach(async () => {
    const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
    vi.mocked(getRoutes).mockImplementation(actual.getRoutes)
    vi.mocked(getCatalog).mockImplementation(actual.getCatalog)
    vi.mocked(listAgents).mockImplementation(actual.listAgents)
    vi.mocked(explainRoute).mockImplementation(actual.explainRoute)
  })

  it('draws them in Routing from the settings core listed, and a switch writes back into the page', async () => {
    vi.mocked(getSettings).mockResolvedValueOnce([...WITH_SWITCHES])
    routingReads()
    renderApp('models')

    const local = (await screen.findByRole('switch', { name: 'Local decision model' })) as HTMLInputElement
    expect(local.checked).toBe(false)
    expect((screen.getByRole('switch', { name: 'Cloud decision model' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('the local notice')).toBeDefined()

    fireEvent.click(local)
    await waitFor(() => expect(putSetting).toHaveBeenCalledWith('decisions.local', true))
    await waitFor(() => expect(local.checked).toBe(true))
  })

  it('draws no switch on a core that does not list the keys', async () => {
    routingReads()
    renderApp('models')

    await screen.findByTestId('route-decisions')
    expect(screen.queryByRole('switch', { name: 'Local decision model' })).toBeNull()
  })
})
