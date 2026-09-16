import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppLayout } from './AppLayout'
import { AuthProvider } from '../../stores/auth-store'
import { ThemeProvider } from '../../stores/theme-store'
import { navSections } from './Sidebar'

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

  it('carries a route back to Chat, which is the whole point of a menu', async () => {
    // THE 2026-09-15 TRAP. The drawer used to render `moreItems` — the
    // LABELLED nav sections. "Chat" lives in the unlabelled Core section, so
    // it was never in the drawer; the bottom tab bar carried it. Deleting
    // that bar therefore deleted the only route back, and the owner had to
    // force-quit the app to get out of Settings: "I don't have a way to
    // actually navigate to the chat window again."
    //
    // Nothing caught it. MobileNav.test.ts pins that every Sidebar route
    // appears in `primaryTabs` OR `moreItems` — which stayed true, because
    // the lists were fine. What changed was which list the drawer RENDERS.
    // So the pin has to be on the rendered DOM, not on the config.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(edgeHandle()!)
    const drawer = await screen.findByTestId('mobile-drawer')

    expect(
      within(drawer).getByRole('link', { name: /chat/i }).getAttribute('href'),
    ).toBe('/chat')
  })

  it('every Sidebar route is in the drawer, since the drawer is now the only nav', async () => {
    // Generalises the case above: with the tab bar gone there is exactly one
    // mobile surface, so anything missing from it is unreachable on a phone.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(edgeHandle()!)
    const drawer = await screen.findByTestId('mobile-drawer')
    const hrefs = within(drawer)
      .getAllByRole('link')
      .map(a => a.getAttribute('href'))

    for (const to of navSections.flatMap(s => s.items.map(i => i.to))) {
      expect(hrefs, `${to} is unreachable on a phone`).toContain(to)
    }
  })

  it('leaves the grip on the panel edge, as the way to push it shut', async () => {
    // The owner's call (2026-09-15): "leave that small handle there on the
    // menu bar so it's showing the user that you can drag it close." It used
    // to fade to opacity-0 when open, so the only way out was the X or the
    // backdrop — neither of which says "drag me".
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(edgeHandle()!)
    await screen.findByTestId('mobile-drawer')

    const grip = edgeHandle()
    expect(grip, 'the grip must survive opening').not.toBeNull()
    expect(grip!.className).not.toContain('pointer-events-none')
    expect(grip!.getAttribute('aria-label')).toMatch(/close/i)
  })

  it('a tap on the open grip closes it', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(edgeHandle()!)
    await screen.findByTestId('mobile-drawer')
    fireEvent.click(edgeHandle()!)

    await waitFor(() => expect(screen.queryByTestId('mobile-drawer')).toBeNull())
  })

  it('a drag does not have its own click undo it', async () => {
    // A touch sequence ends with a synthetic click. With the grip toggling
    // rather than only opening, an unguarded click would close the panel the
    // instant a pull-open settled.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    const handle = edgeHandle()!

    fireEvent.touchStart(handle, { touches: [{ clientX: 2, clientY: 400 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 260, clientY: 404 }] })
    fireEvent.touchEnd(handle)
    fireEvent.click(handle)

    expect(await screen.findByTestId('mobile-drawer')).toBeTruthy()
  })

  it('keeps the whole grip clear of the menu when open', async () => {
    // The owner's call (2026-09-15): "that handle should only be on the edge
    // of the menu, I don't like it flowing into the menu items." The touch
    // target is wider than the drawn tab, and that slack used to bleed LEFT
    // — free while the grip sat at the screen edge, but once it rides the
    // panel's edge the same bleed lays 24px of button over the nav rows,
    // swallowing taps on whichever one it covers. The slack extends right.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(edgeHandle()!)
    await screen.findByTestId('mobile-drawer')

    const grip = edgeHandle()!
    const tab = screen.getByTestId('edge-handle-tab')
    // The panel is 300 wide and starts at x=0, so nothing belonging to the
    // grip may begin before 300. jsdom does not lay out, so the assertion is
    // on the declared geometry rather than on a measured rect.
    expect(grip.style.transform).toContain('translate(300px')
    expect(grip.className).not.toMatch(/-ml-/)
    expect(tab.className).not.toMatch(/-ml-|pl-/)
  })

  it('a vertical drag moves the grip and remembers where it was left', async () => {
    // "I'd like to be able to drag it up or down to move the handle to my
    // preferred location." A handle fixed at the vertical centre is in the
    // wrong place for whichever hand is not holding the phone.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    const handle = edgeHandle()!

    // Centred to begin with: top:50% pulled back by half its own height.
    expect(handle.style.top).toBe('50%')
    expect(handle.style.transform).toContain('-50%')

    fireEvent.touchStart(handle, { touches: [{ clientX: 20, clientY: 400 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 22, clientY: 500 }] })
    fireEvent.touchEnd(handle)

    // jsdom reports a zero rect, so the grip's top starts at 0 and a 100px
    // pull down lands it at 100.
    expect(handle.style.top).toBe('100px')
    expect(handle.style.transform).toContain('0px)')
    expect(localStorage.getItem('nova-grip-y')).toBe('100')
  })

  it('a vertical drag does not also open the menu', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    const handle = edgeHandle()!

    fireEvent.touchStart(handle, { touches: [{ clientX: 20, clientY: 400 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 26, clientY: 520 }] })
    fireEvent.touchEnd(handle)

    await waitFor(() => expect(screen.queryByTestId('mobile-drawer')).toBeNull())
  })

  it('restores the position it was left at', async () => {
    localStorage.setItem('nova-grip-y', '240')
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    expect(edgeHandle()!.style.top).toBe('240px')
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

/**
 * The sidebar closes to NOTHING (2026-09-16), so unlike the old 60px icon
 * rail it leaves nothing behind to click. Two routes back, and they have to
 * work from every page — hiding it on Settings must not strand anyone.
 */
describe('AppLayout — getting the sidebar back', () => {
  it('shows a control only while the sidebar is hidden', async () => {
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')

    expect(screen.queryByTestId('show-sidebar')).toBeNull()

    fireEvent.click(screen.getByTestId('sidebar-handle'))
    expect(await screen.findByTestId('show-sidebar')).toBeTruthy()

    fireEvent.click(screen.getByTestId('show-sidebar'))
    await waitFor(() => expect(screen.queryByTestId('show-sidebar')).toBeNull())
  })

  it('Ctrl+B toggles it, which is what the handle promises', async () => {
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(await screen.findByTestId('show-sidebar')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    await waitFor(() => expect(screen.queryByTestId('show-sidebar')).toBeNull())
  })

  it('Cmd+B does the same, because half the desktops are Macs', async () => {
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')

    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    expect(await screen.findByTestId('show-sidebar')).toBeTruthy()
  })

  it('a bare b does not, or typing the letter would close the sidebar', async () => {
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')

    fireEvent.keyDown(window, { key: 'b' })
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true })
    expect(screen.queryByTestId('show-sidebar')).toBeNull()
  })

  it('offers no sidebar control on a phone, which has no sidebar', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByTestId('show-sidebar')).toBeNull()
  })
})

describe('AppLayout — the show-sidebar control has its own space', () => {
  it('reserves room for it rather than floating it over the page', async () => {
    // It floats in the SHELL so it works on every page, including ones
    // nobody has written yet — which means it lands on top of whatever each
    // page puts at its top-left. The first screenshot after this shipped had
    // it sitting on the word "Chat".
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')
    const main = document.querySelector('main')!

    expect(main.className).not.toContain('md:pl-11')

    fireEvent.click(screen.getByTestId('sidebar-handle'))
    await screen.findByTestId('show-sidebar')
    expect(main.className).toContain('md:pl-11')
  })
})
