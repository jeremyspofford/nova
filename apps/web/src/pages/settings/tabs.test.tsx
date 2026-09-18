import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'
import { SETTINGS_TABS, DEFAULT_TAB, resolveTab } from './tabs'
import { ThemeProvider } from '../../stores/theme-store'
import { AuthProvider } from '../../stores/auth-store'
import { ChatProvider } from '../../stores/chat-store'
import { getSettings } from '../../lib/api'

// Each section fetches its own data. This file is about ROUTING — which
// section appears under which tab — so every read is stubbed to its empty
// shape. Left unstubbed they reach the real client, get the auth stub's
// person object back, and do `.find()` on undefined; React then unmounts the
// tree and the tab looks empty for a reason that has nothing to do with
// tabs. (That is exactly what it did on the first run of this file.)
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getSettings: vi.fn(),
    putSetting: vi.fn(async () => {}),
    getBackend: vi.fn(async () => ({ kind: 'ollama', url: null, provider: null })),
    getInstalledModels: vi.fn(async () => []),
    getSuggestion: vi.fn(async () => null),
    listDevices: vi.fn(async () => []),
    listProviders: vi.fn(async () => []),
    getProviderPresets: vi.fn(async () => []),
    getProviderModels: vi.fn(async () => []),
    getCatalog: vi.fn(async () => []),
    getRoutes: vi.fn(async () => ({ roles: [], walls: [] })),
    listAgents: vi.fn(async () => []),
    getMachines: vi.fn(async () => ({ machines: [] })),
  }
})

/**
 * Settings became tabbed on 2026-09-15: nine sections on one page meant
 * scrolling past six to reach the seventh.
 *
 * The risk that arrives WITH the tabs is that a section can now belong to no
 * tab at all. On one long page that was impossible — everything imported was
 * rendered. Now a section can be imported, pass its own suite, and be
 * unreachable, which looks exactly like a section that was deleted. The
 * coverage test below is the whole reason this file exists.
 */

const SECTIONS_BY_TAB: Record<string, string[]> = {
  general: ['General', 'Account'],
  appearance: ['Appearance', 'Display diagnostics'],
  models: ['Machines', 'Models', 'Providers', 'Routing'],
  behaviour: ['Response quality'],
  devices: ['Devices'],
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <AuthProvider>
          <ChatProvider fetchImpl={vi.fn(async () => new Response('{}'))}>
            <Routes>
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/:tab" element={<SettingsPage />} />
            </Routes>
          </ChatProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  )
}

/** The panel, NOT the whole page: several tab labels are also section
 *  headings ("General", "Models", "Devices"), so an unscoped getByText finds
 *  the tab link and proves nothing about what rendered below it. */
const panel = () => within(screen.getByTestId('settings-panel'))

beforeEach(() => {
  localStorage.clear()
  // A signed-in owner, so AccountSection has somebody to render.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/auth/state')
        ? { has_users: true }
        : { person: { id: 'p1', name: 'Ada', role: 'owner' } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response
    }),
  )
  vi.mocked(getSettings).mockResolvedValue([
    { key: 'chat.model', type: 'str', default: '', description: '', value: 'qwen3:8b' },
  ])
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('resolveTab', () => {
  it('sends a bare /settings to the first tab', () => {
    expect(resolveTab(undefined)).toBe(DEFAULT_TAB)
  })

  it('sends anything unrecognised to the first tab rather than nowhere', () => {
    // A bookmark from before a rename, a typo, a hand-edited address. An
    // empty settings page and a settings page that failed to load look
    // identical, so there is no such thing as "no tab".
    expect(resolveTab('appearence')).toBe(DEFAULT_TAB)
    expect(resolveTab('')).toBe(DEFAULT_TAB)
    expect(resolveTab('constructor')).toBe(DEFAULT_TAB)
  })

  it('keeps a slug it knows', () => {
    for (const t of SETTINGS_TABS) expect(resolveTab(t.slug)).toBe(t.slug)
  })
})

