import { useLocation, NavLink, useNavigate } from 'react-router-dom'
import { Activity, Bot, Boxes, CalendarClock, ChevronsLeft, ChevronsRight, Coins, FolderOpen, Gauge, MessageSquare, ScrollText, Settings } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../stores/auth-store'
import { hasMinRole, type Role } from '../../lib/roles'
import { filterNavItemsByPreset, type SurfacePreset } from './sidebarFilter'

export type NavItem = {
  to: string
  label: string
  icon: typeof MessageSquare
  minRole: Role
  presetVisibility?: SurfacePreset[]
}

export type NavSection = {
  label?: string
  items: NavItem[]
}

// S1 nav config: Chat (Core) + Settings (System). Everything else waits on
// the pages that back it. `SURFACE_PRESET` is hardcoded to 'advanced' until
// a real feature-flag source lands — see brief adaptation notes.
export const navSections: NavSection[] = [
  {
    // Core — no label, always visible
    items: [
      { to: '/chat', label: 'Chat', icon: MessageSquare, minRole: 'guest' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/governance', label: 'Governance', icon: ScrollText, minRole: 'admin' },
      { to: '/quality', label: 'AI Quality', icon: Gauge, minRole: 'admin' },
      { to: '/activity', label: 'Activity', icon: Activity, minRole: 'admin' },
      { to: '/schedules', label: 'Schedules', icon: CalendarClock, minRole: 'admin' },
      // S12: the agents the household runs — between what fires and what
      // was written, since an agent is what the one does and what the other
      // shows.
      { to: '/agents', label: 'Agents', icon: Bot, minRole: 'admin' },
      { to: '/files', label: 'Files', icon: FolderOpen, minRole: 'admin' },
      { to: '/models', label: 'Models', icon: Boxes, minRole: 'admin' },
      { to: '/spend', label: 'Spend', icon: Coins, minRole: 'admin' },
      { to: '/settings', label: 'Settings', icon: Settings, minRole: 'admin' },
    ],
  },
]

const SURFACE_PRESET: SurfacePreset = 'advanced'

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const userRole: Role = user?.role ?? 'guest'
  const isActive = (to: string) => {
    return location.pathname === to
  }

  return (
    <aside
      className={clsx(
        'hidden md:flex flex-col h-full bg-surface border-r border-border-subtle transition-[width] duration-200 ease-in-out shrink-0 glass-nav dark:border-white/[0.06]',
        collapsed ? 'w-[60px]' : 'w-[240px]',
      )}
    >
      {/* Logo — plain rounded square with the letter N, brand pass comes later */}
      <div className={clsx('flex items-center gap-2.5 px-3 h-14 shrink-0 cursor-pointer', collapsed && 'justify-center')} onClick={() => navigate('/chat')} title="Nova">
        <div className="h-7 w-7 rounded-lg bg-accent flex items-center justify-center text-on-accent text-compact font-semibold shrink-0 dark:shadow-[0_0_16px_rgb(var(--accent-500)/0.3)]">
          N
        </div>
        {!collapsed && (
          <span className="text-h3 text-content-primary tracking-tight">Nova</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {navSections.map((section, sIdx) => {
          const visibleItems = filterNavItemsByPreset(section.items, SURFACE_PRESET)
            .filter(item => hasMinRole(userRole, item.minRole))
          if (visibleItems.length === 0) return null
          return (
            <div key={sIdx}>
              {section.label && !collapsed && (
                <div className="text-micro font-semibold uppercase tracking-wider text-content-tertiary px-2.5 mb-1">
                  {section.label}
                </div>
              )}
              {collapsed && section.label && (
                <div className="h-px bg-border-subtle mx-2 mb-2" />
              )}
              <div className="space-y-0.5">
                {visibleItems.map(item => {
                  const Icon = item.icon
                  const active = isActive(item.to)
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      title={collapsed ? item.label : undefined}
                      className={clsx(
                        'relative flex items-center gap-2.5 rounded-md text-compact font-medium transition-colors duration-fast',
                        collapsed ? 'justify-center px-2 py-2' : 'px-2.5 py-2',
                        active
                          ? 'bg-accent-dim text-accent dark:shadow-[inset_0_0_20px_rgb(var(--accent-500)/0.06)]'
                          : 'text-content-secondary hover:text-content-primary hover:bg-surface-card',
                      )}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-accent" />
                      )}
                      <Icon className="w-[18px] h-[18px] shrink-0" />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </NavLink>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      {/* User card — static for now, no session actions until Task 6 wires real auth */}
      {!collapsed && user && (
        <div className="px-2 pb-2">
          <div className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-white text-caption font-medium shrink-0">
              {getInitials(user.name)}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className="text-compact font-medium text-content-primary truncate">
                {user.name}
              </div>
              <div className="text-micro text-content-tertiary capitalize">{user.role}</div>
            </div>
          </div>
        </div>
      )}

      {/* Collapse toggle */}
      <div className="px-2 pb-3 shrink-0">
        <button
          onClick={onToggle}
          className={clsx(
            'flex items-center gap-2 rounded-md text-content-tertiary hover:text-content-primary hover:bg-surface-card transition-colors duration-fast w-full',
            collapsed ? 'justify-center px-2 py-2' : 'px-2.5 py-2',
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronsRight className="w-[18px] h-[18px]" />
          ) : (
            <>
              <ChevronsLeft className="w-[18px] h-[18px]" />
              <span className="text-compact">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
