import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  MessageSquare,
  Ellipsis,
  X,
  Activity,
  Settings,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../stores/auth-store'
import { hasMinRole, type Role } from '../../lib/roles'
import { useMobileNav } from '../../hooks/useMobileNav'
import { filterNavItemsByPreset, type SurfacePreset } from './sidebarFilter'

type NavItem = {
  to: string
  label: string
  icon: typeof MessageSquare
  minRole: Role
  presetVisibility?: SurfacePreset[]
}

// S1 nav config mirrors Sidebar.tsx: Chat as the sole primary tab, Settings
// tucked into "More". SURFACE_PRESET is hardcoded to 'advanced' until a
// real feature-flag source lands — see brief adaptation notes.
const primaryTabs: NavItem[] = [
  { to: '/chat', label: 'Chat', icon: MessageSquare, minRole: 'guest' },
]

const moreItems: { label?: string; items: NavItem[] }[] = [
  {
    label: 'System',
    items: [
      { to: '/activity', label: 'Activity', icon: Activity, minRole: 'admin' },
      { to: '/settings', label: 'Settings', icon: Settings, minRole: 'admin' },
    ],
  },
]

const SURFACE_PRESET: SurfacePreset = 'advanced'

export function MobileNav() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const { user } = useAuth()
  const userRole: Role = user?.role ?? 'guest'
  const { hidden } = useMobileNav()

  const isActive = (to: string) => {
    return location.pathname === to
  }

  // Check if any "more" item is active
  const moreActive = moreItems.some(section =>
    section.items.some(item => isActive(item.to)),
  )

  const visibleTabs = filterNavItemsByPreset(primaryTabs, SURFACE_PRESET)
    .filter(tab => hasMinRole(userRole, tab.minRole))

  return (
    <>
      {/* Bottom tab bar */}
      <nav className={clsx(
        'md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-border-subtle pb-[env(safe-area-inset-bottom)] glass-nav dark:border-white/[0.06] transition-transform duration-fast',
        hidden && 'translate-y-full',
      )}>
        <div className="flex items-center justify-around h-14">
          {visibleTabs.map(tab => {
            const Icon = tab.icon
            const active = isActive(tab.to)
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={clsx(
                  'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors duration-fast',
                  active ? 'text-accent' : 'text-content-tertiary',
                )}
              >
                <Icon className="w-5 h-5" />
                <span className="text-micro">{tab.label}</span>
              </NavLink>
            )
          })}
          <button
            onClick={() => setDrawerOpen(true)}
            className={clsx(
              'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors duration-fast',
              moreActive ? 'text-accent' : 'text-content-tertiary',
            )}
          >
            <Ellipsis className="w-5 h-5" />
            <span className="text-micro">More</span>
          </button>
        </div>
      </nav>

      {/* Full-screen drawer */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-surface-root dark:bg-transparent glass-overlay animate-fade-in">
          <div className="flex items-center justify-between px-4 h-14 border-b border-border-subtle">
            <span className="text-h3 text-content-primary">Menu</span>
            <button
              onClick={() => setDrawerOpen(false)}
              className="p-2 text-content-tertiary hover:text-content-primary transition-colors duration-fast rounded-md"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="overflow-y-auto p-4 space-y-6" style={{ maxHeight: 'calc(100vh - 56px)' }}>
            {moreItems.map((section, sIdx) => {
              const visibleItems = filterNavItemsByPreset(section.items, SURFACE_PRESET)
                .filter(item => hasMinRole(userRole, item.minRole))
              if (visibleItems.length === 0) return null
              return (
                <div key={sIdx}>
                  {section.label && (
                    <div className="text-micro font-semibold uppercase tracking-wider text-content-tertiary px-2 mb-2">
                      {section.label}
                    </div>
                  )}
                  <div className="space-y-0.5">
                    {visibleItems.map(item => {
                      const Icon = item.icon
                      const active = isActive(item.to)
                      return (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          onClick={() => setDrawerOpen(false)}
                          className={clsx(
                            'flex items-center gap-3 px-3 py-3 rounded-md text-body font-medium transition-colors duration-fast',
                            active
                              ? 'bg-accent-dim text-accent'
                              : 'text-content-secondary hover:text-content-primary hover:bg-surface-card',
                          )}
                        >
                          <Icon className="w-5 h-5 shrink-0" />
                          <span>{item.label}</span>
                        </NavLink>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
