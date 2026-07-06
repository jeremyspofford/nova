import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/auth-store'
import { UserPlus, Mail, Lock, User, Loader2, AlertCircle, Shield, Clock } from 'lucide-react'
import { ROLE_LABELS, type Role } from '../lib/roles'

interface InviteInfo {
  valid: boolean
  role?: string
  created_by_name?: string
  expires_at?: string | null
  account_expires_in_hours?: number | null
}

export function Invite() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { isAuthenticated, register, logout } = useAuth()

  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Set when the operator chooses to accept the invite from a signed-in
  // browser: sign out (both credential kinds) and fall through to the form.
  const [switching, setSwitching] = useState(false)

  const handleSignOutAndAccept = async () => {
    setSwitching(true)
    try { await logout() } catch { /* best-effort */ }
    // The break-glass secret also counts as "signed in" — clear it, or the
    // wall comes right back on reload. (This wall dead-ended the operator's
    // own invite: break-glass identity made isAuthenticated true.)
    localStorage.removeItem('nova_admin_secret')
    window.location.reload()
  }

  // Validate invite on mount
  useEffect(() => {
    if (!code) return
    let cancelled = false

    async function validate() {
      try {
        const resp = await fetch(`/api/v1/auth/invites/validate/${encodeURIComponent(code!)}`)
        if (resp.ok && !cancelled) {
          setInviteInfo(await resp.json())
        } else if (!cancelled) {
          setInviteInfo({ valid: false })
        }
      } catch {
        if (!cancelled) setInviteInfo({ valid: false })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    validate()
    return () => { cancelled = true }
  }, [code])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await register(email, password, displayName || undefined, code || undefined)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
      </div>
    )
  }

  // Signed in (JWT session or break-glass secret): offer the handoff instead
  // of a dead end — accepting an invite is a deliberate account switch.
  if (isAuthenticated && !switching) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 px-4">
        <div className="max-w-md w-full p-8 text-center space-y-4">
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            You're currently signed in
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            This invite creates a new account. To accept it, sign out of the current
            session first — or keep your session and go back to chat.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handleSignOutAndAccept}
              className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm px-4 py-2 transition-colors"
            >
              Sign out & accept invite
            </button>
            <button
              onClick={() => navigate('/')}
              className="rounded-lg bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-sm px-4 py-2 transition-colors"
            >
              Go to Chat
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Invalid or expired invite
  if (!inviteInfo?.valid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 px-4">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-red-100 dark:bg-red-950/50 flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-red-500" />
          </div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            Invalid or Expired Invite
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            This invite link is no longer valid. It may have expired or already been used.
            Please ask an admin for a new invite.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="rounded-lg bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-sm px-4 py-2 transition-colors"
          >
            Go to Login
          </button>
        </div>
      </div>
    )
  }

  // Valid invite — show registration form
  const roleName = ROLE_LABELS[(inviteInfo.role as Role) || 'member'] || inviteInfo.role

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-neutral-100">Nova</h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            You've been invited to join Nova
          </p>
        </div>

        {/* Invite details card */}
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-4 mb-6 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <User className="w-4 h-4 text-neutral-400" />
            <span className="text-neutral-600 dark:text-neutral-400">Invited by</span>
            <span className="font-medium text-neutral-900 dark:text-neutral-100">
              {inviteInfo.created_by_name}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Shield className="w-4 h-4 text-neutral-400" />
            <span className="text-neutral-600 dark:text-neutral-400">Role</span>
            <span className="font-medium text-neutral-900 dark:text-neutral-100 capitalize">
              {roleName}
            </span>
          </div>
          {inviteInfo.account_expires_in_hours && (
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-neutral-400" />
              <span className="text-neutral-600 dark:text-neutral-400">Access expires in</span>
              <span className="font-medium text-neutral-900 dark:text-neutral-100">
                {inviteInfo.account_expires_in_hours < 24
                  ? `${inviteInfo.account_expires_in_hours} hours`
                  : `${Math.round(inviteInfo.account_expires_in_hours / 24)} days`}
              </span>
            </div>
          )}
        </div>

        {/* Registration form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full pl-10 pr-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                placeholder="you@example.com"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">Display name</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                className="w-full pl-10 pr-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                placeholder="Your name"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full pl-10 pr-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                placeholder="At least 8 characters"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <UserPlus className="w-4 h-4" />
            )}
            Create account
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
          Already have an account?{' '}
          <button onClick={() => navigate('/login')} className="text-teal-600 dark:text-teal-400 hover:underline font-medium">
            Sign in
          </button>
        </p>
      </div>
    </div>
  )
}
