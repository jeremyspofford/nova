import { useState, useEffect, type ReactNode } from 'react'
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
        <div className="flex h-dvh bg-surface-root dark:bg-transparent">
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />
          <main className={`flex-1 min-h-0 ${fullWidth ? 'overflow-hidden' : 'overflow-y-auto custom-scrollbar'}`}>
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
