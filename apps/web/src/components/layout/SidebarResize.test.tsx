import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar, SIDEBAR, clampSidebarWidth } from './Sidebar'
import { AuthProvider } from '../../stores/auth-store'
import { ThemeProvider } from '../../stores/theme-store'
import { UnseenNoticesProvider } from '../../hooks/useUnseenNotices'

/**
 * The sidebar's edge handle: one control that both collapses and sizes.
 *
 * It replaced a "Collapse" row at the foot of the panel on 2026-09-15, to
 * match the phone's grip — the owner asked whether one idea could cover both
 * surfaces. The risk in merging the two is that they interfere: a pointer
 * sequence ends with a click, so a drag that resizes would, unguarded, be
 * followed by a click that collapses the panel it just sized. That is the
 * defect these are mostly here for.
 */

function renderSidebar(collapsed = false) {
  const onCollapsedChange = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/auth/state')
        ? { has_users: true }
        : { person: { id: 'p1', name: 'Ada', role: 'owner' } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response
    }),
  )
  render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <UnseenNoticesProvider listNotices={async () => ({ notices: [], unseen_count: 0 })} pollMs={1_000_000}>
            <Sidebar collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
          </UnseenNoticesProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  )
  return { onCollapsedChange }
}

const handle = () => screen.getByTestId('sidebar-handle')
const aside = () => screen.getByTestId('sidebar')

/**
 * One pointer event, carrying coordinates.
 *
 * jsdom implements no PointerEvent, so `fireEvent.pointerDown(el, {clientX})`
 * builds a plain Event and the coordinate is silently dropped — every drag
 * below then measured a zero-pixel move and passed against nothing. A
 * MouseEvent under the pointer type name is what React's listener receives,
 * and it carries clientX.
 */
function pointer(el: Element, type: string, clientX: number) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  fireEvent(el, ev)
}

/** A whole pointer sequence, ending in the click a real one ends with. */
function dragBy(dx: number) {
  const el = handle()
  pointer(el, 'pointerdown', 500)
  pointer(el, 'pointermove', 500 + dx)
  pointer(el, 'pointerup', 500 + dx)
  fireEvent.click(el)
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('clampSidebarWidth', () => {
  it('brings any stored number into range', () => {
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(10)).toBe(SIDEBAR.MIN)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR.MAX)
  })

  it('refuses a value that is not a number at all', () => {
    // localStorage is hand-editable, and Number('') is 0 while Number('x')
    // is NaN — a NaN width renders a sidebar of no width.
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR.DEFAULT)
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR.DEFAULT)
  })
})

describe('the sidebar edge handle', () => {
  it('renders on the panel and says which way it goes', () => {
    // "Hide"/"Show" since 2026-09-16, matching the app the owner pointed
    // at — and more honest now that collapsed means GONE rather than an
    // icon rail: "collapse" describes a panel that shrinks.
    renderSidebar(false)
    expect(handle().getAttribute('aria-label')).toBe('Hide sidebar')
    expect(handle().getAttribute('aria-expanded')).toBe('true')
  })

  it('says both of the things it does, and the shortcut', () => {
    // A 2px line is not a guessable control, and it does TWO things: click
    // hides, drag resizes. Its own element rather than `title`, so it can
    // say two lines and appear without the browser's delay.
    renderSidebar(false)
    const tip = screen.getByTestId('sidebar-handle-tip')
    expect(tip.textContent).toContain('Hide sidebar')
    expect(tip.textContent).toContain('Ctrl+B')
    expect(tip.textContent).toContain('Drag to resize')
  })

  it('a click with no movement collapses', () => {
    const { onCollapsedChange } = renderSidebar(false)
    fireEvent.click(handle())
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  it('a drag resizes and does NOT then collapse', () => {
    // The whole reason the click is guarded. Without it, every resize ends
    // with the panel shutting.
    const { onCollapsedChange } = renderSidebar(false)
    dragBy(60)

    expect(aside().style.width).toBe(`${SIDEBAR.DEFAULT + 60}px`)
    expect(onCollapsedChange).not.toHaveBeenCalledWith(true)
  })

  it('a drag past the minimum stops at the maximum and the minimum', () => {
    renderSidebar(false)
    dragBy(9999)
    expect(aside().style.width).toBe(`${SIDEBAR.MAX}px`)
  })

  it('dragging it narrow enough shuts it instead of squeezing it', () => {
    const { onCollapsedChange } = renderSidebar(false)
    dragBy(-(SIDEBAR.DEFAULT - SIDEBAR.COLLAPSE_AT + 10))
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  it('remembers a settled width, and not the pixels in between', () => {
    renderSidebar(false)
    const el = handle()
    pointer(el, 'pointerdown', 500)
    pointer(el, 'pointermove', 560)
    // Mid-drag the panel has already moved, but storage has not: a write per
    // pointermove would put a localStorage round-trip inside the gesture.
    expect(aside().style.width).toBe(`${SIDEBAR.DEFAULT + 60}px`)
    expect(localStorage.getItem('nova-sidebar-width')).toBe(String(SIDEBAR.DEFAULT))

    pointer(el, 'pointerup', 560)
    fireEvent.click(el)
    expect(localStorage.getItem('nova-sidebar-width')).toBe(String(SIDEBAR.DEFAULT + 60))
  })

  it('restores the width it was left at', () => {
    localStorage.setItem('nova-sidebar-width', '320')
    renderSidebar(false)
    expect(aside().style.width).toBe('320px')
  })

  it('ignores a stored width that is not a width', () => {
    localStorage.setItem('nova-sidebar-width', 'wide-ish')
    renderSidebar(false)
    expect(aside().style.width).toBe(`${SIDEBAR.DEFAULT}px`)
  })

  it('arrow keys do the same job for anyone without a mouse', () => {
    const { onCollapsedChange } = renderSidebar(false)
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(aside().style.width).toBe(`${SIDEBAR.DEFAULT + 16}px`)

    fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true })
    expect(aside().style.width).toBe(`${SIDEBAR.DEFAULT + 16 - 48}px`)

    // And left far enough still shuts it, the same rule as the drag.
    for (let i = 0; i < 10; i++) fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true })
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  it('a collapsed panel opens from the handle rather than staying stuck', () => {
    const { onCollapsedChange } = renderSidebar(true)
    // COLLAPSED IS ZERO. It was 60px of icon rail, which is a third state —
    // neither the list nor the space back — and still charges for
    // navigation nobody is using.
    expect(SIDEBAR.COLLAPSED).toBe(0)
    expect(aside().style.width).toBe('0px')
    expect(handle().getAttribute('aria-label')).toBe('Show sidebar')

    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(onCollapsedChange).toHaveBeenCalledWith(false)
  })
})
