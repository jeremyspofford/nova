import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

function renderShell() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/auth/state')
        ? { has_users: true }
        : url.includes('/notices')
          ? { notices: [], unseen_count: 0 }
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

/** The bottom tab bar's own landmark — MobileNav renders a <nav>. */
function bottomNav(): HTMLElement | null {
  return document.querySelector('nav.md\\:hidden')
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('AppLayout — which nav renders', () => {
  it('renders the bottom nav on a phone', async () => {
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    expect(bottomNav(), 'a phone must get the bottom tab bar').not.toBeNull()
  })

  it('does not render the bottom nav on a desktop', async () => {
    // It would be CSS-hidden by `md:hidden` anyway, but rendering a nav that
    // can never be seen is how the inversion stayed invisible for so long:
    // it "worked" everywhere and appeared nowhere.
    setViewport('desktop')
    renderShell()
    await screen.findByText('page')

    expect(bottomNav(), 'a desktop must not render the bottom tab bar').toBeNull()
  })

  it('the phone nav offers the More control that reaches Settings', async () => {
    // The owner could not find Settings on his phone. Settings lives in a
    // labelled nav section, which MobileNav tucks into the "More" drawer —
    // so if this control is missing, Settings is unreachable on mobile even
    // when the bar renders.
    setViewport('mobile')
    renderShell()
    await screen.findByText('page')

    expect(screen.getByRole('button', { name: /more/i })).toBeTruthy()
  })
})
