import { useState } from 'react'
import { Eye, EyeOff, LogIn } from 'lucide-react'
import { Button, Input } from '../components/ui'
import { useAuth } from '../stores/auth-store'
import { ApiError } from '../lib/api'

/**
 * Sign in. There is deliberately no "create account" path here — the first
 * and only account is minted by the wizard, and the gate sends a fresh
 * instance to /onboarding before this page can ever render.
 */
export function Login() {
  const { login } = useAuth()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // On success the auth store gains a person and the gate re-evaluates
      // to the app — this page unmounts on its own.
      await login(name, password)
    } catch (err) {
      // Core states 401 and 429 differently and both matter to the person
      // typing: one is a wrong password, the other is a lockout with a clock.
      setError(err instanceof ApiError ? err.message : 'Could not sign in — Nova did not answer.')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-surface-root dark:bg-transparent px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="h-10 w-10 rounded-lg bg-accent flex items-center justify-center text-white text-h3 font-semibold shadow-md dark:shadow-[0_0_20px_rgb(var(--accent-500)/0.3)]">
            N
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-content-primary">Nova</h1>
            <p className="mt-1 text-caption text-content-tertiary">Sign in to this instance</p>
          </div>
        </div>

        <div className="bg-surface-card border border-border rounded-lg p-6 shadow-sm glass-card dark:border-white/[0.08]">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              placeholder="Your name"
              autoComplete="username"
              autoFocus
            />

            <div className="w-full">
              <label
                htmlFor="login-password"
                className="mb-1.5 block text-caption font-medium text-content-secondary"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  placeholder="Your password"
                  autoComplete="current-password"
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

            {error && (
              <div
                role="alert"
                className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submitting}
              icon={!submitting ? <LogIn size={16} /> : undefined}
              className="w-full"
            >
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
