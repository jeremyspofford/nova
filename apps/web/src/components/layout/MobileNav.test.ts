import { describe, it, expect } from 'vitest'
import { navSections } from './Sidebar'
import { moreItems, primaryTabs } from './MobileNav'

// The mobile drawer and the sidebar are two surfaces over ONE nav config.
// They had drifted once (Governance missing from mobile); this pins that
// every Sidebar entry is reachable on mobile, in the same order.
describe('MobileNav derives its lists from Sidebar.navSections', () => {
  it('every labelled Sidebar section is in "More", same items, same order', () => {
    const sidebarSystem = navSections.filter(s => s.label !== undefined)
    expect(moreItems.map(s => s.label)).toEqual(sidebarSystem.map(s => s.label))
    expect(moreItems.map(s => s.items.map(i => i.to))).toEqual(
      sidebarSystem.map(s => s.items.map(i => i.to)),
    )
  })

  it('the unlabelled (Core) items are the primary tabs, and nothing is dropped between the two', () => {
    const everySidebarRoute = navSections.flatMap(s => s.items.map(i => i.to))
    const everyMobileRoute = [...primaryTabs, ...moreItems.flatMap(s => s.items)].map(i => i.to)
    expect(everyMobileRoute).toEqual(everySidebarRoute)
    expect(primaryTabs.map(i => i.to)).toContain('/chat')
    expect(everyMobileRoute).toContain('/schedules')
  })
})
