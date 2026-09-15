import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { GripVertical, X } from 'lucide-react'
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

/** The visible tab, and the touch target around it. The target is
 *  thumb-sized and the tab is not, so the extra width is transparent — and
 *  it extends to the RIGHT of the tab, never to the left. Bleeding it
 *  leftward was free while the grip lived at the screen edge, but the grip
 *  now rides the panel's edge, and there the same bleed laid 24px of button
 *  over the menu items. The owner's call (2026-09-15): the handle belongs
 *  on the edge of the menu, not in it. */
const GRIP_TAB_W = 16
const GRIP_HIT_W = 40
const GRIP_H = 64

/** How far the grip is kept from the top and bottom of the screen. */
const GRIP_MARGIN = 8

const GRIP_Y_KEY = 'nova-grip-y'

/** Keep the grip wholly on screen wherever it was left. A position saved in
 *  landscape, or before a rotation, must not strand it half off an edge.
 *  Pure, so the rule is testable without a device. */
export function clampGripY(y: number, viewportH: number): number {
  const lowest = Math.max(GRIP_MARGIN, viewportH - GRIP_H - GRIP_MARGIN)
  return Math.min(Math.max(y, GRIP_MARGIN), lowest)
}

function readGripY(): number | null {
  try {
    const raw = localStorage.getItem(GRIP_Y_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

type DragStart = {
  x: number
  y: number
  axis: 'none' | 'x' | 'y'
  /** Where the grip's top edge was when the finger went down. A vertical
   *  drag moves it relative to this, so the grip does not jump to centre
   *  itself under the thumb the moment the gesture is recognised. */
  gripTop: number
}

export function MobileNav() {
  const [open, setOpen] = useState(false)
  /** How far the panel has been pulled in, in px, while a finger is down.
   *  null means no drag is in progress and CSS owns the position. */
  const [dragX, setDragX] = useState<number | null>(null)
  /** Where the owner put the grip, in px from the top. null means he has
   *  never moved it, which centres it. */
  const [gripY, setGripY] = useState<number | null>(readGripY)
  const dragFrom = useRef<DragStart | null>(null)
  /** Did the last touch actually travel? Read by `tap`, below. */
  const dragged = useRef(false)
  const gripRef = useRef<HTMLButtonElement>(null)

  const location = useLocation()
  const { user } = useAuth()
  const userRole: Role = user?.role ?? 'guest'
  const { hidden } = useMobileNav()
  const unseen = useUnseenNotices()

  const isActive = (to: string) => location.pathname === to
  const moreActive = moreItems.some(section => section.items.some(item => isActive(item.to)))

  // A rotation can leave a saved position off the screen. Only the PRESENCE
  // of one is in the dep list — re-running on every pixel of a drag would
  // fight the drag.
  const placed = gripY !== null
  useEffect(() => {
    if (!placed) return
    const reclamp = () => setGripY(y => (y === null ? null : clampGripY(y, window.innerHeight)))
    reclamp()
    window.addEventListener('resize', reclamp)
    window.addEventListener('orientationchange', reclamp)
    return () => {
      window.removeEventListener('resize', reclamp)
      window.removeEventListener('orientationchange', reclamp)
    }
  }, [placed])

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
      gripTop: gripRef.current?.getBoundingClientRect().top ?? 0,
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
    // Across: the panel. Up and down: the grip itself — the owner asked to
    // be able to put the handle where his thumb actually is (2026-09-15).
    if (start.axis === 'y') {
      setGripY(clampGripY(start.gripTop + dy, window.innerHeight))
      return
    }
    setDragX(Math.max(0, Math.min(PANEL_W, from + dx)))
  }

  const endDrag = () => {
    const axis = dragFrom.current?.axis
    dragFrom.current = null
    if (axis === 'y') {
      // Remember where he put it. A grip that resets on reload is a
      // preference he has to keep re-stating, which is not a preference.
      try {
        if (gripY !== null) localStorage.setItem(GRIP_Y_KEY, String(gripY))
      } catch {
        // A browser with storage off just gets a centred grip next load.
      }
      return
    }
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
      {/* The GRIP, replacing a two-item bottom tab bar (2026-09-15).

          The bar was pinned to the one edge this app could not control: on
          the owner's iPhone the web view is shorter than the screen, so a
          dead strip sat below anything at bottom:0, and four attempts did
          not fix it. Nothing is pinned there now.

          NO BADGE HERE, by the owner's call (2026-09-15): a count on a
          closed handle is noise. The unseen count still rides the Inbox row
          INSIDE the panel, where it is read rather than glanced at — the
          trade he chose. */}
      <button
        ref={gripRef}
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        data-testid="edge-handle"
        onClick={tap}
        onTouchStart={beginDrag}
        onTouchMove={e => moveDrag(e, open ? PANEL_W : 0)}
        onTouchEnd={endDrag}
        className={clsx(
          'md:hidden fixed left-0 z-[60] flex items-center justify-start',
          hidden && 'opacity-0 pointer-events-none',
        )}
        style={{
          // The grip RIDES the panel's right edge rather than disappearing
          // when it opens: closed it sits at the screen edge, open it sits
          // on the panel's edge, and mid-gesture it tracks the finger. So
          // the same handle that pulls the menu out is visibly the one that
          // pushes it back — what the owner asked for in preference to a
          // "<<" button.
          //
          // Moved by TRANSFORM, not by `left`. Animating `left` forces a
          // layout pass on every frame of the 220ms slide, on a phone, while
          // a transform is composited — and the panel it rides has always
          // moved this way, so the two now animate alike by construction.
          // (`left` painted correctly too; a detour spent measuring
          // getBoundingClientRect in headless WebKit was chasing a stale
          // rect in the harness, not a defect in either version.)
          //
          // The vertical half is folded in here too, because an inline
          // transform would otherwise overwrite Tailwind's -translate-y-1/2:
          // centred means top:50% with -50%, placed means top:<y> with 0.
          top: gripY ?? '50%',
          transform: `translate(${panelX + PANEL_W}px, ${gripY === null ? '-50%' : '0px'})`,
          width: GRIP_HIT_W,
          height: GRIP_H,
          transition: dragFrom.current
            ? 'none'
            : 'transform 220ms cubic-bezier(.22,.61,.36,1)',
        }}
      >
        {/* Only this is drawn. The rest of the button is transparent reach,
            extending RIGHT, over the page — never over the menu. */}
        <span
          data-testid="edge-handle-tab"
          className="flex h-full items-center justify-center rounded-r-lg bg-surface-elevated/60 border border-l-0 border-border-subtle backdrop-blur"
          style={{ width: GRIP_TAB_W }}
        >
          <GripVertical
            size={12}
            className={moreActive ? 'text-accent' : 'text-content-tertiary'}
          />
        </span>
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
          </div>
        </div>
      )}
    </>
  )
}
