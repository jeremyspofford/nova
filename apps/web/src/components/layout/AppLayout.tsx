import { useState, useEffect, type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { MobileNavProvider } from '../../hooks/useMobileNav'
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
    <MobileNavProvider>
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
        {!isMobile && <MobileNav />}
      </div>
    </MobileNavProvider>
  )
}
