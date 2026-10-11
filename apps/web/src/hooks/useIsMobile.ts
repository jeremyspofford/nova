import { useSyncExternalStore } from 'react'

const MQ = '(min-width: 768px)'
/** Where a page can afford a nav column of its own beside the sidebar. */
export const WIDE_QUERY = '(min-width: 1280px)'

/** One media query as an external store. Built once per query at module
 *  level: useSyncExternalStore resubscribes whenever `subscribe` changes
 *  identity, so an inline arrow would re-register the listener every render. */
function mediaStore(query: string) {
  return {
    subscribe(cb: () => void) {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    matches: () => window.matchMedia(query).matches,
  }
}

const md = mediaStore(MQ)
/** Where the shell can afford its 240px sidebar (Tailwind `lg`). */
export const SIDEBAR_QUERY = '(min-width: 1024px)'
const lg = mediaStore(SIDEBAR_QUERY)
const wide = mediaStore(WIDE_QUERY)

/** Returns true when viewport is below Tailwind's `md` breakpoint (768px). */
export function useIsMobile() {
  // SSR fallback: assume desktop.
  return !useSyncExternalStore(md.subscribe, md.matches, () => true)
}

/** True at Tailwind's `xl` breakpoint (1280px) and up: room for a second
 *  column of navigation beside the sidebar. Two nav columns cost 240 + 192px
 *  plus gutters; at 1024 that left a page 512px, less than a tablet's 530
 *  that UI review R3 already called too narrow — so below this, a page that
 *  adds its own nav column stacks instead. */
export function useIsWide() {
  return useSyncExternalStore(wide.subscribe, wide.matches, () => true)
}

/** True below 1024px: the shell draws the phone's menu button, drawer and
 *  top bar instead of the sidebar (2026-10-11, UI review R3). A tablet at
 *  820px with the sidebar open left pages ~530px, narrower than the md:
 *  layouts inside them assumed. Distinct from useIsMobile, which still
 *  means "a phone" to pages that lay themselves out by it. */
export function useIsCompactShell() {
  return !useSyncExternalStore(lg.subscribe, lg.matches, () => true)
}

