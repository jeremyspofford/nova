import {
  BookOpen,
  Bot,
  Boxes,
  Gauge,
  MonitorSmartphone,
  Palette,
  Plug,
  Route,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { Role } from '../../lib/roles'
import { SETTINGS_TABS, resolveTab } from './tabs'

/**
 * Everything Settings lists, and the order it comes in (2026-10-08).
 *
 * The sidebar used to carry Governance, AI Quality, Agents, Skills and Models
 * beside Chat, Schedules, Inbox and Files. The owner asked for them to go
 * somewhere else: the sidebar is for the work — the conversation, what is
 * due, what she noticed, the files — the way Claude's keeps its chats and
 * Routines up top and everything you configure under Settings. So they live
 * here now, beside the tabs Settings already had, and the sidebar is down to
 * four entries.
 *
 * The moved pages keep their own addresses (/agents, /skills, /models,
 * /quality, /governance). The Inbox links to /skills?from_notice= and
 * /agents/<name>, chat links to /agents/<name>, and bookmarks exist; moving
 * the URLs would break all of that for no gain a person can see. They render
 * inside the Settings shell instead (App.tsx), so they read as part of it.
 *
 * Grouped by the question being asked, as tabs.ts is:
 *   You     — how it looks for you, and your time and sign-in
 *   Nova    — who else runs, what she knows how to do, how she behaves,
 *             what she can reach
 *   Models  — which model answers, every model she can run, how well each does
 *   System  — the machines in it, and the record of what happened to them
 */

export type SettingsNavItem = {
  to: string
  label: string
  icon: LucideIcon
  /** The moved pages were admin-only in the sidebar and stay so here; a nav
   *  entry must not offer a page whose API refuses the viewer. */
  minRole: Role
}

export type SettingsNavGroup = {
  label: string
  items: SettingsNavItem[]
}

/** A tab SettingsPage draws, its label READ from SETTINGS_TABS so the nav and
 *  the tab's own header cannot name it two ways. Throws on an unknown slug:
 *  a nav entry for a tab that does not exist would land on General while
 *  claiming to be somewhere else. */
function tab(slug: string, icon: LucideIcon): SettingsNavItem {
  const t = SETTINGS_TABS.find(x => x.slug === slug)
  if (!t) throw new Error(`settingsNav: no settings tab "${slug}"`)
  return { to: `/settings/${t.slug}`, label: t.label, icon, minRole: 'guest' }
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'You',
    items: [tab('general', SlidersHorizontal), tab('appearance', Palette)],
  },
  {
    label: 'Nova',
    items: [
      // Agents then Skills, as they sat in the sidebar: the two answers to
      // "what does this household know how to do" — one a who, one a how.
      { to: '/agents', label: 'Agents', icon: Bot, minRole: 'admin' },
      { to: '/skills', label: 'Skills', icon: BookOpen, minRole: 'admin' },
      tab('behaviour', Sparkles),
      tab('connections', Plug),
    ],
  },
  {
    label: 'Models',
    items: [
      tab('models', Route),
      { to: '/models', label: 'Catalog', icon: Boxes, minRole: 'admin' },
      // Beside the catalog it scores: the catalog's benchmark column links
      // here for the runs behind each number.
      { to: '/quality', label: 'AI Quality', icon: Gauge, minRole: 'admin' },
    ],
  },
  {
    label: 'System',
    items: [
      tab('devices', MonitorSmartphone),
      // Governance is the devices' audit trail — every pairing, revoke and
      // chain break — so it sits under Devices rather than on its own.
      { to: '/governance', label: 'Governance', icon: ScrollText, minRole: 'admin' },
    ],
  },
]

export const SETTINGS_INDEX = '/settings'

/**
 * Where a path sits in Settings.
 *
 * - `entry`: the nav entry it belongs to, or null for a path Settings does
 *   not list. Every /settings/* path belongs to the tab SettingsPage will
 *   actually draw for it — resolveTab sends a bare or unknown slug to
 *   General, so the nav marks General too rather than marking nothing over a
 *   page that is plainly showing.
 * - `index`: the bare /settings. On a wide screen that IS General; on a narrow
 *   one it is the list of everything, which you then drill into.
 * - `top`: the path is the entry's own page rather than one beneath it
 *   (/agents, not /agents/<name>). A page beneath carries its own way back
 *   to its list; the shell only adds a way back to Settings on top pages.
 */
export function settingsLocation(pathname: string): {
  entry: SettingsNavItem | null
  index: boolean
  top: boolean
} {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const items = SETTINGS_NAV.flatMap(g => g.items)
  if (path === SETTINGS_INDEX || path.startsWith(`${SETTINGS_INDEX}/`)) {
    const slug = resolveTab(path.slice(SETTINGS_INDEX.length + 1) || undefined)
    const entry = items.find(i => i.to === `${SETTINGS_INDEX}/${slug}`) ?? null
    return { entry, index: path === SETTINGS_INDEX, top: true }
  }
  const entry = items.find(i => path === i.to || path.startsWith(`${i.to}/`)) ?? null
  return { entry, index: false, top: entry !== null && path === entry.to }
}
