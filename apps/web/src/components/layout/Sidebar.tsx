import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, NavLink, useNavigate } from 'react-router-dom'
import { Activity, BookOpen, Bot, Boxes, CalendarClock, Coins, FolderOpen, Gauge, GripVertical, Inbox, MessageSquare, ScrollText, Settings } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../stores/auth-store'
import { hasMinRole, type Role } from '../../lib/roles'
import { useUnseenNotices } from '../../hooks/useUnseenNotices'
import { filterNavItemsByPreset, type SurfacePreset } from './sidebarFilter'
import { useTheme } from '../../stores/theme-store'
import { appIcon, appIconHref } from '../../lib/app-icon'

/** The one count a nav entry can carry (S11). A KEY, not a number: this
 * config is static and the count is live, read from the server by
 * useUnseenNotices — a number stored here would be a client's guess. */
export type NavBadge = 'unseen_notices'

export type NavItem = {
  to: string
  label: string
  icon: typeof MessageSquare
  minRole: Role
  presetVisibility?: SurfacePreset[]
  badge?: NavBadge
}

export type NavSection = {
  label?: string
  items: NavItem[]
}

/** The sidebar's width, in px. COLLAPSED is icons only; DEFAULT is what it
 *  has always been; the range is where a drag can leave it. */
export const SIDEBAR = {
  /**
   * Collapsed is GONE, not a strip of icons (2026-09-16).
   *
   * It was 60px of icon rail, which is a reasonable thing to build and not
   * what the owner asked for: he pointed at an app whose sidebar closes to
   * nothing and hands the whole window to the content. An icon rail is a
   * third state — neither the full list nor the space back — and it keeps
   * charging 60px for navigation you are not using.
   *
   * The way back is the toggle in the header, which is always there, plus
   * the edge handle, which stays reachable at x=0.
   */
  COLLAPSED: 0,
  DEFAULT: 240,
  MIN: 180,
  MAX: 420,
  /** Dragged narrower than this, it collapses rather than getting squeezed —
   *  the same way a desktop editor's panel does, so "drag it shut" works
   *  without aiming for a 16px target. */
  COLLAPSE_AT: 140,
} as const

const WIDTH_KEY = 'nova-sidebar-width'

/** A stored or dragged width, brought into range. Exported pure: a value
 *  from localStorage was written by some other session, possibly on a much
 *  wider screen, and a hand-edited one could be anything at all. */
export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR.DEFAULT
  return Math.min(Math.max(Math.round(w), SIDEBAR.MIN), SIDEBAR.MAX)
}

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    return raw === null ? SIDEBAR.DEFAULT : clampSidebarWidth(Number(raw))
  } catch {
    return SIDEBAR.DEFAULT
  }
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
      // S17: the procedures written down from what worked before. Beside
      // Agents, because both answer "what does this household know how to
      // do" — one as a who, the other as a how.
      { to: '/skills', label: 'Skills', icon: BookOpen, minRole: 'admin' },
      // S11: what she noticed without being asked, and what she did about
      // it. Straight after Agents — the beats are the last thing that acts on
      // its own, and this is the record of those actions.
      { to: '/inbox', label: 'Inbox', icon: Inbox, minRole: 'admin', badge: 'unseen_notices' },
      { to: '/files', label: 'Files', icon: FolderOpen, minRole: 'admin' },
      { to: '/models', label: 'Models', icon: Boxes, minRole: 'admin' },
      { to: '/spend', label: 'Spend', icon: Coins, minRole: 'admin' },
      { to: '/settings', label: 'Settings', icon: Settings, minRole: 'admin' },
    ],
  },
]

const SURFACE_PRESET: SurfacePreset = 'advanced'

/** A nav entry's count, drawn the same way on both surfaces (S11) so one
 * entry cannot show two numbers. Only ever rendered for a count that came
 * from the server — see navBadgeState. */
