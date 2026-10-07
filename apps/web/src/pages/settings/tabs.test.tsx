import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'
import { SETTINGS_TABS, DEFAULT_TAB, resolveTab } from './tabs'
import { ThemeProvider } from '../../stores/theme-store'
import { AuthProvider } from '../../stores/auth-store'
import { ChatProvider } from '../../stores/chat-store'
import { ApiError, getSettings, putSetting, type SettingDef } from '../../lib/api'

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
  behaviour: ['Response quality', 'Tool rounds'],
  devices: ['Add to Nova', 'Devices', 'Machines'],
  connections: ['Connections'],
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
    // The tool-round limit, unset (so its value is its default): Behaviour
    // draws Tool rounds only when the read lists the key, so it is listed
    // here for SECTIONS_BY_TAB to hold it like every other section.
    { key: 'agents.max_tool_rounds', type: 'int', default: 6, description: '', value: 6 },
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
    for (const t of SETTINGS_TABS) {
      const { unmount } = renderAt(`/settings/${t.slug}`)
      expect(screen.getByTestId('settings-tab-blurb').textContent, t.slug).toBe(t.blurb)
      unmount()
    }
  })
})

/**
 * Settings → Behaviour → Tool rounds: the tool-round limit
 * (`agents.max_tool_rounds`, whose default in core is 6). The page draws
 * ToolRoundsSection from its ONE settings read, on Behaviour only, and only
 * when that read lists the key; a save writes the value CORE stored back into
 * the page's settings state, so the limit a tab shows after a round trip is
 * core's, never what was typed and never what was there before.
 *
 * Here rather than in SettingsPage.test.tsx because renderAt mounts no
 * ChatPage, whose model picker reads GET /api/v1/settings too: every
 * getSettings call counted here is the page's own. Leaving a tab unmounts its
 * sections while the page stays mounted, so coming back seeds the section
 * afresh from the page's settings state: the round trip is how that state is
 * read.
 */

const LIMIT_KEY = 'agents.max_tool_rounds'

/** Core's description of the key (settings_store.py), as GET lists it. */
const CORE_DESCRIPTION =
  'How many times one chat turn may call the model while it is still asking for tools. ' +
  'Reaching the limit ends the turn with a note saying so, never silently.'

/** Core's refusal of 51 (T1's sentence), as lib/api's putSetting rejects with it. */
const CORE_REFUSES_51 =
  'setting agents.max_tool_rounds: the tool-round limit must be between 1 and 50, got 51'

const CHAT_MODEL: SettingDef = {
  key: 'chat.model',
  type: 'str',
  default: '',
  description: '',
  value: 'qwen3:8b',
}

/** The limit as GET /api/v1/settings lists it: an int whose default is 6, holding `value`. */
const limitDef = (value: unknown, description = CORE_DESCRIPTION): SettingDef => ({
  key: LIMIT_KEY,
  type: 'int',
  default: 6,
  description,
  value,
})

/** The three proactive keys, as a core that has them lists them. */
const PROACTIVE: SettingDef[] = [
  { key: 'proactive.enabled', type: 'bool', default: false, description: '', value: true },
  { key: 'proactive.digest_at', type: 'str', default: '08:00', description: '', value: '07:15' },
  { key: 'proactive.max_notices_per_day', type: 'int', default: 20, description: '', value: 9 },
]

const limitHeading = () => panel().queryByRole('heading', { level: 2, name: 'Tool rounds' })
const limitField = () => panel().getByLabelText('Tool-round limit') as HTMLInputElement

/** Waits for the Tool rounds section in the panel, as an assertion, so a page
 *  that never draws it fails here and says which section it lacked. */
async function limitDrawn() {
  await waitFor(() => expect(limitHeading(), 'the Tool rounds section').not.toBeNull())
}

/** No Tool rounds section and no limit field in the panel. */
function expectNoLimit(where: string) {
  expect(limitHeading(), `${where}: a Tool rounds section`).toBeNull()
  expect(panel().queryByLabelText('Tool-round limit'), `${where}: a limit field`).toBeNull()
}

