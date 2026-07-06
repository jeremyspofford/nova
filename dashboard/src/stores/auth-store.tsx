import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'

export interface User {
  id: string
  email: string
  display_name: string | null
  avatar_url: string | null
  is_admin: boolean
  role: 'owner' | 'admin' | 'member' | 'viewer' | 'guest'
  provider: string
  tenant_id: string
  expires_at: string | null
  status: string
}

interface AuthConfig {
  google: boolean
  registration_mode: 'open' | 'invite' | 'admin'
  has_users: boolean
  trusted_network: boolean
}

interface AuthStore {
  user: User | null
  accessToken: string | null
  isAuthenticated: boolean
  authConfig: AuthConfig | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName?: string, inviteCode?: string) => Promise<void>
  loginWithGoogle: (code: string, state: string) => Promise<void>
  logout: () => void
  refreshAuth: () => Promise<boolean>
  getAccessToken: () => string | null
}

const AUTH_TOKENS_KEY = 'nova_auth_tokens'

function loadTokens(): { accessToken: string; refreshToken: string } | null {
  try {
    const raw = localStorage.getItem(AUTH_TOKENS_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify({ accessToken, refreshToken }))
}

function clearTokens() {
  localStorage.removeItem(AUTH_TOKENS_KEY)
}

const AuthContext = createContext<AuthStore | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(() => loadTokens()?.accessToken ?? null)
  const refreshTokenRef = useRef<string | null>(loadTokens()?.refreshToken ?? null)
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const scheduleRefresh = useCallback((token: string) => {
    clearTimeout(refreshTimerRef.current)
    // Refresh 1 minute before expiry (14 min for a 15 min token)
    refreshTimerRef.current = setTimeout(async () => {
      const rt = refreshTokenRef.current
      if (!rt) return
      try {
        const resp = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        })
        if (resp.ok) {
          const data = await resp.json()
          setAccessToken(data.access_token)
          refreshTokenRef.current = data.refresh_token
          saveTokens(data.access_token, data.refresh_token)
          scheduleRefresh(data.access_token)
        }
      } catch {
        // Silent failure — user will be asked to re-login on next 401
      }
    }, 14 * 60 * 1000)
  }, [])

  const handleAuthResponse = useCallback((data: { access_token: string; refresh_token: string; user: User }) => {
    setUser(data.user)
    setAccessToken(data.access_token)
    refreshTokenRef.current = data.refresh_token
    saveTokens(data.access_token, data.refresh_token)
    scheduleRefresh(data.access_token)
  }, [scheduleRefresh])

  const login = useCallback(async (email: string, password: string) => {
    const resp = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: 'Login failed' }))
      throw new Error(err.detail || 'Login failed')
    }
    handleAuthResponse(await resp.json())
  }, [handleAuthResponse])

  const register = useCallback(async (email: string, password: string, displayName?: string, inviteCode?: string) => {
    const resp = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password,
        display_name: displayName || undefined,
        invite_code: inviteCode || undefined,
      }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: 'Registration failed' }))
      throw new Error(err.detail || 'Registration failed')
    }
    handleAuthResponse(await resp.json())
  }, [handleAuthResponse])

  const loginWithGoogle = useCallback(async (code: string, state: string) => {
    // FC-003: server validates `state` against its Redis-stored value (single-use).
    // We pass the state through; the orchestrator looks up the original
    // redirect_uri from Redis rather than trusting any client-supplied value.
    const resp = await fetch('/api/v1/auth/google/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: 'Google login failed' }))
      throw new Error(err.detail || 'Google login failed')
    }
    handleAuthResponse(await resp.json())
  }, [handleAuthResponse])

  const logout = useCallback(() => {
    const rt = refreshTokenRef.current
    if (rt) {
      fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      }).catch(() => {})
    }
    setUser(null)
    setAccessToken(null)
    refreshTokenRef.current = null
    clearTokens()
    clearTimeout(refreshTimerRef.current)
  }, [])

  const refreshAuth = useCallback(async (): Promise<boolean> => {
    const rt = refreshTokenRef.current
    if (!rt) return false
    try {
      const resp = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      })
      if (!resp.ok) {
        logout()
        return false
      }
      const data = await resp.json()
      handleAuthResponse(data)
      return true
    } catch {
      logout()
      return false
    }
  }, [handleAuthResponse, logout])

  const getAccessToken = useCallback(() => accessToken, [accessToken])

  // Load auth config and validate existing session on mount
  useEffect(() => {
    let cancelled = false

    async function init() {
      // Fetch auth config — always set a value so AuthGate can rely on it
      try {
        const resp = await fetch('/api/v1/auth/providers')
        if (resp.ok && !cancelled) {
          setAuthConfig(await resp.json())
        } else if (!cancelled) {
          // Non-ok response — assume auth required (fail-closed)
          setAuthConfig({ google: false, registration_mode: 'open', has_users: true, trusted_network: false })
        }
      } catch {
        // Backend unreachable — set fallback so AuthGate shows login instead of blank page
        if (!cancelled) {
          setAuthConfig({ google: false, registration_mode: 'open', has_users: true, trusted_network: false })
        }
      }

      // If we have tokens, validate them
      const tokens = loadTokens()
      if (tokens?.accessToken) {
        try {
          const resp = await fetch('/api/v1/auth/me', {
            headers: { 'Authorization': `Bearer ${tokens.accessToken}` },
          })
          if (resp.ok && !cancelled) {
            const userData = await resp.json()
            setUser(userData)
            setAccessToken(tokens.accessToken)
            refreshTokenRef.current = tokens.refreshToken
            scheduleRefresh(tokens.accessToken)
          } else if (tokens.refreshToken) {
            // Access token expired — try refresh
            const refreshed = await refreshAuth()
            if (!refreshed && !cancelled) {
              clearTokens()
              setAccessToken(null)
            }
          }
        } catch {
          // Backend not available
        }
      } else {
        // No JWT — trusted-network and break-glass-secret browsers still
        // have a server-side identity (synthetic owner). Ask who we are so
        // role-derived UI (invite roles, user management) doesn't silently
        // degrade to 'viewer'. 401 here simply means anonymous.
        try {
          const secret = localStorage.getItem('nova_admin_secret')
          const resp = await fetch('/api/v1/auth/me', {
            headers: secret ? { 'X-Admin-Secret': secret } : {},
          })
          if (resp.ok && !cancelled) {
            setUser(await resp.json())
          }
        } catch {
          // Backend not available — stay anonymous
        }
      }

      if (!cancelled) setLoading(false)
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthContext.Provider value={{
      user, accessToken, isAuthenticated: !!user,
      authConfig, loading,
      login, register, loginWithGoogle, logout,
      refreshAuth, getAccessToken,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthStore {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