export function NavCountBadge({ count, compact = false }: { count: number; compact?: boolean }) {
  return (
    <span
      data-testid="nav-count-badge"
      className={clsx(
        'inline-flex items-center justify-center rounded-full bg-accent text-on-accent font-semibold tabular-nums',
        compact ? 'h-3.5 min-w-3.5 px-1 text-[9px]' : 'h-4 min-w-4 px-1.5 text-micro',
      )}
    >
      {count}
    </span>
  )
}

/**
 * What a badged entry shows, and what it says about itself.
 *
 * `count` is only ever the server's — null means "not read yet, or the read
 * failed", and both surfaces render nothing for null rather than a 0. That
 * silence would read as "nothing is waiting", which is a success claim nobody
 * checked, so an unreadable count is stated in the entry's own title instead.
 */
export function navBadgeState(
  item: Pick<NavItem, 'badge'>,
  unseen: { count: number | null; error: string | null },
): { count: number | null; title: string | undefined } {
  if (item.badge !== 'unseen_notices') return { count: null, title: undefined }
  if (unseen.error !== null) {
    return {
      count: unseen.count,
      title: `the unread count could not be read — ${unseen.error}`,
    }
  }
  return { count: unseen.count, title: undefined }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function Sidebar({
  collapsed,
  onCollapsedChange,
}: {
  collapsed: boolean
  /** A SETTER rather than a toggle: a drag ends on a definite state — it
   *  knows whether it finished wide or shut — and a toggle would make it
   *  guess from the state it started in. */
  onCollapsedChange: (collapsed: boolean) => void
}) {
  const [width, setWidth] = useState(readWidth)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; w: number; moved: boolean } | null>(null)

  // Persist only settled widths. Writing on every pointermove would put a
  // localStorage round-trip in the middle of a drag.
  useEffect(() => {
    if (dragging) return
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // A browser with storage off just gets the default width next load.
    }
  }, [dragging, width])

  /** One place that decides what a given pixel width MEANS, so the pointer
   *  drag and the arrow keys cannot drift apart. */
  const applyWidth = useCallback(
    (raw: number) => {
      if (raw < SIDEBAR.COLLAPSE_AT) {
        onCollapsedChange(true)
        return
      }
      onCollapsedChange(false)
      setWidth(clampSidebarWidth(raw))
    },
    [onCollapsedChange],
  )

  const beginResize = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, w: collapsed ? SIDEBAR.COLLAPSED : width, moved: false }
    setDragging(true)
  }

  const resize = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    // A few pixels of slop, so a click that trembles stays a click.
    if (!d.moved && Math.abs(dx) < 4) return
    d.moved = true
    applyWidth(d.w + dx)
  }

  const endResize = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
    setDragging(false)
  }

  /** The click that every pointer sequence ends with. It must not toggle
   *  after a drag, or a drag-to-resize would collapse the panel it just
   *  sized. */
  const tapHandle = () => {
    const moved = drag.current?.moved === true
    drag.current = null
    if (moved) return
    onCollapsedChange(!collapsed)
  }

  /** The same control, without a pointer. */
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      applyWidth((collapsed ? SIDEBAR.COLLAPSED : width) - step)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      applyWidth(collapsed ? SIDEBAR.MIN : width + step)
    }
  }

  const location = useLocation()
  const navigate = useNavigate()
  const { brandIcon, mode, preset, customAccent } = useTheme()
  const { user } = useAuth()
  const unseen = useUnseenNotices()
  const userRole: Role = user?.role ?? 'guest'
  const isActive = (to: string) => {
    return location.pathname === to
  }

  return (
    <aside
      data-testid="sidebar"
      className={clsx(
        'hidden md:flex flex-col h-full bg-surface shrink-0 glass-nav relative',
        // No border and no content when closed: a 1px line down the left of
        // the window is the icon rail's ghost.
        collapsed ? 'overflow-hidden' : 'border-r border-border-subtle dark:border-white/[0.06]',
        // No transition while a pointer is down: the edge IS the pointer
        // then, and easing it makes the drag feel like it is lagging.
        !dragging && 'transition-[width] duration-200 ease-in-out',
      )}
      style={{ width: collapsed ? SIDEBAR.COLLAPSED : width }}
    >
      {/* The EDGE HANDLE, which replaced a "Collapse" row at the foot of the
          panel (2026-09-15). Three things the row could not do: it is the
          same shape and gesture as the phone's grip, so one idea covers both
          surfaces; it is reachable without looking at the bottom of a list
          that scrolls; and the edge is where a resize has to be anyway, so
          the control and the thing it controls are the same target.

          Click toggles. Drag sets the width, and dragging it narrower than
          COLLAPSE_AT shuts it — a desktop panel's usual behaviour, and it
          means "drag it closed" works without aiming at a 16px tab. Arrow
          keys do the same for anyone not using a mouse. */}
      <button
        type="button"
        data-testid="sidebar-handle"
        aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-expanded={!collapsed}
        onPointerDown={beginResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onClick={tapHandle}
        onKeyDown={nudge}
        className={clsx(
          // FULL HEIGHT, not a tab at the midpoint (2026-09-16). The edge
          // IS the control, so the whole edge should answer to the pointer —
          // aiming at a 64px tab to resize a panel is a target you have to
          // find first. 8px of reach, 2px of visible line, and the line only
          // appears under the pointer: a permanent rule down the window is
          // furniture.
          'group absolute inset-y-0 left-full z-30 w-2 -ml-1',
          'flex items-stretch justify-center',
          'cursor-col-resize touch-none',
        )}
      >
        <span
          aria-hidden="true"
          className="w-[2px] rounded-full bg-accent opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70 transition-opacity duration-fast"
        />
        {/* Both actions and the shortcut, because the control does two
            things and neither is guessable from a line: click hides it,
            drag sizes it. Its own element rather than `title`, so it can say
            two lines and appear without the browser's half-second delay. */}
        <span
          data-testid="sidebar-handle-tip"
          role="tooltip"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 z-40 hidden group-hover:block group-focus-visible:block whitespace-nowrap rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-caption text-content-primary shadow-lg"
        >
          <span className="block">
            {collapsed ? 'Show sidebar' : 'Hide sidebar'}{' '}
            <kbd className="ml-1 text-micro text-content-tertiary">Ctrl+B</kbd>
          </span>
          <span className="block text-content-tertiary">Drag to resize</span>
        </span>
      </button>
      {/* The brand mark. Chosen in Appearance, separately from the favicon,
          and drawn from the live palette (src/lib/app-icon.ts) rather than
          hardcoded here — so a theme change moves it and a new icon needs no
          edit in this file.

          The rounded tile and its glow apply only to a FILLED mark: they
          belong to a solid shape, and drawn behind art that fades to
          transparency they read as a square halo around a round orb. The
          choice declares which it is; this does not keep a list. */}
      <div className={clsx('flex items-center gap-2.5 px-3 h-14 shrink-0 cursor-pointer', collapsed && 'justify-center')} onClick={() => navigate('/chat')} title="Nova">
        <img
          src={appIconHref(brandIcon, mode, preset, customAccent)}
          alt=""
          aria-hidden="true"
          data-testid="brand-mark"
          className={clsx(
            'h-7 w-7 shrink-0',
            appIcon(brandIcon).filled &&
              'rounded-lg dark:shadow-[0_0_16px_rgb(var(--accent-500)/0.3)]',
          )}
        />
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
                  const badge = navBadgeState(item, unseen)
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      title={badge.title ?? (collapsed ? item.label : undefined)}
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
                      {badge.count !== null && badge.count > 0 && (
                        <span className={clsx(collapsed ? 'absolute -top-0.5 right-0.5' : 'ml-auto')}>
                          <NavCountBadge count={badge.count} compact={collapsed} />
                        </span>
                      )}
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

      {/* The "Collapse" row that stood here until 2026-09-15 is gone: the
          edge handle above does its job, in the place a resize has to live
          anyway, and a row at the foot of a scrolling list was the least
          findable spot on the panel. */}
    </aside>
  )
}
