import { describe, it, expect } from 'vitest'
import { SETTINGS_NAV, settingsLocation } from './settingsNav'
import { SETTINGS_TABS } from './tabs'

const items = SETTINGS_NAV.flatMap(g => g.items)

describe('SETTINGS_NAV', () => {
  // THE REACHABILITY GUARD. SettingsPage draws a tab for any slug in
  // SETTINGS_TABS, but the only way to it is this nav: the strip of tab links
  // the page used to carry is gone (2026-10-08). A tab added to tabs.ts and
  // not here would pass its own suite and be unreachable by clicking.
  it('lists every settings tab exactly once, under the label the tab gives itself', () => {
    for (const t of SETTINGS_TABS) {
      const entries = items.filter(i => i.to === `/settings/${t.slug}`)
      expect(entries, t.slug).toHaveLength(1)
      expect(entries[0].label, t.slug).toBe(t.label)
    }
  })

  // The five pages the owner moved out of the sidebar on 2026-10-08. Each has
  // exactly one home now, and this is it.
  it('lists each page that left the sidebar, admin-only as it was there', () => {
    for (const to of ['/agents', '/skills', '/models', '/quality', '/governance']) {
      const entries = items.filter(i => i.to === to)
      expect(entries, to).toHaveLength(1)
      expect(entries[0].minRole, to).toBe('admin')
    }
  })

  it('lists nothing twice, and has no empty group', () => {
    const tos = items.map(i => i.to)
    expect(new Set(tos).size).toBe(tos.length)
    for (const g of SETTINGS_NAV) expect(g.items.length, g.label).toBeGreaterThan(0)
  })

  // Two entries called "Models" in one nav would be a coin toss — which is
  // why the tab became Routing and the page, under a Models heading, Catalog.
  it('names no two entries alike', () => {
    const labels = items.map(i => i.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('settingsLocation', () => {
  it('reads bare /settings as the index, belonging to General', () => {
    expect(settingsLocation('/settings')).toMatchObject({ index: true, top: true, entry: { to: '/settings/general' } })
    expect(settingsLocation('/settings/')).toMatchObject({ index: true, entry: { to: '/settings/general' } })
  })

  it('reads a tab by its slug, and an unknown slug as the General it will draw', () => {
    expect(settingsLocation('/settings/models')).toMatchObject({ index: false, top: true, entry: { label: 'Routing' } })
    // resolveTab sends this to General, so the nav must mark General — not
    // nothing over a page that is plainly showing.
    expect(settingsLocation('/settings/appearence')).toMatchObject({ index: false, top: true, entry: { to: '/settings/general' } })
  })

  it('reads a moved page as its own entry, and a page beneath it as beneath', () => {
    expect(settingsLocation('/models')).toMatchObject({ top: true, entry: { label: 'Catalog' } })
    expect(settingsLocation('/agents')).toMatchObject({ top: true, entry: { to: '/agents' } })
    expect(settingsLocation('/agents/coder')).toMatchObject({ top: false, entry: { to: '/agents' } })
  })

  it('reads a page Settings does not list as none of its entries', () => {
    expect(settingsLocation('/chat').entry).toBeNull()
    // A prefix is not a parent: /modelsx is not beneath /models.
    expect(settingsLocation('/modelsx').entry).toBeNull()
  })
})
