import { useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../stores/auth-store'
import { hasMinRole, type Role } from '../../lib/roles'
import { useMobileNav } from '../../hooks/useMobileNav'
import { useUnseenNotices } from '../../hooks/useUnseenNotices'
import { filterNavItemsByPreset, type SurfacePreset } from './sidebarFilter'
import { AccountMenu } from './AccountMenu'
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

type DragStart = {
  x: number
  y: number
  /** 'y' still exists as a value so a mostly-vertical gesture can be
   *  RECOGNISED and then ignored — scrolling the panel's own list must not
   *  drag it sideways a few pixels on the way. Nothing acts on it any more:
   *  the grip it used to move is gone (2026-09-16). */
  axis: 'none' | 'x' | 'y'
}

export function MobileNav() {
  const [open, setOpen] = useState(false)
  /** How far the panel has been pulled in, in px, while a finger is down.
   *  null means no drag is in progress and CSS owns the position. */
  const [dragX, setDragX] = useState<number | null>(null)
  const dragFrom = useRef<DragStart | null>(null)
  /** Did the last touch actually travel? Read by `tap`, below. */
  const dragged = useRef(false)

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

  const beginDrag = (e: React.TouchEvent) => {
    const t = e.touches[0]
    dragFrom.current = {
      x: t.clientX,
      y: t.clientY,
      axis: 'none',
    }
  }

  const moveDrag = (e: React.TouchEvent, from: number) => {
    const start = dragFrom.current
    if (!start) return
    const t = e.touches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    // Decide once which way this gesture is going. Without the lock, a
    // mostly-vertical move that drifts sideways would drag the panel open a
    // few pixels while also moving the grip.
    if (start.axis === 'none') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      start.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      dragged.current = true
    }
    setDragX(Math.max(0, Math.min(PANEL_W, from + dx)))
  }

  const endDrag = () => {
    // A tap ends here too, and `tap` owns that — so a gesture that never
    // became a horizontal drag must not touch `open`.
    if (dragX === null) return
    const settled = progress > SETTLE_AT
    setDragX(null)
    setOpen(settled)
  }

  /** A tap toggles. Guarded because a touch sequence ends with a synthetic
   *  click: without this, a drag that settled would immediately be undone by
   *  its own click. (Browsers suppress the click past their movement slop,
   *  but the slop is smaller than this panel's and not worth trusting.) */
  const tap = () => {
    if (dragged.current) {
      dragged.current = false
      return
    }
    setOpen(o => !o)
  }

  const close = () => {
    dragFrom.current = null
    setDragX(null)
    setOpen(false)
  }

  return (
    <>
      {/* THE WAY IN, top-left (2026-09-16, owner's call).

          This was an edge GRIP for a day: a tab riding the panel's edge,
          draggable up and down to sit where his thumb was. He asked for
          that and then asked for this — "make it look and feel more like
          Claude" — and a menu button in the corner is what that means.

          It replaced a bottom tab bar before it, which had been pinned to
          the one edge this app cannot control: on the owner's iPhone the
          web view is shorter than the screen, so a dead strip sat below
          anything at bottom:0. Nothing is pinned there now, and this sits
          INSIDE the top safe inset rather than under the status bar.

          NO BADGE HERE, by the owner's call (2026-09-15): a count on a
          closed menu is noise. The unseen count still rides the Inbox row
          inside the panel, where it is read rather than glanced at.

          Hidden while the panel is open — the panel has its own close — so
          two controls for one state never sit on screen together. */}
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        data-testid="menu-button"
        onClick={() => setOpen(true)}
        className={clsx(
          'md:hidden fixed left-3 z-[60] inline-flex items-center justify-center',
          'h-9 w-9 rounded-md text-content-secondary',
          'hover:text-content-primary hover:bg-surface-card transition-colors duration-fast',
          (hidden || open) && 'opacity-0 pointer-events-none',
        )}
        style={{ top: 'calc(var(--nova-safe-top, 0px) + 0.75rem)' }}
      >
        <Menu size={20} />
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
            onTouchStart={beginDrag}
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
            {/* EVERY section, not just the labelled ones. "Chat" lives in
                the unlabelled Core section, which `moreItems` filters out —
                so when the bottom tab bar was deleted earlier on 2026-09-15
                it took the only route back to chat with it, and the owner
                had to force-quit the app to return to it. */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
              {navSections.map((section, sIdx) => {
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
            {/* HIS NAME, on the phone too (2026-09-16). It was desktop-only,
                which left Settings, Usage and "what she has done" reachable
                on a laptop and nowhere at all on the device he actually
                carries — and this is now their ONLY home, since the nav
                above stopped listing them. It sits at the foot, where a
                person looks for their own account. */}
            <div className="shrink-0 border-t border-border-subtle p-2" data-testid="mobile-account">
              <AccountMenu onNavigate={close} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
