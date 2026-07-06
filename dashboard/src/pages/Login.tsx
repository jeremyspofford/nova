import { useState } from 'react'
import { useNovaIdentity } from '../hooks/useNovaIdentity'
import { useAuth } from '../stores/auth-store'
import { LogIn, UserPlus, Eye, EyeOff, ChevronDown, ChevronUp, KeyRound, User } from 'lucide-react'
import { setAdminSecret } from '../api'
import { Button, Input } from '../components/ui'

export function Login() {
  const { avatarUrl } = useNovaIdentity()
  const { login, register, loginWithGoogle, authConfig } = useAuth()
  const searchParams = new URLSearchParams(window.location.search)
  const urlInviteCode = searchParams.get('invite')
  const [mode, setMode] = useState<'login' | 'register'>(
    urlInviteCode ? 'register' : authConfig && !authConfig.has_users ? 'register' : 'login'
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [inviteCode, setInviteCode] = useState(urlInviteCode ?? '')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showInviteField, setShowInviteField] = useState(false)
  const [showAdminSecret, setShowAdminSecret] = useState(false)
  const [adminSecretInput, setAdminSecretInput] = useState('')
  const [adminError, setAdminError] = useState<string | null>(null)
  const [adminSubmitting, setAdminSubmitting] = useState(false)

  // Operator path: the admin secret from .env. This MUST live on the login
  // page — the Settings paste field is behind the very credential it stores
  // (bootstrap paradox; SEC2 made it bite). Verified against an admin
  // endpoint before storing so a typo doesn't silently break every page.
  const handleAdminSecret = async () => {
    const v = adminSecretInput.trim()
    if (!v) return
    setAdminError(null)
    setAdminSubmitting(true)
    try {
      const resp = await fetch('/api/v1/tools', { headers: { 'X-Admin-Secret': v } })
      if (resp.status === 429) {
        setAdminError('Too many failed attempts from this address — wait a few minutes and try again.')
      } else if (!resp.ok) {
        setAdminError('Invalid admin secret. It is the ADMIN_SECRET value in your .env file.')
      } else {
        setAdminSecret(v)
        window.location.href = '/chat'
      }
    } catch {
      setAdminError('Could not reach the orchestrator to verify the secret.')
    } finally {
      setAdminSubmitting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (mode === 'login') {
        await login(email, password)
      } else {
        await register(email, password, displayName || undefined, inviteCode || undefined)
      }
      // Success must GO somewhere — without this the page just sat there
      // with valid tokens stored ("the sign in flow doesn't work"). Full
      // navigation so the auth bootstrap re-runs under the new session.
      window.location.href = '/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setSubmitting(false)
    }
  }

  const handleGoogleLogin = async () => {
    try {
      const resp = await fetch('/api/v1/auth/google')
      if (!resp.ok) throw new Error('Failed to get Google auth URL')
      const { url, state } = await resp.json()
      // Stash the state we just minted so the callback handler can verify
      // that the popup-returned state matches (CSRF protection at the
      // browser layer too — defense in depth on top of server-side validation).
      sessionStorage.setItem('oauth_google_state', state)
      // Open Google consent in a popup
      const popup = window.open(url, 'google-auth', 'width=500,height=600')
      // Listen for the callback
      const handler = async (event: MessageEvent) => {
        if (event.data?.type === 'google-auth-callback' && event.data.code) {
          window.removeEventListener('message', handler)
          popup?.close()
          const expectedState = sessionStorage.getItem('oauth_google_state')
          sessionStorage.removeItem('oauth_google_state')
          const returnedState = event.data.state ?? null
          if (!returnedState || returnedState !== expectedState) {
            setError('OAuth state mismatch — possible CSRF attempt. Try again.')
            return
          }
          try {
            await loginWithGoogle(event.data.code, returnedState)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Google login failed')
          }
        }
      }
      window.addEventListener('message', handler)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Google login')
    }
  }

  const showRegister = authConfig?.registration_mode !== 'admin'
  const needsInvite = authConfig?.registration_mode === 'invite'
  const isFirstUser = authConfig && !authConfig.has_users

  const subtitle = isFirstUser
    ? 'Create your admin account to get started'
    : urlInviteCode && mode === 'register'
    ? "You've been invited! Create an account to get started."
    : mode === 'login'
    ? 'Sign in to your account'
    : 'Create a new account'

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-root dark:bg-transparent px-4">
      <div className="w-full max-w-sm">

        {/* Logo mark + wordmark */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <img src={avatarUrl} alt="Nova" className="w-10 h-10 rounded-lg object-cover shadow-md" />
          <div className="text-center">
            <h1 className="text-xl font-semibold text-content-primary font-sans">Nova</h1>
            <p className="mt-1 text-caption text-content-tertiary font-sans">{subtitle}</p>
          </div>
        </div>

        {/* Form card */}
        <div className="bg-surface-card border border-border rounded-lg p-6 shadow-sm space-y-4 glass-card dark:border-white/[0.08]">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              autoComplete="email"
            />

            {/* Display name (register only) */}
            {mode === 'register' && (
              <Input
                label="Display name"
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Your name"
                prefix={<User size={14} />}
                autoComplete="name"
              />
            )}

            {/* Password with show/hide toggle */}
            <div className="w-full">
              <label className="mb-1.5 block text-caption font-medium text-content-secondary font-sans">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 pr-9 text-compact text-content-primary placeholder:text-content-tertiary outline-none transition-colors duration-fast focus:border-border-focus focus:ring-2 focus:ring-accent-500/40"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-content-tertiary hover:text-content-secondary transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Invite code (register + invite mode) */}
            {mode === 'register' && needsInvite && (
              <Input
                label="Invite code"
                type="text"
                value={inviteCode}
                onChange={e => setInviteCode(e.target.value)}
                required
                placeholder="Enter your invite code"
              />
            )}

            {/* Error message */}
            {error && (
              <div className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger font-sans">
                {error}
              </div>
            )}

            {/* Submit */}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submitting}
              icon={!submitting ? (mode === 'login' ? <LogIn size={16} /> : <UserPlus size={16} />) : undefined}
              className="w-full"
            >
              {mode === 'login' ? 'Sign In' : isFirstUser ? 'Create admin account' : 'Create account'}
            </Button>
          </form>

          {/* Google OAuth */}
          {authConfig?.google && (
            <>
              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="px-3 bg-surface-card text-caption text-content-tertiary font-sans">or</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={handleGoogleLogin}
                icon={
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                }
                className="w-full"
              >
                Continue with Google
              </Button>
            </>
          )}
        </div>

        {/* Invite code link (login mode, when registration is invite-only) */}
        {mode === 'login' && needsInvite && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowInviteField(v => !v)}
              className="flex items-center gap-1 text-caption text-content-tertiary hover:text-content-secondary transition-colors font-sans mx-auto"
            >
              Have an invite code?
              {showInviteField ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {showInviteField && (
              <div className="mt-3 bg-surface-card border border-border rounded-lg p-4 space-y-3 shadow-sm glass-card dark:border-white/[0.08]">
                <Input
                  label="Invite code"
                  type="text"
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value)}
                  placeholder="Enter your invite code"
                />
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  className="w-full"
                  onClick={() => { setMode('register'); setShowInviteField(false); setError(null) }}
                >
                  Continue with invite
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Operator path: admin secret from .env */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowAdminSecret(v => !v)}
            className="flex items-center gap-1 text-caption text-content-tertiary hover:text-content-secondary transition-colors font-sans mx-auto"
          >
            <KeyRound size={13} />
            Break-glass: instance admin secret
            {showAdminSecret ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {showAdminSecret && (
            <div className="mt-3 bg-surface-card border border-border rounded-lg p-4 space-y-3 shadow-sm glass-card dark:border-white/[0.08]">
              <p className="text-caption text-content-tertiary">
                For recovery and automation — day-to-day admin is your owner account.
                The secret is the <span className="font-mono">ADMIN_SECRET</span> value in this
                instance's <span className="font-mono">.env</span>.
              </p>
              <Input
                label="Admin secret"
                type="password"
                value={adminSecretInput}
                onChange={e => setAdminSecretInput(e.target.value)}
                placeholder="ADMIN_SECRET from your .env"
                autoComplete="off"
              />
              {adminError && (
                <div className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger font-sans">
                  {adminError}
                </div>
              )}
              <Button
                type="button"
                variant="primary"
                size="md"
                className="w-full"
                loading={adminSubmitting}
                onClick={handleAdminSecret}
              >
                Unlock admin
              </Button>
            </div>
          )}
        </div>

        {/* Toggle login / register */}
        {showRegister && !isFirstUser && (
          <p className="mt-5 text-center text-caption text-content-tertiary font-sans">
            {mode === 'login' ? (
              <>
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('register'); setError(null) }}
                  className="text-accent hover:underline font-medium"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(null) }}
                  className="text-accent hover:underline font-medium"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
