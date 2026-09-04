import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SettingsPage } from './SettingsPage'
import { ChatProvider } from '../../stores/chat-store'
import { ChatPage } from '../chat/ChatPage'
import { AuthProvider } from '../../stores/auth-store'
import { ThemeProvider } from '../../stores/theme-store'
import type { Conversation, StoredMessage } from '../../lib/api'

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
        default: 'default',
        description: '',
        value: 'default',
      },
    ]),
    putSetting: vi.fn(async () => {}),
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
  const conversation: Conversation = { id: 'c1', title: null, created_at: '', pending_turn: false }
  return {
    getActiveConversation: vi.fn(async () => conversation),
    getMessages: vi.fn(async (): Promise<StoredMessage[]> => []),
  }
}

function renderApp() {
  // initialModel mirrors what App.tsx's Gate feeds ChatPage in production —
  // its OWN settings fetch, read once at app start. It is exactly the
  // snapshot Fix A's bug left stale after a switch; passing it here (rather
  // than leaving ChatPage to default to '') makes the pre-switch assertion
  // below meaningful: the badge already agrees with Settings BEFORE any
  // switch, same as the real app.
  return render(
    <ThemeProvider>
      <AuthProvider>
        <ChatProvider fetchImpl={noopFetch}>
          <SettingsPage />
          <ChatPage api={chatApi()} initialModel="qwen3:8b" />
        </ChatProvider>
      </AuthProvider>
    </ThemeProvider>,
  )
}

describe('Settings -> Models switch is visible in both the list and chat (Fix A)', () => {
  it('marks the new model current in Settings AND updates the chat badge, with no message sent', async () => {
    renderApp()

    // Pre-switch: qwen3:8b is current everywhere, no turn has run.
    await waitFor(() => expect(screen.getByTestId('current-chat-model').textContent).toBe('qwen3:8b'))
    await waitFor(() => expect(screen.getByTestId('chat-model').textContent).toBe('qwen3:8b'))

    const card14b = screen.getByTestId('model-card-qwen3:14b')
    fireEvent.click(within(card14b).getByText('Use this model'))

    // (a) Settings list: the switched model is marked current immediately.
    await waitFor(() => expect(within(card14b).getByText('Current')).toBeDefined())
    expect(screen.getByTestId('current-chat-model').textContent).toBe('qwen3:14b')

    // (b) The chat badge updates too — no message was ever sent.
    await waitFor(() => expect(screen.getByTestId('chat-model').textContent).toBe('qwen3:14b'))
  })
})