/** Reads of GET /api/v1/settings that went around the mocked getSettings. */
const settingsFetches = () =>
  vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/api/v1/settings'))

/** Core's answer to PUT /api/v1/settings, for this test only: clearAllMocks
 *  keeps implementations, so the file's own empty answer is put back after. */
function coreAnswers(answer: (key: string, value: boolean | string | number) => Promise<unknown>) {
  const before = vi.mocked(putSetting).getMockImplementation()
  onTestFinished(() => {
    if (before) vi.mocked(putSetting).mockImplementation(before)
  })
  vi.mocked(putSetting).mockImplementation(answer as typeof putSetting)
}

/** Leaves Behaviour by the General tab link, then comes back by Behaviour's. */
async function leaveAndComeBack() {
  fireEvent.click(screen.getByTestId('settings-tab-general'))
  await panel().findByRole('heading', { level: 2, name: 'General' })
  expectNoLimit('general')
  fireEvent.click(screen.getByTestId('settings-tab-behaviour'))
  await limitDrawn()
}

describe('Settings → Behaviour: the tool-round limit', () => {
  it('shows the limit as listed, 12 not the default and 99 not clamped, with the listed description, from the one settings read', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, limitDef(12)])
    const first = renderAt('/settings/behaviour')

    await limitDrawn()
    // 12 is stored; the def's default is 6.
    expect(limitField().value).toBe('12')
    expect(panel().getByTestId('tool-rounds-description').textContent).toBe(CORE_DESCRIPTION)
    // From the page's one read: no second read, by getSettings or around it.
    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(settingsFetches()).toEqual([])
    expect(putSetting).not.toHaveBeenCalled()
    first.unmount()

    // A value stored before core bounded the key is shown as stored: 99, not
    // clamped to 50. The words are whatever the listing carries.
    const elsewhere = 'Words only this test wrote, so only the listing can have brought them.'
    vi.mocked(getSettings).mockClear()
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, limitDef(99, elsewhere)])
    renderAt('/settings/behaviour')

    await limitDrawn()
    expect(limitField().value).toBe('99')
    expect(panel().getByTestId('tool-rounds-description').textContent).toBe(elsewhere)
    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(settingsFetches()).toEqual([])
    expect(putSetting).not.toHaveBeenCalled()
  })

  it('lives on Behaviour, reached from General by its tab link, and on no other tab', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, limitDef(12)])
    renderAt('/settings/general')
    await panel().findByRole('heading', { level: 2, name: 'General' })

    // Reached by navigating: the tab strip's Behaviour link, not an address.
    fireEvent.click(screen.getByTestId('settings-tab-behaviour'))
    await limitDrawn()
    expect(screen.getByTestId('settings-tab-behaviour').getAttribute('aria-current')).toBe('page')
    expect(limitField().value).toBe('12')

    // The same listing on every other tab: no Tool rounds there. Each tab is
    // waited on until its first section draws, so a panel still loading
    // cannot pass for one without the section.
    for (const t of SETTINGS_TABS.filter(tab => tab.slug !== 'behaviour')) {
      fireEvent.click(screen.getByTestId(`settings-tab-${t.slug}`))
      await panel().findByRole('heading', { level: 2, name: SECTIONS_BY_TAB[t.slug][0] })
      expectNoLimit(t.slug)
    }
  })

  it('is drawn beside the proactive settings when both are listed, and not when only they are', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, ...PROACTIVE, limitDef(12)])
    const both = renderAt('/settings/behaviour')

    await limitDrawn()
    expect(limitField().value).toBe('12')
    expect(panel().getByRole('heading', { level: 2, name: 'Proactive' })).toBeTruthy()
    expect(panel().getByRole('heading', { level: 2, name: 'Response quality' })).toBeTruthy()
    both.unmount()

    // The proactive keys without the limit: Proactive drawing proves the read
    // landed, so the absence after it is the page's choice, not a slow load.
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, ...PROACTIVE])
    renderAt('/settings/behaviour')
    await panel().findByRole('heading', { level: 2, name: 'Proactive' })
    expect(panel().getByRole('heading', { level: 2, name: 'Response quality' })).toBeTruthy()
    expectNoLimit('the proactive keys listed, the limit not')
  })

  it('is drawn when listed without the proactive settings, and not when unlisted or when the read fails, which the page says', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, limitDef(12)])
    const alone = renderAt('/settings/behaviour')

    await limitDrawn()
    expect(limitField().value).toBe('12')
    expect(panel().queryByRole('heading', { level: 2, name: 'Proactive' })).toBeNull()
    alone.unmount()

    // Unlisted: Behaviour still draws, with no limit and no number field of
    // the browser's own (the default 6 or any other).
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL])
    const unlisted = renderAt('/settings/behaviour')
    await panel().findByRole('heading', { level: 2, name: 'Response quality' })
    expectNoLimit('the limit unlisted')
    expect(panel().queryAllByRole('spinbutton')).toEqual([])
    unlisted.unmount()

    // The read failed: the page says why, Behaviour still draws, and there is
    // no def to draw the limit from.
    const reason = 'could not reach Nova — connection refused'
    vi.mocked(getSettings).mockRejectedValue(new Error(reason))
    renderAt('/settings/behaviour')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(`Could not read the settings: ${reason}`),
    )
    await panel().findByRole('heading', { level: 2, name: 'Response quality' })
    expectNoLimit('the read failed')
    expect(panel().queryAllByRole('spinbutton')).toEqual([])
  })

  it('a save puts what core stored into the page, so nothing is pending and the limit reads 21 after leaving the tab and coming back, with no second read', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, limitDef(12)])
    // Core stores 21 for a typed 20: the page must keep core's number.
    coreAnswers(async (key, value) => (key === LIMIT_KEY ? { key, value: 21 } : { key, value }))
    renderAt('/settings/behaviour')

    await limitDrawn()
    expect(limitField().value).toBe('12')
    fireEvent.change(limitField(), { target: { value: '20' } })
    fireEvent.click(panel().getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(panel().getByText(/^Saved\b/).textContent).toContain('stored as 21'))
    // Through lib/api's putSetting, once, as the number typed.
    expect(vi.mocked(putSetting).mock.calls).toEqual([[LIMIT_KEY, 20]])
    expect(limitField().value).toBe('21')
    // Nothing pending: the page holds 21 now, so there is no Save, and no
    // Reset that would bring 12 back.
    expect(panel().queryByRole('button', { name: 'Save' })).toBeNull()
    expect(panel().queryByRole('button', { name: 'Reset' })).toBeNull()

    await leaveAndComeBack()
    expect(limitField().value).toBe('21')
    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(settingsFetches()).toEqual([])
    expect(vi.mocked(putSetting).mock.calls).toEqual([[LIMIT_KEY, 20]])
  })

  it('a refusal shows the sentence core refused with, saves nothing, and the limit reads 12 after leaving the tab and coming back', async () => {
    vi.mocked(getSettings).mockResolvedValue([CHAT_MODEL, limitDef(12)])
    // Core refuses 51 the way lib/api's putSetting rejects on core's 400.
    coreAnswers(async (key, value) => {
      if (key === LIMIT_KEY && value === 51) throw new ApiError(400, CORE_REFUSES_51)
      return { key, value }
    })
    renderAt('/settings/behaviour')

    await limitDrawn()
    fireEvent.change(limitField(), { target: { value: '51' } })
    fireEvent.click(panel().getByRole('button', { name: 'Save' }))

    // Core's sentence, verbatim, after the section's lead.
    await waitFor(() =>
      expect(panel().getByRole('alert').textContent).toBe(`Could not save the limit: ${CORE_REFUSES_51}`),
    )
    // Through lib/api's putSetting, once, as the number 51.
    expect(vi.mocked(putSetting).mock.calls).toEqual([[LIMIT_KEY, 51]])
    // Nothing says saved.
    expect(panel().queryByText(/^Saved\b/)).toBeNull()
    expect(screen.getByTestId('settings-panel').textContent).not.toContain('stored as')

    await leaveAndComeBack()
    expect(limitField().value).toBe('12')
    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(putSetting).mock.calls).toEqual([[LIMIT_KEY, 51]])
  })
})
