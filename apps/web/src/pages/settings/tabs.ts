/**
 * How Settings is divided, and the order the divisions come in.
 *
 * One page of nine sections meant scrolling past six of them to reach the
 * seventh, and it grew that way one section at a time — nobody chose it.
 * The grouping is by the question being asked, not by which service answers
 * it: "how does it look" and "which model answers" are different errands
 * even though both are rows in the same settings table.
 *
 * The slug is a URL segment (`/settings/models`), so these names are part of
 * the product's surface — renaming one breaks a link somebody saved.
 *
 * These are the tabs SettingsPage draws itself. Settings' nav also lists
 * pages that live at their own addresses (Agents, Skills, the model catalog,
 * AI Quality, Governance); that list, and the order everything comes in, is
 * settingsNav.ts.
 */
export type SettingsTab = {
  slug: string
  label: string
  /** Shown under the tab strip, so a tab is not just a word. */
  blurb: string
}

export const SETTINGS_TABS: SettingsTab[] = [
  {
    slug: 'general',
    label: 'General',
    blurb: 'Time, and who is signed in.',
  },
  {
    slug: 'appearance',
    label: 'Appearance',
    blurb: 'Theme, typeface, and what this device reports about its own screen.',
  },
  {
    // Labelled Routing since 2026-10-08, when the model catalog moved into
    // Settings beside it: two entries called "Models" in one nav would be a
    // coin toss. The slug stays — /settings/models is linked from chat's
    // model switcher and from saved bookmarks — and core's own messages
    // already send people to "Settings → Routing".
    slug: 'models',
    label: 'Routing',
    blurb: 'Which model answers, and who provides it.',
  },
  {
    slug: 'behaviour',
    label: 'Behaviour',
    blurb: 'What she does on her own, and how her answers are checked.',
  },
  {
    slug: 'devices',
    label: 'Devices',
    blurb: 'Add machines and phones to Nova, the machines paired to it, and where its models run.',
  },
  {
    slug: 'connections',
    label: 'Connections',
    blurb: 'Services she can use through MCP, like GitHub.',
  },
]

export const DEFAULT_TAB = SETTINGS_TABS[0].slug

/**
 * The tab a URL segment means.
 *
 * Anything unrecognised — a renamed slug in an old bookmark, a typo, a hand
 * edited address — resolves to the first tab rather than rendering an empty
 * page. A settings page that shows nothing looks exactly like a settings
 * page that failed to load.
 */
export function resolveTab(raw: string | undefined): string {
  if (!raw) return DEFAULT_TAB
  return SETTINGS_TABS.some(t => t.slug === raw) ? raw : DEFAULT_TAB
}
