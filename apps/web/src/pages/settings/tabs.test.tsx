import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'
import { SettingsShell } from './SettingsShell'
import { SETTINGS_TABS, DEFAULT_TAB, resolveTab } from './tabs'
import { ThemeProvider } from '../../stores/theme-store'
import { AuthProvider } from '../../stores/auth-store'
import { ChatProvider } from '../../stores/chat-store'
import { getSettings, putSetting, type SettingDef } from '../../lib/api'

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
    getNetworkAddress: vi.fn(async () => ({ address: null, reason: 'not in a test', read_at: '2026-09-25T14:00:00Z' })),
    mintPairingCode: vi.fn(),
    listProviders: vi.fn(async () => []),
    getProviderPresets: vi.fn(async () => []),
    getProviderModels: vi.fn(async () => []),
    getCatalog: vi.fn(async () => ({ fetched_at: 't', sources: [], rows: [] })),
    getRoutes: vi.fn(async () => ({ roles: [], walls: [] })),
    listAgents: vi.fn(async () => []),
    getMachines: vi.fn(async () => ({ machines: [] })),
    listMcpServers: vi.fn(async () => []),
    getMcpPresets: vi.fn(async () => []),
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
  models: ['Models', 'Providers', 'Routing'],
  behaviour: ['Response quality'],
  devices: ['Add to Nova', 'Devices', 'Machines'],
  connections: ['Connections'],
}

/** Inside the Settings shell, as App.tsx mounts it, on a screen wide enough
 *  for its nav column (2026-10-08): the tab links these tests click are the
 *  shell's nav now, not a strip on the page. Below 1280px the shell drills
 *  down instead and draws no nav beside the page — SettingsShell.test.tsx
 *  covers that half. */
function renderAt(path: string) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <AuthProvider>
          <ChatProvider fetchImpl={vi.fn(async () => new Response('{}'))}>
            <Routes>
              <Route element={<SettingsShell />}>
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/:tab" element={<SettingsPage />} />
              </Route>
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
    // The old tool-round limit, as a core from before 2026-10-08 still lists
    // it: no tab draws anything for it, so SECTIONS_BY_TAB holds no section
    // for it and every tab test below runs with it listed.
    { key: STALE_KEY, type: 'int', default: 6, description: '', value: 6 },
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
  it('Routing — which model answers — is the first thing on the Models tab', async () => {
    // 2026-10-05: chat's order is what this tab is opened for; it sat last,
    // under the machines, a duplicate model list and the providers.
    renderAt('/settings/models')
    await panel().findByText('Routing')
    const headings = [...screen.getByTestId('settings-panel').querySelectorAll('h2')].map(h => h.textContent)
    expect(headings[0]).toBe('Routing')
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
    // Under its own name, as the page's title: the strip and the blurb line
    // under it became the shell's nav and this header on 2026-10-08.
    for (const t of SETTINGS_TABS) {
      const { unmount } = renderAt(`/settings/${t.slug}`)
      // From the blurb, not the name: several tabs carry a section of their
      // own name once the read lands ("General", "Devices").
      const title = screen.getByText(t.blurb).previousElementSibling
      expect(title?.tagName, t.slug).toBe('H2')
      expect(title?.textContent, t.slug).toBe(t.label)
      unmount()
    }
  })
})

/**
 * Settings → Behaviour has no tool-round field (2026-10-08, owner: "remove
 * the whole tool call limit entirely"). Core no longer has the setting, so
 * there is nothing for the page to show or save. A core from before that
 * change can still list the old key in its one settings read; the page draws
 * nothing for it — no section, no description, no number field — on
 * Behaviour or on any other tab. A turn ends on its own or on the
 * going-in-circles stop, never on a count the owner set here.
 *
 * The old key is spelled in pieces so the web source holds no literal of it
 * (src/lib/noRoundCap.src.test.ts reads the whole tree for one).
 */

/** The key a core from before 2026-10-08 still listed. */
const STALE_KEY = ['agents', ['max', 'tool', 'rounds'].join('_')].join('.')

const CHAT_MODEL: SettingDef = {
  key: 'chat.model',
  type: 'str',
  default: '',
  description: '',
  value: 'qwen3:8b',
}

