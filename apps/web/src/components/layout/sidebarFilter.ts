export type SurfacePreset = 'chat_only' | 'standard' | 'advanced'

export type NavItemForFilter = {
  presetVisibility?: SurfacePreset[]
  // Keep this loose so both Sidebar's NavItem and MobileNav's NavItem
  // can pass through without re-typing. The tests use a `key` for
  // identification but the production caller doesn't need it.
  [k: string]: unknown
}

/**
 * Filter nav items by the currently-active surface preset. Items without
 * a `presetVisibility` field are always shown (back-compat with existing
 * nav config). Items with the field are shown only when the active
 * preset is included.
 */
export function filterNavItemsByPreset<T extends NavItemForFilter>(
  items: T[],
  preset: SurfacePreset,
): T[] {
  return items.filter(item =>
    !item.presetVisibility || item.presetVisibility.includes(preset),
  )
}
