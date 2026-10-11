import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AccountMenu } from './AccountMenu'
import { AuthProvider } from '../../stores/auth-store'

/**
 * Who is signed in, and where to go next.
 *
 * The footer was a static card showing `people.name` — an email on this
 * instance, so a 240px column read "jeremyspofford@gmail…." and said
 * nothing about who that is. The full identity still appears, once, at the
 * top of the menu where it is information rather than a label that has to
 * fit.
 */

function mount(role = 'owner', name = 'jeremyspofford@gmail.com', path = '/chat') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/auth/state')
        ? { has_users: true }
        : { person: { id: 'p1', name, role } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response
    }),
  )
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AccountMenu />
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('AccountMenu', () => {
  it('calls him by name in the footer, never by his address', async () => {
    mount()
    const button = await screen.findByTestId('account-button')
    expect(button.textContent).toContain('Jeremyspofford')
    expect(button.textContent).not.toContain('@gmail.com')
    expect(button.textContent?.toLowerCase()).toContain('owner')
  })

  it('shows the full identity once, inside the menu', async () => {
    mount()
    fireEvent.click(await screen.findByTestId('account-button'))
    expect(screen.getByTestId('account-menu-identity').textContent).toBe('jeremyspofford@gmail.com')
  })

  it('every item goes somewhere that exists', async () => {
    // A link to a page nobody has written is the same defect as a button
    // for a capability nobody built. Items join this menu when their
    // destination does.
    mount()
    fireEvent.click(await screen.findByTestId('account-button'))
    const hrefs = screen
      .getAllByRole('menuitem')
      .map(i => i.getAttribute('href'))
      .filter(Boolean)
    // /about joined 2026-10-07 with its page (pages/about/AboutPage.tsx).
    expect(hrefs).toEqual(['/settings', '/spend', '/activity', '/about'])
  })

  it('offers a guest only what a guest can reach', async () => {
    // Usage and Activity are admin-only in the nav; a menu that offers them
    // to a guest offers a 404.
    mount('guest')
    fireEvent.click(await screen.findByTestId('account-button'))
    const hrefs = screen
      .getAllByRole('menuitem')
      .map(i => i.getAttribute('href'))
      .filter(Boolean)
    // About is every signed-in person's: what this instance is, nothing
    // anyone could change from it.
    expect(hrefs).toEqual(['/settings', '/about'])
  })

  it('closes on Escape', async () => {
    mount()
    fireEvent.click(await screen.findByTestId('account-button'))
    expect(screen.getByTestId('account-menu')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('account-menu')).toBeNull())
  })

  it('toggles rather than only opening', async () => {
    mount()
    const button = await screen.findByTestId('account-button')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(button)
    await waitFor(() => expect(screen.queryByTestId('account-menu')).toBeNull())
  })

  it('carries a way out', async () => {
    mount()
    fireEvent.click(await screen.findByTestId('account-button'))
    expect(screen.getByTestId('account-menu-signout')).toBeTruthy()
  })
})

describe('AccountMenu — where you are (R11, 2026-10-11)', () => {
  it('names each item as its page is titled', async () => {
    mount()
    fireEvent.click(await screen.findByTestId('account-button'))
    const labels = screen.getAllByRole('menuitem').map(i => i.textContent?.trim())
    expect(labels).toContain('Activity')
    expect(labels).toContain('Spend')
    expect(labels).not.toContain('What she has done')
    expect(labels).not.toContain('Usage')
  })

  it('marks the trigger while you are on one of its pages, or anywhere in Settings', async () => {
    for (const path of ['/activity', '/spend', '/settings/appearance', '/agents/coder']) {
      const { unmount } = mount('owner', 'jeremyspofford@gmail.com', path)
      expect((await screen.findByTestId('account-button')).getAttribute('aria-current'), path).toBe('page')
      unmount()
    }
  })

  it('does not mark it anywhere else', async () => {
    mount('owner', 'jeremyspofford@gmail.com', '/files')
    expect((await screen.findByTestId('account-button')).getAttribute('aria-current')).toBeNull()
  })

  it('marks the item for the page you are on', async () => {
    mount('owner', 'jeremyspofford@gmail.com', '/spend')
    fireEvent.click(await screen.findByTestId('account-button'))
    const spend = screen.getAllByRole('menuitem').find(i => i.getAttribute('href') === '/spend')!
    expect(spend.getAttribute('aria-current')).toBe('page')
    const settings = screen.getAllByRole('menuitem').find(i => i.getAttribute('href') === '/settings')!
    expect(settings.getAttribute('aria-current')).toBeNull()
  })
})

