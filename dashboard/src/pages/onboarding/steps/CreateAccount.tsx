import { useState } from 'react'
import { UserPlus, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../../stores/auth-store'
import { Button, Input } from '../../../components/ui'

interface Props {
  onNext: () => void
}

/**
 * First-boot owner account. This account IS the admin credential — the
 * .env admin secret stays as break-glass only. Registration is exempt
 * from invite mode for the first user (there is nobody to invite them),
 * and the JWT this step stores is what authorizes the rest of the
 * wizard's admin writes.
 *
 * If users already exist (wizard re-run), the parent skips this step.
 */
export function CreateAccount({ onNext }: Props) {
  const { register } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await register(email, password, displayName || undefined)
      onNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="w-16 h-16 rounded-xl bg-accent/10 flex items-center justify-center mb-6">
        <ShieldCheck className="w-8 h-8 text-accent" />
      </div>
      <h1 className="text-h2 text-content-primary mb-2">
        Create your owner account
      </h1>
      <p className="text-compact text-content-secondary max-w-md mb-6">
        This is the administrator of this Nova instance — you'll use it to sign in,
        change settings, and invite others. No config files involved.
      </p>
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 text-left">
        <Input
          label="Your name"
          type="text"
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder="Ada Lovelace"
          autoComplete="name"
        />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          placeholder="you@example.com"
          autoComplete="email"
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
        {error && (
          <div className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger">
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
          Create account & continue
        </Button>
      </form>
    </div>
  )
}
