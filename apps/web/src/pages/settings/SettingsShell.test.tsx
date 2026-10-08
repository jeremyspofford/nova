import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsShell } from './SettingsShell'
import { SETTINGS_NAV } from './settingsNav'
import { AuthProvider } from '../../stores/auth-store'
import { PageHeader } from '../../components/layout/PageHeader'
import { WIDE_QUERY } from '../../hooks/useIsMobile'

/**
 * The Settings shell (2026-10-08): one "Settings" with its own nav, holding
 * the old tabs and the pages that left the sidebar. Two layouts, by width,
 * and both are pinned — the narrow one is the only one a phone ever sees, and
 * no harness renders a phone unless a test asks it to.
 */

/** `useIsWide` reads matchMedia(WIDE_QUERY). */
function setWide(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === WIDE_QUERY ? wide : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

function signIn(role: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/auth/state')
        ? { has_users: true }
        : { person: { id: 'p1', name: 'Ada', role } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response
    }),
  )
}

/** A stand-in page per route: its title through PageHeader, as every real
 *  page draws one, so the heading level the shell imposes is observable. */
function Page({ title }: { title: string }) {
  return <PageHeader title={title} description={`${title} page`} />
}

function renderAt(path: string, { wide = true, role = 'owner' } = {}) {
  setWide(wide)
  signIn(role)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route element={<SettingsShell />}>
            <Route path="/settings" element={<Page title="General" />} />
            <Route path="/settings/:tab" element={<Page title="A tab" />} />
            <Route path="/agents" element={<Page title="Agents" />} />
            <Route path="/agents/:name" element={<Page title="One agent" />} />
            <Route path="/models" element={<Page title="Model catalog" />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettingsShell — wide', () => {
  it('draws "Settings" once as the h1, the nav beside the page, and the page title as an h2', async () => {
    renderAt('/agents')
    await screen.findByTestId('settings-nav-agents')
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Settings'])
    expect(within(screen.getByTestId('settings-page')).getByRole('heading', { level: 2, name: 'Agents' })).toBeTruthy()
    expect(screen.getByTestId('settings-nav')).toBeTruthy()
    expect(screen.queryByTestId('settings-back')).toBeNull()
  })

  it('marks the entry the page belongs to, including a page beneath it', async () => {
    const { unmount } = renderAt('/agents/coder')
    await waitFor(() => expect(screen.getByTestId('settings-nav-agents').getAttribute('aria-current')).toBe('page'))
    unmount()

    renderAt('/settings')
    // Bare /settings is General on a wide screen, so General is marked.
    await waitFor(() => expect(screen.getByTestId('settings-tab-general').getAttribute('aria-current')).toBe('page'))
    expect(screen.getByTestId('settings-nav-agents').getAttribute('aria-current')).toBeNull()
  })

  it('lists every entry, under its group, for an owner', async () => {
    renderAt('/settings')
    const nav = await screen.findByTestId('settings-nav')
    await waitFor(() => expect(within(nav).getByText('Agents')).toBeTruthy())
    const hrefs = within(nav)
      .getAllByRole('link')
      .map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(SETTINGS_NAV.flatMap(g => g.items.map(i => i.to)))
    for (const g of SETTINGS_NAV) expect(within(nav).getByText(g.label)).toBeTruthy()
  })

  it('offers a guest none of the admin pages — a link to a page that refuses them is a dead end', async () => {
    renderAt('/settings', { role: 'guest' })
    const nav = await screen.findByTestId('settings-nav')
    await waitFor(() => expect(within(nav).getByText('General')).toBeTruthy())
    const hrefs = within(nav)
      .getAllByRole('link')
      .map(a => a.getAttribute('href'))
    for (const to of ['/agents', '/skills', '/models', '/quality', '/governance']) {
      expect(hrefs, to).not.toContain(to)
    }
    expect(hrefs).toContain('/settings/appearance')
  })
})

describe('SettingsShell — narrow (phone, tablet and small laptop, below 1280px)', () => {
  it('bare /settings is the list of everything, with no page open beside it', async () => {
    renderAt('/settings', { wide: false })
    const nav = await screen.findByTestId('settings-nav')
    await waitFor(() => expect(within(nav).getByText('Agents')).toBeTruthy())
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy()
    expect(screen.queryByTestId('settings-page')).toBeNull()
    // Nothing is open yet, so nothing is marked open.
    expect(within(nav).queryAllByRole('link').filter(a => a.getAttribute('aria-current'))).toEqual([])
  })

  it('an entry is its own page with a way back to the list, and no list beside it', async () => {
    renderAt('/models', { wide: false })
    expect(await screen.findByRole('heading', { level: 2, name: 'Model catalog' })).toBeTruthy()
    expect(screen.getByTestId('settings-back').getAttribute('href')).toBe('/settings')
    expect(screen.queryByTestId('settings-nav')).toBeNull()
  })

  it('a page beneath an entry carries its own way back, so the shell adds none', async () => {
    renderAt('/agents/coder', { wide: false })
    expect(await screen.findByRole('heading', { level: 2, name: 'One agent' })).toBeTruthy()
    expect(screen.queryByTestId('settings-back')).toBeNull()
    expect(screen.queryByTestId('settings-nav')).toBeNull()
  })
})
