import { useState } from 'react'
import { ShieldCheck, UserPlus } from 'lucide-react'
import { Button, Input } from '../../../components/ui'
import { useAuth } from '../../../stores/auth-store'

/**
 * The first and only owner. Core refuses a second registration outright, so
 * this step exists exactly once per instance — the wizard hides it on any
 * later run.
 */
export function CreateAccount({ onNext }: { onNext: () => void }) {
  const { register } = useAuth()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      await register(name, password)
      onNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.')
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="w-16 h-16 rounded-xl bg-accent/10 flex items-center justify-center mb-6">
        <ShieldCheck className="w-8 h-8 text-accent" />
      </div>
      <h1 className="text-h2 text-content-primary mb-2">Create your owner account</h1>
      <p className="text-compact text-content-secondary max-w-md mb-6">
        This account owns the instance. There is no config file to edit and no
        password to recover from — write it down somewhere.
      </p>
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 text-left">
        <Input
          label="Your name"
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          required
          placeholder="Ada Lovelace"
          autoComplete="username"
          autoFocus
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          minLength={8}
          placeholder="At least 8 characters"
          autoComplete="new-password"
        />
        <Input
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
        />
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
          size="lg"
          loading={submitting}
          icon={!submitting ? <UserPlus size={16} /> : undefined}
          className="w-full"
        >
          Create account and continue
        </Button>
      </form>
    </div>
  )
}