describe('the settings tabs', () => {
  it('Machines is the first thing on the Models tab', async () => {
    renderAt('/settings/models')
    await panel().findByText('Machines')
    const headings = [...screen.getByTestId('settings-panel').querySelectorAll('h2')].map(h => h.textContent)
    expect(headings[0]).toBe('Machines')
  })

  it('every tab in the strip is one the page can resolve', () => {
    // A tab that links to a slug the page does not know would silently show
    // the first tab while looking selected somewhere else.
    for (const t of SETTINGS_TABS) expect(resolveTab(t.slug)).toBe(t.slug)
  })

  it('renders a link per tab, with the current one marked', async () => {
    renderAt('/settings/models')
    for (const t of SETTINGS_TABS) {
      expect(screen.getByTestId(`settings-tab-${t.slug}`), t.slug).toBeTruthy()
    }
    expect(screen.getByTestId('settings-tab-models').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('settings-tab-general').getAttribute('aria-current')).toBeNull()
  })

  it('a bare /settings lands on the first tab', async () => {
    renderAt('/settings')
    expect(screen.getByTestId(`settings-tab-${DEFAULT_TAB}`).getAttribute('aria-current')).toBe('page')
  })

  it('an unknown tab shows the first one rather than an empty page', async () => {
    renderAt('/settings/not-a-tab')
    expect(screen.getByTestId(`settings-tab-${DEFAULT_TAB}`).getAttribute('aria-current')).toBe('page')
    // And it genuinely renders that tab's content.
    await panel().findByText('General')
  })

  it.each(SETTINGS_TABS.map(t => [t.slug] as const))(
    'the %s tab carries its sections and none of the others',
    async slug => {
      renderAt(`/settings/${slug}`)
      // By HEADING, not by text: a section's title can also be a word in
      // another section's prose — ModelsSection links "Models" once its data
      // loads — and a text match then finds two and throws, depending only on
      // how long the sections before it took to load. (It started throwing
      // when Machines went first on the Models tab, 2026-09-18.)
      for (const heading of SECTIONS_BY_TAB[slug]) {
        expect(await panel().findByRole('heading', { level: 2, name: heading }), `${slug} should carry ${heading}`).toBeTruthy()
      }
      // Sections belonging to a DIFFERENT tab must not also be here — the
      // point of tabs is that each one is short.
      const elsewhere = Object.entries(SECTIONS_BY_TAB)
        .filter(([other]) => other !== slug)
        .flatMap(([, headings]) => headings)
        .filter(h => !SECTIONS_BY_TAB[slug].includes(h))
      for (const heading of elsewhere) {
        expect(panel().queryByRole('heading', { level: 2, name: heading }), `${slug} should not carry ${heading}`).toBeNull()
      }
    },
  )

  it('every section still has a tab to live in', async () => {
    // THE REFACTOR GUARD. Nine sections were split across five tabs by hand.
    // This walks every tab and collects what it renders, so a section that
    // was dropped on the way — or one added later under no tab — fails here
    // rather than quietly ceasing to exist.
    const seen = new Set<string>()
    for (const t of SETTINGS_TABS) {
      const { unmount } = renderAt(`/settings/${t.slug}`)
      // waitFor, not a bare read: some sections render only after their own
      // effect resolves (Display diagnostics measures the device first), so
      // a synchronous sweep finds the tab empty and reports the section as
      // homeless.
      await waitFor(() => {
        for (const heading of SECTIONS_BY_TAB[t.slug]) {
          expect(panel().queryAllByText(heading).length, `${t.slug}: ${heading}`).toBeGreaterThan(0)
        }
      })
      for (const heading of Object.values(SECTIONS_BY_TAB).flat()) {
        if (panel().queryAllByText(heading).length > 0) seen.add(heading)
      }
      unmount()
    }
    for (const heading of Object.values(SECTIONS_BY_TAB).flat()) {
      expect(seen.has(heading), `${heading} is reachable from no tab`).toBe(true)
    }
  })

  it('every tab says what it is for, not just its name', async () => {
    for (const t of SETTINGS_TABS) {
      const { unmount } = renderAt(`/settings/${t.slug}`)
      expect(screen.getByTestId('settings-tab-blurb').textContent, t.slug).toBe(t.blurb)
      unmount()
    }
  })
})
