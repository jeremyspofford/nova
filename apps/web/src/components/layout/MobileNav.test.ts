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
    // S12 (2026-09-08): the Agents page joined the System group, between
    // Schedules and Files — pinned here in the same breath as /schedules so
    // a mobile drawer that drops it is caught the way Governance's absence
    // once was not.
    expect(everyMobileRoute).toContain('/agents')
    // S11 (2026-09-08): and the Inbox, for the same reason — it is where her
    // proactive notices land, so a phone that cannot reach it cannot read
    // what she did overnight.
    expect(everyMobileRoute).toContain('/inbox')
  })

  // Pin moved 2026-09-08 (S11): the chain was Schedules → Agents → Files.
  // The Inbox took the place directly after Agents — the beats are the last
  // thing that acts on its own and this is the record of those actions — so
  // Files now follows Inbox. The property being pinned has not changed: the
  // System group's order is deliberate and a drawer that reorders or drops an
  // entry is caught here.
  it('Schedules → Agents → Inbox → Files hold their order in the System group', () => {
    const system = navSections.find(s => s.label === 'System')
    expect(system).toBeDefined()
    const routes = system!.items.map(i => i.to)
    expect(routes.indexOf('/agents')).toBe(routes.indexOf('/schedules') + 1)
    expect(routes.indexOf('/inbox')).toBe(routes.indexOf('/agents') + 1)
    expect(routes.indexOf('/files')).toBe(routes.indexOf('/inbox') + 1)
    expect(system!.items.find(i => i.to === '/agents')?.minRole).toBe('admin')
    expect(system!.items.find(i => i.to === '/inbox')?.minRole).toBe('admin')
  })

  // The count on the nav badge is the SERVER's (notices.unseen_count). This
  // pins that the config carries a key and never a number: a number here
  // would be a client's guess at what is waiting.
  it('only the Inbox entry declares a badge, and it declares a key rather than a count', () => {
    const badged = navSections.flatMap(s => s.items).filter(i => i.badge !== undefined)
    expect(badged.map(i => i.to)).toEqual(['/inbox'])
    expect(badged[0].badge).toBe('unseen_notices')
  })
})
