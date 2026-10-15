import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronDown, Coins, LogOut, Settings as SettingsIcon, Activity as ActivityIcon } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../stores/auth-store'
import { hasMinRole, type Role } from '../../lib/roles'
import { displayName, initials } from './displayName'
import { SETTINGS_NAV } from '../../pages/settings/settingsNav'

/**
 * Who is signed in, and the handful of places that answer "and now what".
 *
 * The footer says what to CALL him — the full identity is an identifier and
 * belongs at the top of the menu, once, the way Claude's does. `people.name`
 * on this instance is an email, so it filled a 240px column with
 * "jeremyspofford@gmail…." and said nothing.
 *
 * EVERY ITEM GOES SOMEWHERE THAT EXISTS. Claude's menu carries changelog,
 * apps and extensions, language and a help centre; Nova has none of those,
 * and a link to a page nobody has written is the same defect as a button
 * for a capability nobody built. What is here is what is there: Settings,
 * Usage, what she has been doing, and the way out. Items join this list
 * when their destination does.
 */

type Item = {
  to: string
  label: string
  icon: typeof SettingsIcon
  /** Some destinations are admin-only; the menu must not offer a 404. */
  minRole: Role
  hint?: string
}

const ITEMS: Item[] = [
  { to: '/settings', label: 'Settings', icon: SettingsIcon, minRole: 'guest' },
  // "Usage" rather than "Spend": it is the question people ask, and the page
  // answers it for local turns too, where the cost is zero and the tokens
  // are not.
  // Named as their pages are titled (R11, 2026-10-11): "Usage" opened a
  // page called Spend and "What she has done" one called Activity.
  { to: '/spend', label: 'Spend', icon: Coins, minRole: 'admin' },
  { to: '/activity', label: 'Activity', icon: ActivityIcon, minRole: 'admin' },
  // About Nova moved into Settings (owner, 2026-10-15; settingsNav.ts).
]

/** Where the menu's pages live: its own items, and every page Settings
 *  lists in its nav (read from SETTINGS_NAV, so a page added there is
 *  covered by itself). */
function within(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}
const SETTINGS_ROOTS = ['/settings', ...SETTINGS_NAV.flatMap(g => g.items.map(i => i.to))]
const MENU_ROOTS = [...ITEMS.map(i => i.to), ...SETTINGS_ROOTS]

export function AccountMenu({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { pathname } = useLocation()
  // "You are here" for the pages that live under his name (R11): they have
  // no sidebar entry, so without this nothing showed where you were.
  const here = MENU_ROOTS.some(to => within(pathname, to))
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    // Next tick: the click that opened this is still propagating, and
    // closing on it would make the button inert.
    const id = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      clearTimeout(id)
    }
  }, [open])

  if (!user) return null
  const role: Role = (user.role as Role) ?? 'guest'

  const signOut = async () => {
    setError(null)
    setSigningOut(true)
    try {
      await logout()
    } catch (err) {
      // Said, never swallowed: a sign-out that failed left the session up.
      setError(err instanceof Error ? err.message : String(err))
      setSigningOut(false)
    }
  }

  return (
    <div className="relative px-2 pb-2" ref={ref}>
      {open && (
        <div
          role="menu"
          data-testid="account-menu"
          className="absolute bottom-full left-2 right-2 mb-1 z-50 rounded-lg border border-border-subtle bg-surface-elevated shadow-xl py-1"
        >
          {/* The full identity, once, where it is information rather than a
              label that has to fit. */}
          <p
            data-testid="account-menu-identity"
            className="px-3 py-2 text-caption text-content-tertiary truncate border-b border-border-subtle"
            title={user.name}
          >
            {user.name}
          </p>
          {ITEMS.filter(item => hasMinRole(role, item.minRole)).map(item => {
            const Icon = item.icon
            const current =
              item.to === '/settings' ? SETTINGS_ROOTS.some(to => within(pathname, to)) : within(pathname, item.to)
            return (
              <Link
                key={item.to}
                to={item.to}
                role="menuitem"
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  setOpen(false)
                  // The mobile drawer passes its own close: following a link
                  // out of a drawer that stays open leaves the destination
                  // behind a panel (2026-09-16).
                  onNavigate?.()
                }}
                className={clsx(
                  'flex items-center gap-2.5 px-3 py-2 text-compact transition-colors duration-fast',
                  current
                    ? 'bg-surface-selected text-content-primary'
                    : 'text-content-secondary hover:text-content-primary hover:bg-surface-card',
                )}
              >
                <Icon size={14} className="shrink-0" />
                {item.label}
              </Link>
            )
          })}
          <div className="mt-1 border-t border-border-subtle pt-1">
            <button
              type="button"
              role="menuitem"
              data-testid="account-menu-signout"
              onClick={signOut}
              disabled={signingOut}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-compact text-content-secondary hover:text-danger hover:bg-danger-dim transition-colors duration-fast disabled:opacity-60"
            >
              <LogOut size={14} className="shrink-0" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          {error && (
            <p role="alert" className="px-3 py-2 text-caption text-danger">
              {error}
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        data-testid="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={here ? 'page' : undefined}
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors duration-fast',
          open ? 'bg-surface-card' : here ? 'bg-surface-selected' : 'hover:bg-surface-card',
        )}
      >
        <span className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-white text-caption font-medium shrink-0">
          {initials(user.name)}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-compact font-medium text-content-primary truncate">
            {displayName(user.name)}
          </span>
          <span className="block text-micro text-content-tertiary capitalize">{user.role}</span>
        </span>
        <ChevronDown
          size={14}
          className={clsx('shrink-0 text-content-tertiary transition-transform', open && 'rotate-180')}
        />
      </button>
    </div>
  )
}
