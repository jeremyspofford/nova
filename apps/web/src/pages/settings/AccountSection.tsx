import { useState } from 'react'
import { CircleUser, LogOut } from 'lucide-react'
import { Badge, Button, DataList, Section } from '../../components/ui'
import { useAuth } from '../../stores/auth-store'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../lib/roles'

/**
 * Name and role are read-only in S1: core has no route that changes either,
 * and a field that silently does nothing is worse than no field.
 */
export function AccountSection() {
  const { user, logout } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  if (!user) return null

  const handleLogout = async () => {
    setError(null)
    setSigningOut(true)
    try {
      await logout()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSigningOut(false)
    }
  }

  return (
    <Section icon={CircleUser} title="Account" description="Who this browser is signed in as.">
      <DataList
        items={[
          { label: 'Name', value: user.name },
          {
            label: 'Role',
            value: (
              <span className="inline-flex items-center gap-2">
                <Badge color="accent" size="sm">
                  {ROLE_LABELS[user.role]}
                </Badge>
                <span className="text-caption text-content-tertiary">
                  {ROLE_DESCRIPTIONS[user.role]}
                </span>
              </span>
            ),
          },
        ]}
      />

      {error && (
        <div
          role="alert"
          className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger"
        >
          {error}
        </div>
      )}

      <div>
        <Button
          variant="outline"
          size="sm"
          icon={<LogOut size={12} />}
          loading={signingOut}
          onClick={handleLogout}
        >
          Sign out
        </Button>
      </div>
    </Section>
  )
}
