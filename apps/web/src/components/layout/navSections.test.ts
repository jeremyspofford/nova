import { describe, it, expect } from 'vitest'
import { navSections } from './Sidebar'
import { SETTINGS_NAV } from '../../pages/settings/settingsNav'

// The sidebar's entries, and where everything that left it lives. The mobile
// drawer renders this same config whole (MobileNav.tsx), and
// AppLayout.test.tsx pins on the rendered drawer that every entry is in it —
// so a pin here covers both surfaces.
//
// This file was MobileNav.test.ts, pinning that the drawer's "primary tabs"
// and "More" lists were derived from the sidebar's. The split went on
// 2026-10-08 with the sidebar's System group; what is pinned now is the list
// itself, and the absences.
describe('the sidebar (navSections)', () => {
  // 2026-10-08, the owner's call: the sidebar is for the work. Pinned whole
  // and in order — this list is a decision, and a fifth entry or a reshuffle
  // should be one too, made here on purpose.
  it('is Chat → Schedules → Inbox → Files, and nothing else', () => {
    expect(navSections.flatMap(s => s.items.map(i => i.to))).toEqual([
      '/chat',
      '/schedules',
      '/inbox',
      '/files',
    ])
    expect(navSections.flatMap(s => s.items.map(i => i.label))).toEqual(['Chat', 'Schedules', 'Inbox', 'Files'])
  })

  // Pinned as ABSENCES, because putting one back would quietly give it two
  // homes: Activity, Spend and Settings live under his name in the
  // AccountMenu (2026-09-16); Governance, AI Quality, Agents, Skills and the
  // model catalog live in Settings' own nav (2026-10-08).
  it('lists none of what lives under his name or in Settings', () => {
    const routes = navSections.flatMap(s => s.items.map(i => i.to))
    for (const his of ['/activity', '/spend', '/settings']) {
      expect(routes, `${his} lives in the AccountMenu`).not.toContain(his)
    }
    for (const moved of ['/governance', '/quality', '/agents', '/skills', '/models']) {
      expect(routes, `${moved} lives in Settings`).not.toContain(moved)
    }
    // And generally: nothing Settings lists is also here.
    for (const item of SETTINGS_NAV.flatMap(g => g.items)) {
      expect(routes, `${item.to} is in both the sidebar and Settings`).not.toContain(item.to)
    }
  })

  it('offers Chat to everyone and the rest to admins', () => {
    const items = navSections.flatMap(s => s.items)
    expect(items.find(i => i.to === '/chat')?.minRole).toBe('guest')
    for (const to of ['/schedules', '/inbox', '/files']) {
      expect(items.find(i => i.to === to)?.minRole, to).toBe('admin')
    }
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

