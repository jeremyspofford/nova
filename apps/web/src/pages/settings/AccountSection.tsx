import { useState } from 'react'
import { CircleUser, LogOut } from 'lucide-react'
import { Badge, Button, DataList, Input, Section } from '../../components/ui'
import { useAuth } from '../../stores/auth-store'
import { renameMe as apiRenameMe } from '../../lib/api'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../lib/roles'

/**
 * Who this browser is signed in as.
 *
 * The NAME became editable on 2026-09-16, and the reason is worth stating:
 * `people.name` is whatever was typed at registration, and on this instance
 * that is an email address. The sidebar can derive "Jeremy" from
 * `jeremy.spofford@…` and can derive nothing at all from
 * `jeremyspofford@…` — so the only honest way to show somebody their own
 * first name is to let them say what it is.
 *
 * The name is also the LOGIN identifier. Changing it changes what you sign
 * in with, which the field says out loud rather than leaving to be
 * discovered at the next login.
 *
 * ROLE stays read-only. A person promoting themselves is a different
 * question entirely, and core has no route that asks it.
 */
export function AccountSection({ renameMe = apiRenameMe }: { renameMe?: typeof apiRenameMe } = {}) {
  const { user, logout, refresh } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  if (!user) return null

  const save = async () => {
    const name = (draft ?? '').trim()
    if (!name || name === user.name) {
      setDraft(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await renameMe(name)
      // Re-read from core rather than trusting the response: the store's
      // copy is what every surface renders, and a local patch that the
      // server rejected would show a name nobody has.
      await refresh()
      setDraft(null)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

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
          {
            label: 'Name',
            value:
              draft === null ? (
                <span className="flex items-center gap-2">
                  <span data-testid="account-name">{user.name}</span>
                  <button
                    type="button"
                    data-testid="account-rename"
                    onClick={() => {
                      setSaved(false)
                      setDraft(user.name)
                    }}
                    className="text-caption text-content-tertiary hover:text-accent transition-colors duration-fast"
                  >
                    Change
                  </button>
                  {saved && (
                    <span className="text-caption text-content-tertiary">saved</span>
                  )}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Input
                    data-testid="account-name-input"
                    value={draft}
                    autoFocus
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void save()
                      if (e.key === 'Escape') setDraft(null)
                    }}
                    className="max-w-[16rem]"
                  />
                  <Button size="sm" loading={saving} onClick={() => void save()}>
                    Save
                  </Button>
                  <button
                    type="button"
                    onClick={() => setDraft(null)}
                    className="text-caption text-content-tertiary hover:text-content-primary"
                  >
                    Cancel
                  </button>
                  {/* Said here rather than discovered at the next sign-in. */}
                  <span className="text-caption text-content-tertiary">
                    also what you sign in with
                  </span>
                </span>
              ),
          },
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
