import { useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { EllipsisVertical, X } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../stores/auth-store'
import { hasMinRole, type Role } from '../../lib/roles'
import { useMobileNav } from '../../hooks/useMobileNav'
import { useUnseenNotices } from '../../hooks/useUnseenNotices'
import { filterNavItemsByPreset, type SurfacePreset } from './sidebarFilter'
import { NavCountBadge, navBadgeState, navSections, type NavItem, type NavSection } from './Sidebar'

// The nav config is Sidebar's, DERIVED rather than copied: the unlabelled
// (Core) sections are the primary tabs, every labelled section is tucked
// into "More" — the same entries in the same order by construction. The two
// lists used to be hand-mirrored and had drifted once (Governance was
// missing here until S9). SURFACE_PRESET is hardcoded to 'advanced' until a
// real feature-flag source lands — see brief adaptation notes.
export const primaryTabs: NavItem[] = navSections
  .filter(section => section.label === undefined)
  .flatMap(section => section.items)

export const moreItems: NavSection[] = navSections.filter(section => section.label !== undefined)

const SURFACE_PRESET: SurfacePreset = 'advanced'

/** The panel's width. A fixed number rather than a percentage because the
 *  drag maths is in pixels and a panel that changes width mid-gesture makes
 *  the finger and the edge disagree. */
const PANEL_W = 300

/** Past this fraction of the panel, releasing opens; below it, it snaps
 *  back. Half is the least surprising place for it. */
const SETTLE_AT = 0.5

export function MobileNav() {
  const [open, setOpen] = useState(false)
  /** How far the panel has been pulled in, in px, while a finger is down.
   *  null means no drag is in progress and CSS owns the position. */
  const [dragX, setDragX] = useState<number | null>(null)
  const dragFrom = useRef<{ x: number; y: number; axis: 'none' | 'x' | 'y' } | null>(null)

  const location = useLocation()
  const { user } = useAuth()
  const userRole: Role = user?.role ?? 'guest'
  const { hidden } = useMobileNav()
  const unseen = useUnseenNotices()

  const isActive = (to: string) => location.pathname === to
  const moreActive = moreItems.some(section => section.items.some(item => isActive(item.to)))

  // Where the panel sits right now. During a drag it follows the finger;
  // otherwise CSS moves it and the transition below animates the change.
  const panelX = dragX !== null ? Math.min(0, dragX - PANEL_W) : open ? 0 : -PANEL_W
  const progress = (panelX + PANEL_W) / PANEL_W

  const beginDrag = (e: React.TouchEvent, from: number) => {
    const t = e.touches[0]
    dragFrom.current = { x: t.clientX, y: t.clientY, axis: 'none' }
    setDragX(from)
  }

  const moveDrag = (e: React.TouchEvent, from: number) => {
    const start = dragFrom.current
    if (!start) return
    const t = e.touches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    // Decide once which way this gesture is going. Without the lock, a
    // mostly-vertical scroll that drifts sideways drags the panel open a few
    // pixels and fights the list.
    if (start.axis === 'none') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      start.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (start.axis === 'y') return
    setDragX(Math.max(0, Math.min(PANEL_W, from + dx)))
  }

  const endDrag = () => {
    const settled = progress > SETTLE_AT
    dragFrom.current = null
    setDragX(null)
    setOpen(settled)
  }

  const close = () => {
    dragFrom.current = null
    setDragX(null)
    setOpen(false)
  }

  return (
    <>
      {/* The GRIP, replacing a two-item bottom tab bar (2026-09-15).

          The bar was pinned to the one edge this app could not control: on
          the owner's iPhone the web view is shorter than the screen, so a
          dead strip sat below anything at bottom:0, and four attempts did
          not fix it. Nothing is pinned there now, so the strip is background
          rather than a visible defect. The bar's other item was "Chat",
          which on a phone is always the current page.

          NO BADGE HERE, by the owner's call (2026-09-15): a count on a
          closed handle is noise. The unseen count still rides the Inbox row
          INSIDE the panel, where it is read rather than glanced at — the
          trade he chose. */}
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        data-testid="edge-handle"
        onClick={() => setOpen(true)}
        onTouchStart={e => beginDrag(e, 0)}
        onTouchMove={e => moveDrag(e, 0)}
        onTouchEnd={endDrag}
        className={clsx(
          'md:hidden fixed left-0 top-1/2 -translate-y-1/2 z-40',
          'flex items-center justify-center',
          // 16px of visible tab with a 40px touch target bled off-screen —
          // narrower than the first attempt, which the owner found wide.
          'h-16 w-10 -ml-6 pl-6',
          'rounded-r-lg bg-surface-elevated/60 border border-l-0 border-border-subtle',
          'backdrop-blur transition-opacity duration-fast active:opacity-100',
          open ? 'opacity-0 pointer-events-none' : 'opacity-70',
          hidden && 'opacity-0 pointer-events-none',
        )}
      >
        <EllipsisVertical
          size={16}
          className={moreActive ? 'text-accent' : 'text-content-tertiary'}
        />
      </button>

      {/* The PANEL. Mounted whenever it is open OR mid-drag, so a gesture has
          something to pull; unmounted at rest so it costs nothing. */}
      {(open || dragX !== null) && (
        <div className="md:hidden fixed inset-0 z-50" data-testid="mobile-drawer">
          {/* The backdrop darkens WITH the drag rather than snapping, which
              is most of what makes the motion read as a physical object. */}
          <div
            className="absolute inset-0 bg-black/70"
            style={{
              opacity: progress,
              transition: dragX !== null ? 'none' : 'opacity 220ms cubic-bezier(.22,.61,.36,1)',
            }}
            onClick={close}
          />
          <div
            data-testid="mobile-drawer-panel"
            onTouchStart={e => beginDrag(e, PANEL_W)}
            onTouchMove={e => moveDrag(e, PANEL_W)}
            onTouchEnd={endDrag}
            className={clsx(
              'absolute left-0 top-0 bottom-0 flex flex-col',
              'bg-surface-root glass-overlay border-r border-border-subtle',
              // A full-screen overlay sits outside <main>, so it pads the
              // insets itself — otherwise its header, and the only way out,
              // is drawn under the status bar. That trapped the owner in the
              // old full-screen drawer on 2026-09-15.
              'pt-[var(--nova-safe-top,0px)] pb-[var(--nova-safe-bottom,0px)]',
            )}
            style={{
              width: PANEL_W,
              transform: `translateX(${panelX}px)`,
              // No transition while a finger is down: the panel IS the
              // finger then. The curve only runs on release and on tap.
              transition:
                dragX !== null ? 'none' : 'transform 220ms cubic-bezier(.22,.61,.36,1)',
            }}
          >
            <div className="flex items-center justify-between px-4 h-14 border-b border-border-subtle shrink-0">
              <span className="text-h3 text-content-primary">Menu</span>
              <button
                onClick={close}
                aria-label="Close menu"
                className="p-2 text-content-tertiary hover:text-content-primary transition-colors duration-fast rounded-md"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
              {moreItems.map((section, sIdx) => {
                const visibleItems = filterNavItemsByPreset(section.items, SURFACE_PRESET).filter(
                  item => hasMinRole(userRole, item.minRole),
                )
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
                        const badge = navBadgeState(item, unseen)
                        return (
                          <NavLink
                            key={item.to}
                            to={item.to}
                            title={badge.title}
                            onClick={close}
                            className={clsx(
                              'flex items-center gap-3 px-3 py-3 rounded-md text-body font-medium transition-colors duration-fast',
                              active
                                ? 'bg-accent-dim text-accent'
                                : 'text-content-secondary hover:text-content-primary hover:bg-surface-card',
                            )}
                          >
                            <Icon className="w-5 h-5 shrink-0" />
                            <span className="flex-1">{item.label}</span>
                            {badge.count !== null && <NavCountBadge count={badge.count} />}
                          </NavLink>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
