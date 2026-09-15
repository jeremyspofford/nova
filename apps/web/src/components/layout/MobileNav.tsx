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

/** How far right a touch must travel to count as opening the drawer. Short
 *  enough to feel immediate, long enough that a tap is a tap. */
const SWIPE_OPEN_PX = 24

export function MobileNav() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const { user } = useAuth()
  const userRole: Role = user?.role ?? 'guest'
  const { hidden } = useMobileNav()
  // The same server count the sidebar shows — one source, so the two
  // surfaces over one nav config cannot disagree about what is waiting.
  const unseen = useUnseenNotices()

  const isActive = (to: string) => {
    return location.pathname === to
  }

  // Check if any "more" item is active
  const moreActive = moreItems.some(section =>
    section.items.some(item => isActive(item.to)),
  )

  // Swipe-to-open. Deliberately small and explicit rather than a gesture
  // library: a touch that starts on the handle and travels right by more
  // than it travels down is an open. The vertical test is what stops a
  // scroll that happens to begin on the handle from opening the drawer.
  // The handle's count is the INBOX item's own badge state, derived through
  // the same helper the sidebar uses — one source, so the two surfaces over
  // one nav config cannot disagree about what is waiting.
  const inboxItem = moreItems
    .flatMap(section => section.items)
    .find(item => item.badge === 'unseen_notices')
  const badge = inboxItem
    ? navBadgeState(inboxItem, unseen)
    : { count: null, title: undefined }

  const drag = useRef<{ x: number; y: number } | null>(null)

  const onEdgeTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    drag.current = { x: t.clientX, y: t.clientY }
  }

  const onEdgeTouchMove = (e: React.TouchEvent) => {
    if (!drag.current) return
    const t = e.touches[0]
    const dx = t.clientX - drag.current.x
    const dy = Math.abs(t.clientY - drag.current.y)
    if (dx > SWIPE_OPEN_PX && dx > dy) {
      drag.current = null
      setDrawerOpen(true)
    }
  }

  const onEdgeTouchEnd = () => {
    drag.current = null
  }


  return (
    <>
      {/* The EDGE HANDLE, replacing a two-item bottom tab bar (2026-09-15).
          Three reasons it moved, in order of weight:

          1. The bar was pinned to the one edge this app has repeatedly failed
             to control. On the owner's iPhone the web view is shorter than
             the screen, so a dead strip sits below anything at bottom:0 —
             four attempts did not fix it. Nothing is pinned there now, so the
             strip is background rather than a visible defect.
          2. One of its two items was "Chat", which on a phone is always the
             current page. It cost ~90px of a 852px screen for one useful tap.
          3. It carried the unseen-notice count, which is the only signal that
             anything needs him — so that count moves onto the handle rather
             than being lost.

          The handle is BOTH the gesture's affordance and a tap target. The
          owner chose the swipe knowing it is the least discoverable option;
          iOS may also claim a left-edge swipe for its own back gesture in a
          standalone app, which this cannot override. The tap is therefore the
          path that is guaranteed to work, and the swipe is the fast one. */}
      <button
        type="button"
        aria-label={badge.count ? `Open menu, ${badge.count} waiting` : 'Open menu'}
        title={badge.title}
        data-testid="edge-handle"
        onClick={() => setDrawerOpen(true)}
        onTouchStart={onEdgeTouchStart}
        onTouchMove={onEdgeTouchMove}
        onTouchEnd={onEdgeTouchEnd}
        className={clsx(
          'md:hidden fixed left-0 z-40 flex items-center justify-center',
          // A grip down the left edge: 28px of visible tab, but 44px of
          // touch target (Apple's minimum) bled off-screen to the left via
          // the negative margin, so it is easy to hit and quiet to look at.
          // Vertically centred, so it is reachable whichever hand holds the
          // phone and it never collides with the composer.
          'top-1/2 -translate-y-1/2 h-20 w-[44px] -ml-4 pl-4',
          'rounded-r-xl bg-surface-elevated/70 border border-l-0 border-border-subtle',
          'backdrop-blur transition-transform duration-fast active:scale-95',
          hidden && '-translate-x-full',
        )}
      >
        <span className="relative flex items-center justify-center">
          <EllipsisVertical
            size={18}
            className={moreActive ? 'text-accent' : 'text-content-tertiary'}
          />
          {badge.count !== null && (
            // Pinned to the grip's top-right rather than stacked under the
            // dots: the count is the only signal that anything needs him, and
            // stacked it read as a separate floating object.
            <span data-testid="edge-handle-badge" className="absolute -top-3 -right-1">
              <NavCountBadge count={badge.count} compact />
            </span>
          )}
        </span>
      </button>

      {/* Full-screen drawer */}
      {drawerOpen && (
        /* A `fixed inset-0` overlay sits OUTSIDE <main>, so the top inset
           <main> carries never reaches it: on a full-bleed phone this header
           — the title and the only way out — was drawn under the status bar,
           and the owner was trapped in the drawer (2026-09-15). Every
           full-screen overlay pads both insets itself. */
        <div data-testid="mobile-drawer" className="md:hidden fixed inset-0 z-50 bg-surface-root dark:bg-transparent glass-overlay animate-fade-in pt-[var(--nova-safe-top,0px)] pb-[var(--nova-safe-bottom,0px)]">
          <div className="flex items-center justify-between px-4 h-14 border-b border-border-subtle">
            <span className="text-h3 text-content-primary">Menu</span>
            <button
              onClick={() => setDrawerOpen(false)}
              className="p-2 text-content-tertiary hover:text-content-primary transition-colors duration-fast rounded-md"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* 100dvh, not 100vh: iOS's 100vh is the tallest the viewport ever
              gets, so the last item sat under the home indicator. The insets
              come off too, since the container now pads for them. */}
          <div
            className="overflow-y-auto p-4 space-y-6"
            style={{
              maxHeight:
                'calc(100dvh - 3.5rem - var(--nova-safe-top,0px) - var(--nova-safe-bottom,0px))',
            }}
          >
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
                      const badge = navBadgeState(item, unseen)
                      return (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          title={badge.title}
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
                          {badge.count !== null && badge.count > 0 && (
                            <span className="ml-auto">
                              <NavCountBadge count={badge.count} />
                            </span>
                          )}
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
