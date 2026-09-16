import { useState, useEffect, type ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'
import clsx from 'clsx'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { MobileNavProvider } from '../../hooks/useMobileNav'
import { UnseenNoticesProvider } from '../../hooks/useUnseenNotices'
import { useIsMobile } from '../../hooks/useIsMobile'

const STORAGE_KEY = 'nova-sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function AppLayout({
  children,
  fullWidth = false,
}: {
  children: ReactNode
  fullWidth?: boolean
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const isMobile = useIsMobile()

  // Ctrl+B / Cmd+B, the shortcut the edge handle's tooltip promises. Closing
  // the sidebar to NOTHING (2026-09-16) makes a keyboard route matter more
  // than it did: with no icon rail left behind, the pointer route is a 2px
  // line the owner has to go and find.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'b' && e.key !== 'B') return
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      setCollapsed(c => !c)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed))
    } catch {
      // Ignore storage errors
    }
  }, [collapsed])

  return (
    // S11: one poll of the server's unseen-notice count for the whole shell —
    // both nav surfaces read it, and the Inbox page pushes a fresh read
    // through it the moment it marks something seen.
    <MobileNavProvider>
      <UnseenNoticesProvider>
        {/* `fixed inset-0`, not a height. The shell is anchored to the
            layout viewport's four edges, so it is exactly as tall as the
            viewport BY CONSTRUCTION — there is no number to be wrong. Both
            earlier attempts computed one: `h-dvh` trusted what the browser
            reports, and on this owner's installed iOS app that came out
            short, leaving a bare strip at the bottom; sizing from a measured
            `innerHeight` then overshot iOS's layout viewport and let the
            document scroll, taking the top off the screen. Neither can
            happen to an element pinned to the edges. */}
        <div className="fixed inset-0 flex bg-surface-root dark:bg-transparent">
          <Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />
          {/* THE WAY BACK. Collapsed means gone since 2026-09-16, so unlike
              an icon rail the sidebar leaves nothing behind to click — and
              this has to live in the SHELL rather than in a page's header,
              or hiding it on Settings would strand the operator there.
              Only while collapsed: an always-present button beside a
              sidebar that is already open is a second control for a state
              you can see. */}
          {!isMobile && collapsed && (
            <button
              type="button"
              data-testid="show-sidebar"
              onClick={() => setCollapsed(false)}
              className="absolute top-3 left-3 z-40 inline-flex items-center gap-1.5 rounded-md p-1.5 text-content-tertiary hover:text-content-primary hover:bg-surface-card transition-colors duration-fast"
            >
              <PanelLeft size={16} className="shrink-0" />
              <span className="sr-only">Show sidebar (Ctrl+B)</span>
            </button>
          )}
          {/* The top safe-area inset, once, for every page. index.html sets
              `viewport-fit=cover`, so the layout viewport extends under the
              status bar and a heading at y=0 sits behind the clock — which is
              exactly what the owner saw. Only the two BOTTOM insets were
              handled before this. `md:pt-0` because a desktop has no inset
              and the value resolves to 0 there anyway; stating it keeps the
              intent legible. */}
          <main
            className={clsx(
              'flex-1 min-h-0 pt-[var(--nova-safe-top,0px)] md:pt-0',
              fullWidth ? 'overflow-hidden' : 'overflow-y-auto custom-scrollbar',
              // ROOM FOR THE SHOW-SIDEBAR BUTTON. It floats in the shell so
              // it works on every page, and without this it floats ON TOP of
              // whatever each page puts at its top-left — the chat header's
              // title, in the first screenshot after this shipped. Reserved
              // rather than moved into each header, because "every page"
              // includes the ones nobody has written yet.
              !isMobile && collapsed && 'md:pl-11',
            )}
          >
            {fullWidth ? (
              children
            ) : (
              <div className="mx-auto max-w-[1200px] w-full px-6 py-8 animate-fade-in">
                {children}
              </div>
            )}
          </main>
          {/* isMobile is TRUE below 768px. This read `!isMobile` from the
              2026-08-27 design-system port until 2026-09-15, which rendered
              the bottom nav only on desktop — where its own `md:hidden`
              class then hid it. So it appeared nowhere, for three weeks, and
              the phone had no navigation at all: no tabs, no "More" drawer,
              no way to reach Settings. The owner reported it as "it's chat
              only". AppLayout.test.tsx pins both directions. */}
          {isMobile && <MobileNav />}
        </div>
      </UnseenNoticesProvider>
    </MobileNavProvider>
  )
}
