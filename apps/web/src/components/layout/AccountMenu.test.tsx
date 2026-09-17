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

function mount(role = 'owner', name = 'jeremyspofford@gmail.com') {
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
    <MemoryRouter>
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
    expect(hrefs).toEqual(['/settings', '/spend', '/activity'])
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
    expect(hrefs).toEqual(['/settings'])
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
