import { Link, Outlet, useLocation } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../stores/auth-store'
import { hasMinRole, type Role } from '../../lib/roles'
import { useIsWide } from '../../hooks/useIsMobile'
import { InShellContext } from '../../components/layout/PageHeader'
import { SETTINGS_INDEX, SETTINGS_NAV, settingsLocation, type SettingsNavGroup } from './settingsNav'

/**
 * Settings as one place with its own nav (2026-10-08), the way Claude's is:
 * "Settings" at the top, everything it holds listed down the left, the one
 * you picked on the right. It holds the old tabs AND the pages that left the
 * sidebar — Agents, Skills, the model catalog, AI Quality, Governance — so a
 * person looking for any of them looks in one place.
 *
 * A layout route (App.tsx): each page inside renders into the Outlet, keeps
 * its own address, and has its title drawn as an h2 under this one h1
 * (InShellContext).
 *
 * BELOW 1280px IT STACKS (useIsWide). The sidebar and this nav together
 * take ~470px: on a tablet that left a page about 300px, and at 1024 it left
 * the catalog 512px where it had 736. So a narrower screen drills down
 * instead, the way a phone's own settings do: bare /settings is the list, an
 * entry is a page with a way back. On a wide screen bare /settings is
 * General, as it always was.
 */
export function SettingsShell() {
  const { pathname } = useLocation()
  const wide = useIsWide()
  const { user } = useAuth()
  const role: Role = user?.role ?? 'guest'
  const here = settingsLocation(pathname)
  const groups = visibleGroups(role)

  const showList = wide || here.index
  const showPage = wide || !here.index

  return (
    <InShellContext.Provider value={true}>
      <div data-testid="settings-shell">
        {showList ? (
          <h1 className="text-h1 text-content-primary mb-6">Settings</h1>
        ) : (
          here.top && (
            // The way back on a narrow screen. Only on an entry's own page:
            // one beneath it (an agent's page) already links back to its
            // list, and two back links stacked is one too many.
            <Link
              to={SETTINGS_INDEX}
              data-testid="settings-back"
              className="mb-4 -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-1 text-compact font-medium text-content-secondary hover:text-content-primary transition-colors duration-fast"
            >
              <ChevronLeft size={16} className="shrink-0" />
              Settings
            </Link>
          )
        )}
        <div className={clsx(wide && 'flex items-start gap-8')}>
          {showList &&
            (wide ? (
              <SideNav groups={groups} current={here.entry?.to ?? null} />
            ) : (
              <ListNav groups={groups} />
            ))}
          {showPage && (
            <div className="min-w-0 flex-1" data-testid="settings-page">
              <Outlet />
            </div>
          )}
        </div>
      </div>
    </InShellContext.Provider>
  )
}

/** A nav link's test id. A tab keeps the id its strip link had before the
 *  shell existed (`settings-tab-<slug>`), so the tab suites drive the same
 *  control by the same name; a page is `settings-nav-<path>`. */
function navTestId(to: string): string {
  const tabPrefix = `${SETTINGS_INDEX}/`
  return to.startsWith(tabPrefix)
    ? `settings-tab-${to.slice(tabPrefix.length)}`
    : `settings-nav-${to.replace(/^\//, '').replace(/\//g, '-')}`
}

function visibleGroups(role: Role): SettingsNavGroup[] {
  return SETTINGS_NAV.map(g => ({ ...g, items: g.items.filter(i => hasMinRole(role, i.minRole)) })).filter(
    g => g.items.length > 0,
  )
}

/** The wide screen's column: compact rows, the current one marked, and it
 *  stays put while a long page (the catalog, AI Quality's runs) scrolls. */
function SideNav({ groups, current }: { groups: SettingsNavGroup[]; current: string | null }) {
  return (
    <nav
      aria-label="Settings"
      data-testid="settings-nav"
      className="sticky top-8 w-48 shrink-0 space-y-5"
    >
      {groups.map(group => (
        <div key={group.label}>
          <div className="mb-1 px-2.5 text-micro font-semibold uppercase tracking-wider text-content-tertiary">
            {group.label}
          </div>
          <div className="space-y-0.5">
            {group.items.map(item => {
              const Icon = item.icon
              const active = item.to === current
              return (
                // LINKS with real addresses, so an entry can be bookmarked
                // and the back button steps between them. A plain Link, NOT
                // NavLink: NavLink decides `aria-current` from its own path
                // match and overrides the prop, so at bare /settings — which
                // IS General — it would mark nothing, and on an agent's page
                // it would not mark Agents. `current` comes from
                // settingsLocation, which knows both.
                <Link
                  key={item.to}
                  to={item.to}
                  data-testid={navTestId(item.to)}
                  aria-current={active ? 'page' : undefined}
                  className={clsx(
                    'relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-compact font-medium transition-colors duration-fast',
                    active
                      ? 'bg-accent-dim text-accent'
                      : 'text-content-secondary hover:text-content-primary hover:bg-surface-card',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}

/** The narrow screen's index: whole-width rows a thumb can hit, each one a
 *  page to open. Nothing is marked current — on this screen nothing is open
 *  yet. */
function ListNav({ groups }: { groups: SettingsNavGroup[] }) {
  return (
    <nav aria-label="Settings" data-testid="settings-nav" className="space-y-6">
      {groups.map(group => (
        <div key={group.label}>
          <div className="mb-2 px-1 text-caption font-semibold uppercase tracking-wider text-content-tertiary">
            {group.label}
          </div>
          <div className="overflow-hidden rounded-lg border border-border-subtle dark:border-white/[0.08] bg-surface-card divide-y divide-border-subtle dark:divide-white/[0.06]">
            {group.items.map(item => {
              const Icon = item.icon
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  data-testid={navTestId(item.to)}
                  className="flex min-h-[48px] items-center gap-3 px-4 py-3 text-body font-medium text-content-primary hover:bg-surface-elevated transition-colors duration-fast"
                >
                  <Icon className="h-5 w-5 shrink-0 text-content-secondary" />
                  <span className="flex-1 truncate">{item.label}</span>
                  <ChevronRight size={16} className="shrink-0 text-content-tertiary" />
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}