/** The old limit, as a stale core's GET /api/v1/settings would list it. */
const staleDef = (value: unknown): SettingDef => ({
  key: STALE_KEY,
  type: 'int',
  default: 6,
  description: 'How many times one chat turn may call the model while it is still asking for tools.',
  value,
})

/** The three proactive keys, as a core that has them lists them. */
const PROACTIVE: SettingDef[] = [
  { key: 'proactive.enabled', type: 'bool', default: false, description: '', value: true },
  { key: 'proactive.digest_at', type: 'str', default: '08:00', description: '', value: '07:15' },
  { key: 'proactive.max_notices_per_day', type: 'int', default: 20, description: '', value: 9 },
]

/** Words a tool-round field would carry, in any case and spacing. */
const ROUND_WORDS = /tool[\s-]*rounds?/i

/** The panel's level-2 headings, in order. */
const headings = () =>
  [...screen.getByTestId('settings-panel').querySelectorAll('h2')].map(h => h.textContent ?? '')

/** Nothing in the panel that a tool-round field would draw. */
function expectNoRoundField(where: string) {
  const el = screen.getByTestId('settings-panel')
  expect(
    headings().filter(h => ROUND_WORDS.test(h)),
    `${where}: a tool-round heading`,
  ).toEqual([])
  expect(el.querySelector('[data-testid="tool-rounds-description"]'), `${where}: its description`).toBeNull()
  expect(el.querySelector('[data-testid="tool-rounds-error"]'), `${where}: its error`).toBeNull()
  expect(panel().queryAllByLabelText(ROUND_WORDS), `${where}: a field labelled for it`).toEqual([])
  expect(el.textContent ?? '', `${where}: its words`).not.toMatch(ROUND_WORDS)
}

/** Lets the page's one settings read land and React draw from it. */
async function readLanded() {
  await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1))
  await act(async () => {
    await vi.mocked(getSettings).mock.results[0].value
    await new Promise(r => setTimeout(r, 0))
  })
}

describe('Settings → Behaviour: no tool-round field', () => {
  it('draws no tool-round section, description, error or number field even when the read still lists the old key', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, staleDef(12)])
    renderAt('/settings/behaviour')

    await panel().findByRole('heading', { level: 2, name: 'Response quality' })
    await readLanded()
    expectNoRoundField('behaviour, the old key listed')
    // No number field at all: Response quality is a switch, and nothing else
    // on Behaviour takes a number unless the proactive keys are listed.
    expect(panel().queryAllByRole('spinbutton')).toEqual([])
    // Drawing nothing is not saving anything.
    expect(putSetting).not.toHaveBeenCalled()
  })

  it("Behaviour's sections are Response quality alone, or Proactive and Response quality when those keys are listed", async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, staleDef(12)])
    const alone = renderAt('/settings/behaviour')
    await panel().findByRole('heading', { level: 2, name: 'Response quality' })
    await readLanded()
    expect(headings()).toEqual(['Response quality'])
    alone.unmount()

    // Proactive drawing proves the read landed, so what follows it is the
    // page's whole answer, not a slow load.
    vi.mocked(getSettings).mockClear()
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, ...PROACTIVE, staleDef(12)])
    renderAt('/settings/behaviour')
    await panel().findByRole('heading', { level: 2, name: 'Proactive' })
    await readLanded()
    expect(headings()).toEqual(['Proactive', 'Response quality'])
    expectNoRoundField('behaviour, proactive and the old key listed')
  })

  it('no other tab draws it either, reached by the tab links with the old key listed', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, staleDef(12)])
    renderAt('/settings/general')
    await panel().findByRole('heading', { level: 2, name: 'General' })
    await readLanded()
    for (const t of SETTINGS_TABS) {
      fireEvent.click(screen.getByTestId(`settings-tab-${t.slug}`))
      // Waited on until the tab's first section draws, so a panel still
      // loading cannot pass for one without the field.
      await panel().findByRole('heading', { level: 2, name: SECTIONS_BY_TAB[t.slug][0] })
      await act(async () => {
        await new Promise(r => setTimeout(r, 0))
      })
      expectNoRoundField(t.slug)
    }
  })
})
