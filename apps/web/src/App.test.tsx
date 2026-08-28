import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import * as ui from './components/ui'

type Route = { status?: number; body?: unknown }

/** Answer the gate's three probes with whatever this test needs. */
function mockApi(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const match = Object.keys(routes).find(path => url.startsWith(path))
    const route = match ? routes[match] : { status: 404, body: { detail: 'not mocked' } }
    const status = route.status ?? 200
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(route.body ?? {}),
      json: async () => route.body ?? {},
    } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App gate', () => {
  it('sends a fresh instance to the wizard', async () => {
    mockApi({ '/api/v1/auth/state': { body: { has_users: false } } })
    render(<App />)
    await waitFor(() => expect(screen.getByText('Welcome to Nova')).toBeDefined())
  })

  it('sends an unauthenticated browser to the login page', async () => {
    mockApi({
      '/api/v1/auth/state': { body: { has_users: true } },
      '/api/v1/auth/me': { status: 401, body: { detail: 'no identity' } },
    })
    render(<App />)
    await waitFor(() => expect(screen.getByText('Sign in to this instance')).toBeDefined())
  })

  it('sends a signed-in browser with unfinished setup back to the wizard', async () => {
    mockApi({
      '/api/v1/auth/state': { body: { has_users: true } },
      '/api/v1/auth/me': { body: { person: { id: 'p1', name: 'Ada', role: 'owner' } } },
      '/api/v1/settings': {
        body: {
          settings: [
            { key: 'onboarding.completed', type: 'bool', default: false, description: '', value: false },
          ],
        },
      },
      '/api/v1/system/hardware': { body: { gpus: [], ram_mb: 32768, disk_free_gb: 900 } },
    })
    render(<App />)
    // The account exists, so the run resumes at Hardware rather than Welcome.
    await waitFor(() => expect(screen.getByText('What this machine has')).toBeDefined())
  })

  it('lets a signed-in, set-up browser into the app', async () => {
    mockApi({
      '/api/v1/auth/state': { body: { has_users: true } },
      '/api/v1/auth/me': { body: { person: { id: 'p1', name: 'Ada', role: 'owner' } } },
      '/api/v1/settings': {
        body: {
          settings: [
            { key: 'onboarding.completed', type: 'bool', default: false, description: '', value: true },
            { key: 'chat.model', type: 'str', default: '', description: '', value: 'qwen3:4b' },
          ],
        },
      },
      '/api/v1/conversations/active': { body: { id: 'c1', title: null, created_at: '' } },
      '/api/v1/conversations/c1/messages': { body: { messages: [] } },
    })
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText('Message Nova')).toBeDefined())
    expect(screen.getByText('qwen3:4b')).toBeDefined()
  })

  it('keeps the wizard running when the owner is registered mid-flow', async () => {
    mockApi({
      '/api/v1/auth/state': { body: { has_users: false } },
      '/api/v1/auth/register': { body: { person: { id: 'p1', name: 'Ada', role: 'owner' } } },
      '/api/v1/settings': {
        body: {
          settings: [
            { key: 'onboarding.completed', type: 'bool', default: false, description: '', value: false },
          ],
        },
      },
      '/api/v1/system/hardware': { body: { gpus: [], ram_mb: 32768, disk_free_gb: 900 } },
    })
    render(<App />)
    await waitFor(() => expect(screen.getByText('Welcome to Nova')).toBeDefined())

    fireEvent.click(screen.getByText('Get started'))
    await waitFor(() => expect(screen.getByText('Create your owner account')).toBeDefined())

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2hunter2' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'hunter2hunter2' },
    })
    fireEvent.click(screen.getByText('Create account and continue'))

    // Registering makes the settings probe re-run. The wizard must advance to
    // Hardware without being torn down: a remount would re-read has_users as
    // true and drop the Account step out of the progress indicator, which is
    // the only visible proof of whether this component survived.
    await waitFor(() => expect(screen.getByText('What this machine has')).toBeDefined())
    expect(screen.queryByText('Welcome to Nova')).toBeNull()
    expect(screen.getByText('Account')).toBeDefined()
  })

  it('states a core it cannot reach instead of guessing a route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    render(<App />)
    await waitFor(() => expect(screen.getByText('Nova is not answering')).toBeDefined())
  })
})

describe('components/ui index', () => {
  it('exports at least 30 distinct component bindings', () => {
    const keys = Object.keys(ui)
    expect(keys.length).toBeGreaterThanOrEqual(30)
  })
})
