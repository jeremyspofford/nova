import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, getAuthState, getMe, postLogin, postLogout, postRegister } from '../lib/api'
import type { Person } from '../lib/gate'

/**
 * Who is signed in, and whether this instance has an owner at all.
 *
 * Both facts come from core on every refresh — nothing about the session is
 * cached in localStorage, because a cookie the browser holds and a session
 * core still honours are different things, and only core knows the second.
 */
interface AuthStore {
  user: Person | null
  hasUsers: boolean
  /** The first probe has finished (successfully or not). */
  ready: boolean
  /** Set when core could not be reached at all — a stated reason, not a redirect. */
  unreachable: string | null
  refresh: () => Promise<void>
  login: (name: string, password: string) => Promise<void>
  register: (name: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthStore | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Person | null>(null)
  const [hasUsers, setHasUsers] = useState(false)
  const [ready, setReady] = useState(false)
  const [unreachable, setUnreachable] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    let hasAnyUsers: boolean
    try {
      const state = await getAuthState()
      hasAnyUsers = state.has_users
      setHasUsers(hasAnyUsers)
      setUnreachable(null)
    } catch (err) {
      // The gate cannot be evaluated without this answer. Say so rather than
      // guessing an outcome.
      setUnreachable(err instanceof Error ? err.message : String(err))
      setReady(true)
      return
    }
    if (!hasAnyUsers) {
      // Nobody exists, so nobody can be signed in — asking core who this is
      // would only produce a refusal to explain away.
      setUser(null)
      setReady(true)
      return
    }
    try {
      setUser(await getMe())
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
      } else {
        setUnreachable(err instanceof Error ? err.message : String(err))
      }
    }
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (name: string, password: string) => {
    const person = await postLogin(name, password)
    setUser(person)
    setHasUsers(true)
  }, [])

  const register = useCallback(async (name: string, password: string) => {
    const person = await postRegister(name, password)
    setUser(person)
    setHasUsers(true)
  }, [])

  const logout = useCallback(async () => {
    await postLogout()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider
      value={{ user, hasUsers, ready, unreachable, refresh, login, register, logout }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthStore {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
