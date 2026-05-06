// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryFetch } from './api-recovery'

// Node 25's experimental localStorage shim ships an incomplete prototype that
// can clobber happy-dom's. Install a Map-backed Storage so getItem/setItem/
// removeItem are stable regardless of which one wins module init order.
function installFakeLocalStorage() {
  const store = new Map<string, string>()
  const fake: Storage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
  vi.stubGlobal('localStorage', fake)
  return store
}

// Mirror the response shape Recovery returns when the JWT path fails.
const mk401 = () =>
  new Response(JSON.stringify({ detail: 'Admin authentication required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })

const mk200 = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const setTokens = (access: string, refresh: string) =>
  localStorage.setItem('nova_auth_tokens', JSON.stringify({ accessToken: access, refreshToken: refresh }))

const getStoredTokens = () => JSON.parse(localStorage.getItem('nova_auth_tokens') ?? 'null')

describe('recoveryFetch — JWT refresh-and-retry on 401', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    installFakeLocalStorage()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refreshes the token and retries the original request on 401', async () => {
    setTokens('expired-access-token', 'valid-refresh-token')

    fetchMock
      .mockResolvedValueOnce(mk401()) // original request fails
      .mockResolvedValueOnce(
        mk200({ access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token' }),
      ) // refresh succeeds
      .mockResolvedValueOnce(mk200({ ok: true })) // retry succeeds

    const result = await recoveryFetch<{ ok: boolean }>('/api/v1/recovery/env', { method: 'PATCH' })

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 1) original request used the (now-expired) access token
    const firstCallHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(firstCallHeaders.Authorization).toBe('Bearer expired-access-token')

    // 2) middle call hit the refresh endpoint
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/refresh')

    // 3) retry used the freshly minted access token
    const retryHeaders = fetchMock.mock.calls[2][1].headers as Record<string, string>
    expect(retryHeaders.Authorization).toBe('Bearer fresh-access-token')

    // tokens persisted to localStorage so subsequent requests pick them up
    expect(getStoredTokens()).toEqual({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
    })
  })

  it('surfaces the original 401 when refresh fails (option A: caller sees raw error)', async () => {
    setTokens('expired-access-token', 'expired-refresh-token')

    fetchMock
      .mockResolvedValueOnce(mk401()) // original fails
      .mockResolvedValueOnce(new Response('', { status: 401 })) // refresh fails

    await expect(recoveryFetch('/api/v1/recovery/env')).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(2) // no third call
  })

  it('does not attempt refresh when no JWT is stored (admin-secret bootstrap path)', async () => {
    localStorage.setItem('nova_admin_secret', 'test-secret')

    fetchMock.mockResolvedValueOnce(mk401())

    await expect(recoveryFetch('/api/v1/recovery/env')).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const firstCallHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(firstCallHeaders['X-Admin-Secret']).toBe('test-secret')
    expect(firstCallHeaders.Authorization).toBeUndefined()
  })
})
