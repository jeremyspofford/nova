import { useSyncExternalStore } from 'react'

const MQ = '(min-width: 768px)'

function subscribe(cb: () => void) {
  const mql = window.matchMedia(MQ)
  mql.addEventListener('change', cb)
  return () => mql.removeEventListener('change', cb)
}

function getSnapshot() {
  return !window.matchMedia(MQ).matches
}

function getServerSnapshot() {
  return false // SSR fallback: assume desktop
}

/** Returns true when viewport is below Tailwind's `md` breakpoint (768px). */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
