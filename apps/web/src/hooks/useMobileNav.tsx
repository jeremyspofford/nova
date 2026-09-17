import { createContext, useContext, useState, type ReactNode } from 'react'

interface MobileNavContext {
  hidden: boolean
  setHidden: (hidden: boolean) => void
}

const MobileNavCtx = createContext<MobileNavContext>({ hidden: false, setHidden: () => {} })

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false)
  return (
    <MobileNavCtx.Provider value={{ hidden, setHidden }}>
      {children}
    </MobileNavCtx.Provider>
  )
}

export function useMobileNav() {
  return useContext(MobileNavCtx)
}
