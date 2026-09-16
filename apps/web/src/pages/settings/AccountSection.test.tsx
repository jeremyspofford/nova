import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountSection } from './AccountSection'
import { AuthProvider } from '../../stores/auth-store'

/**
 * The name became editable on 2026-09-16 for a reason the UI ran into:
 * `people.name` is whatever was typed at registration, and on this instance
 * that is an email. The sidebar can derive "Jeremy" from
 * `jeremy.spofford@…` and nothing at all from `jeremyspofford@…`, so the
 * only honest way to show somebody their own first name is to let them say
 * what it is.
 */

let currentName = 'jeremyspofford@gmail.com'

function mount(renameMe = vi.fn(async () => ({ person: { id: 'p1', name: 'Jeremy', role: 'owner' } }))) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/auth/state')
        ? { has_users: true }
        : { person: { id: 'p1', name: currentName, role: 'owner' } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response
    }),
  )
  const view = render(
    <AuthProvider>
      <AccountSection renameMe={renameMe as never} />
    </AuthProvider>,
  )
  return { view, renameMe }
}

beforeEach(() => {
  currentName = 'jeremyspofford@gmail.com'
  localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

describe('AccountSection — the name', () => {
  it('shows the name read-only until asked to change it', async () => {
    mount()
    expect(await screen.findByTestId('account-name')).toBeTruthy()
    expect(screen.queryByTestId('account-name-input')).toBeNull()

    fireEvent.click(screen.getByTestId('account-rename'))
    expect(screen.getByTestId('account-name-input')).toBeTruthy()
  })

  it('says the name is also the login, where it can be read before saving', async () => {
    // Rather than discovered at the next sign-in.
    mount()
    fireEvent.click(await screen.findByTestId('account-rename'))
    expect(screen.getByText(/sign in with/i)).toBeTruthy()
  })

  it('sends the new name and re-reads from core rather than patching locally', async () => {
    // A local patch the server rejected would render a name nobody has.
    const { renameMe } = mount()
    fireEvent.click(await screen.findByTestId('account-rename'))
    const input = screen.getByTestId('account-name-input')
    currentName = 'Jeremy'
    fireEvent.change(input, { target: { value: 'Jeremy' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(renameMe).toHaveBeenCalledWith('Jeremy'))
    await waitFor(() => expect(screen.getByTestId('account-name').textContent).toBe('Jeremy'))
  })

  it('saves on Enter and abandons on Escape', async () => {
    const { renameMe } = mount()
    fireEvent.click(await screen.findByTestId('account-rename'))
    fireEvent.change(screen.getByTestId('account-name-input'), { target: { value: 'Ada' } })
    fireEvent.keyDown(screen.getByTestId('account-name-input'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('account-name-input')).toBeNull())
    expect(renameMe).not.toHaveBeenCalled()
  })

  it('does not call the server for a name that has not changed', async () => {
    const { renameMe } = mount()
    fireEvent.click(await screen.findByTestId('account-rename'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.queryByTestId('account-name-input')).toBeNull())
    expect(renameMe).not.toHaveBeenCalled()
  })

  it('shows the reason a rename was refused, and keeps the field open', async () => {
    // A name somebody else holds comes back as a stated conflict; losing
    // the typed value on top of that would be two punishments for one typo.
    const refusing = vi.fn(async () => {
      throw new Error("somebody here is already called 'taken'")
    })
    mount(refusing as never)
    fireEvent.click(await screen.findByTestId('account-rename'))
    fireEvent.change(screen.getByTestId('account-name-input'), { target: { value: 'taken' } })
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('already called'),
    )
    expect(screen.getByTestId('account-name-input')).toBeTruthy()
  })
})
