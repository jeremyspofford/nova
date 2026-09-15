import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppLayout } from './AppLayout'
import { AuthProvider } from '../../stores/auth-store'
import { ThemeProvider } from '../../stores/theme-store'

/**
 * Which navigation surface renders, at which width.
 *
 * This file exists because of a three-week outage nobody could see from the
 * code. `AppLayout` read `{!isMobile && <MobileNav />}` from the 2026-08-27
 * design-system port. `useIsMobile()` is TRUE below 768px, so the bottom nav
 * rendered only on DESKTOP — where its own `md:hidden` class hid it. It
 * therefore appeared nowhere. A phone had no tabs, no "More" drawer and no
 * route to Settings, and the owner reported the whole product as "it's chat
 * only" on 2026-09-15.
 *
 * Nothing caught it: there was no AppLayout test, both surfaces render fine
 * in isolation, and the desktop sidebar is unaffected. The only way to see
 * it was to hold a phone. So the pin is on both directions — a nav that
 * renders in neither place and a nav that renders in both are equally wrong,
 * and one of them was live.
 */

const MD = '(min-width: 768px)'

/** Drive `useIsMobile`, which reads matchMedia('(min-width: 768px)'). */
function setViewport(width: 'mobile' | 'desktop') {
  const isDesktop = width === 'desktop'
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === MD ? isDesktop : false,
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

function renderShell(unseen = 0) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/auth/state')
        ? { has_users: true }
        : url.includes('/notices')
          ? { notices: [], unseen_count: unseen }
          : { person: { id: 'p1', name: 'Ada', role: 'owner' } }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response
    }),
  )
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <AppLayout>
            <div>page</div>
          </AppLayout>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  )
}

/** The phone's way out of chat. Was a bottom tab bar until 2026-09-15; now
 *  a left-edge handle, because the bar was pinned to an edge this app could
 *  not reliably control on iOS. */
function edgeHandle(): HTMLElement | null {
  return document.querySelector('[data-testid="edge-handle"]')
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('AppLayout — which nav renders', () => {
  it('renders the edge handle on a phone', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    expect(edgeHandle(), 'a phone must get a way out of chat').not.toBeNull()
  })

  it('does not render the phone nav on a desktop', async () => {
    // It would be CSS-hidden by `md:hidden` anyway, but rendering a nav that
    // can never be seen is how the 2026-08-27 inversion stayed invisible for
    // three weeks: it "worked" everywhere and appeared nowhere.
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')

    expect(edgeHandle(), 'a desktop has the sidebar and must not render this').toBeNull()
  })

  it('the handle opens the drawer, which is how Settings is reached', async () => {
    // The owner could not find Settings on his phone, and later could not
    // get OUT of the drawer. Settings lives in a labelled nav section, which
    // the drawer carries — so the handle is the whole route to it.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(edgeHandle()!)

    const drawer = await screen.findByTestId('mobile-drawer')
    // Scoped to the drawer: the desktop sidebar renders its own Settings
    // link into the same DOM, so an unscoped query matches both.
    expect(within(drawer).getByRole('link', { name: /settings/i })).toBeTruthy()
    // And a way back out, which the drawer lacked visually when its header
    // was drawn under the status bar.
    expect(within(drawer).getByText('Menu')).toBeTruthy()
  })

  it('opens on a rightward swipe from the edge', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    const handle = edgeHandle()!

    fireEvent.touchStart(handle, { touches: [{ clientX: 2, clientY: 400 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 60, clientY: 404 }] })

    expect(await screen.findByTestId('mobile-drawer')).toBeTruthy()
  })

  it('does not open when the touch is really a scroll', async () => {
    // A drag that travels further down than across is the page scrolling,
    // not the menu opening. The panel mounts during ANY drag so the gesture
    // has something to pull, so what is asserted is where it SETTLES on
    // release — mid-gesture presence proves nothing.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    const handle = edgeHandle()!

    fireEvent.touchStart(handle, { touches: [{ clientX: 2, clientY: 400 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 30, clientY: 300 }] })
    fireEvent.touchEnd(handle)

    await waitFor(() => expect(screen.queryByTestId('mobile-drawer')).toBeNull())
  })

  it('a short pull snaps back rather than opening', async () => {
    // Released before half the panel's width, it returns — otherwise a
    // twitch near the edge leaves the menu hanging half-open.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    const handle = edgeHandle()!

    fireEvent.touchStart(handle, { touches: [{ clientX: 2, clientY: 400 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 40, clientY: 402 }] })
    fireEvent.touchEnd(handle)

    await waitFor(() => expect(screen.queryByTestId('mobile-drawer')).toBeNull())
  })

  it('a long pull opens it', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    const handle = edgeHandle()!

    fireEvent.touchStart(handle, { touches: [{ clientX: 2, clientY: 400 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 260, clientY: 404 }] })
    fireEvent.touchEnd(handle)

    expect(await screen.findByTestId('mobile-drawer')).toBeTruthy()
  })

  it('keeps the grip clean and carries the count inside the panel', async () => {
    // The owner's call (2026-09-15): a count on a closed handle is noise.
    // The trade is that the number is read rather than glanced at, so it
    // must genuinely be on the Inbox row when the panel opens.
    setViewport('mobile')
    renderShell(4)
    await screen.findByText('page')

    expect(screen.queryByTestId('edge-handle-badge')).toBeNull()

    fireEvent.click(edgeHandle()!)
    const drawer = await screen.findByTestId('mobile-drawer')
    const inbox = within(drawer).getByRole('link', { name: /inbox/i })
    expect(within(inbox).getByTestId('nav-count-badge').textContent).toContain('4')
  })
})
