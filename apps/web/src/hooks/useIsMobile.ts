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
