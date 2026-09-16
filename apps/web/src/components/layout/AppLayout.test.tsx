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

/** The phone's way out of chat. A bottom tab bar until 2026-09-15 (pinned to
 *  an edge this app cannot control on iOS), then a draggable left-edge grip
 *  for a day, and since 2026-09-16 a menu button in the top-left — the
 *  owner's call: "make it look and feel more like Claude". */
function menuButton(): HTMLElement | null {
  return document.querySelector('[data-testid="menu-button"]')
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('AppLayout — which nav renders', () => {
  it('renders the menu button on a phone', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    expect(menuButton(), 'a phone must get a way out of chat').not.toBeNull()
  })

  it('does not render the phone nav on a desktop', async () => {
    // It would be CSS-hidden by `md:hidden` anyway, but rendering a nav that
    // can never be seen is how the 2026-08-27 inversion stayed invisible for
    // three weeks: it "worked" everywhere and appeared nowhere.
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')

    expect(menuButton(), 'a desktop has the sidebar and must not render this').toBeNull()
  })

  it('the menu button opens the drawer, which is how Settings is reached', async () => {
    // The owner could not find Settings on his phone, and later could not
    // get OUT of the drawer. Since 2026-09-16 Settings is not a nav row at
    // all — it is under his NAME, in the account menu at the foot of this
    // drawer — so the button is the whole route to it and the account menu
    // must render here or the page is unreachable on a phone.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(menuButton()!)

    const drawer = await screen.findByTestId('mobile-drawer')
    // His name, at the foot — the only home Settings, Usage and "what she
    // has done" have now.
    const account = within(drawer).getByTestId('mobile-account')
    fireEvent.click(within(account).getByTestId('account-button'))
    // `menuitem`, not `link`: the explicit role on the anchor overrides the
    // implicit one, which is the whole point of a menu.
    const settings = within(account).getByRole('menuitem', { name: /settings/i })
    expect(settings.getAttribute('href')).toBe('/settings')
    // And the other two that left the nav on the same day, so a phone can
    // still reach them at all.
    expect(within(account).getByRole('menuitem', { name: /usage/i })).toBeTruthy()
    expect(within(account).getByRole('menuitem', { name: /what she has done/i })).toBeTruthy()
    // And a way back out, which the drawer lacked visually when its header
    // was drawn under the status bar.
    expect(within(drawer).getByText('Menu')).toBeTruthy()
  })

  // OPENING BY DRAG IS GONE (2026-09-16). Four tests lived here — a
  // rightward swipe opened the panel, a mostly-vertical one was read as a
  // scroll, a short pull snapped back and a long one settled open. All four
  // drove the grip, and the grip was replaced by a button. The panel still
  // drags CLOSED (its own touch handlers, and the test below), which is the
  // half a person actually reaches for once the menu is open.

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

    fireEvent.click(menuButton()!)
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

    fireEvent.click(menuButton()!)
    const drawer = await screen.findByTestId('mobile-drawer')
    const hrefs = within(drawer)
      .getAllByRole('link')
      .map(a => a.getAttribute('href'))

    for (const to of navSections.flatMap(s => s.items.map(i => i.to))) {
      expect(hrefs, `${to} is unreachable on a phone`).toContain(to)
    }
  })

  it('hides the button while the panel is open, since the panel has its own way out', async () => {
    // The grip that used to ride the panel's edge was deliberately kept
    // visible when open — it was the thing you pushed back. A corner button
    // is not: leaving it on top of an open panel is two controls for one
    // state, and the panel already carries an X and a backdrop.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    fireEvent.click(menuButton()!)
    await screen.findByTestId('mobile-drawer')

    expect(menuButton()!.className).toContain('pointer-events-none')
  })

  it('sits inside the top safe inset, not under the status bar', async () => {
    // index.html sets viewport-fit=cover, so y=0 is behind the clock on the
    // owner's phone. A menu button drawn there is one he cannot press.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    expect(menuButton()!.style.top).toContain('var(--nova-safe-top')
  })

  it('drags the open panel shut', async () => {
    // The half of the gesture that survived the grip: once the menu is open,
    // pushing it back with a thumb is what a person reaches for.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')
    fireEvent.click(menuButton()!)
    const panel = await screen.findByTestId('mobile-drawer-panel')

    fireEvent.touchStart(panel, { touches: [{ clientX: 280, clientY: 400 }] })
    fireEvent.touchMove(panel, { touches: [{ clientX: 40, clientY: 404 }] })
    fireEvent.touchEnd(panel)

    await waitFor(() => expect(screen.queryByTestId('mobile-drawer')).toBeNull())
  })

  it('keeps the button clean and carries the count inside the panel', async () => {
    // The owner's call (2026-09-15): a count on a closed menu is noise.
    // The trade is that the number is read rather than glanced at, so it
    // must genuinely be on the Inbox row when the panel opens.
    setViewport('mobile')
    renderShell(4)
    await screen.findByText('page')

    expect(within(menuButton()!).queryByTestId('nav-count-badge')).toBeNull()

    fireEvent.click(menuButton()!)
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
