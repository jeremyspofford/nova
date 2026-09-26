import type { ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from '../../stores/theme-store'
import { InstallPage } from './InstallPage'
import { AppPage } from './AppPage'
import { AddPage } from './AddPage'

const ORIGIN = 'https://nova.fake-tailnet.ts.net'
const IPHONE = { os: 'ios', browser: 'safari', phone: true } as const
const ANDROID = { os: 'android', browser: 'chrome', phone: true } as const
const LINUX = { os: 'linux', browser: 'chrome', phone: false } as const
const WINDOWS = { os: 'windows', browser: 'chrome', phone: false } as const
const UNKNOWN = { os: 'unknown', browser: 'other', phone: false } as const

// PublicShell draws the brand mark from the live palette (useTheme), exactly
// as Sidebar and Login do — in the real app App.tsx's ThemeProvider is always
// an ancestor. Sidebar.test.tsx wraps the same way for the same reason.
function renderPage(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('InstallPage', () => {
  it("shows this device its own steps and no one else's", () => {
    renderPage(<InstallPage platform={IPHONE} installed={false} />)
    expect(screen.getByText('Tap Add to Home Screen.')).toBeTruthy()
    expect(screen.queryByText('Choose File, then Add to Dock.')).toBeNull()
  })
  it("an unknown device gets every platform's steps", () => {
    renderPage(<InstallPage platform={UNKNOWN} installed={false} />)
    expect(screen.getByText('iPhone or iPad, Safari')).toBeTruthy()
    expect(screen.getByText('Android, Chrome')).toBeTruthy()
  })
  it('inside the installed app, says so', () => {
    renderPage(<InstallPage platform={IPHONE} installed />)
    expect(screen.getByText('Nova is already installed on this device.')).toBeTruthy()
  })
  it('scrolls itself, because the document never does (index.css)', () => {
    renderPage(<InstallPage platform={UNKNOWN} installed={false} />)
    expect(screen.getByTestId('public-shell').className).toContain('overflow-y-auto')
    expect(screen.getByTestId('public-shell').className).toContain('fixed')
  })
})

describe('AppPage', () => {
  it('with no app, an iPhone is told so and is never sent anywhere', () => {
    const go = vi.fn()
    renderPage(<AppPage platform={IPHONE} links={{ ios: null, android: null }} go={go} />)
    expect(screen.getByText('There’s no Nova app for iPhone yet.')).toBeTruthy()
    expect(screen.getByText('Tap Add to Home Screen.')).toBeTruthy()
    expect(go).not.toHaveBeenCalled()
  })
  it('once a store link exists, a phone is sent to its own store', () => {
    const go = vi.fn()
    renderPage(
      <AppPage
        platform={ANDROID}
        links={{ ios: 'https://apps.apple.com/app/id1', android: 'https://play.google.com/store/apps/details?id=x' }}
        go={go}
      />,
    )
    expect(go).toHaveBeenCalledWith('https://play.google.com/store/apps/details?id=x')
  })
  it('a computer is told the app is for phones', () => {
    renderPage(<AppPage platform={WINDOWS} links={{ ios: null, android: null }} go={vi.fn()} />)
    expect(screen.getByText('The Nova app is for phones.')).toBeTruthy()
  })
})

describe('AddPage', () => {
  it('reads a lowercase code from the link and shows it the way it is read (Review Focus 2)', () => {
    renderPage(<AddPage platform={LINUX} hash="#abcd2345" origin={ORIGIN} share={undefined} />)
    expect(screen.getByTestId('add-code').textContent).toBe('ABCD-2345')
    expect(screen.getByText(`novad enroll --server ${ORIGIN} --code ABCD-2345`)).toBeTruthy()
  })
  it('asks for the code when the link carries none, and never calls the server', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderPage(<AddPage platform={LINUX} hash="" origin={ORIGIN} share={undefined} />)
    fireEvent.change(screen.getByLabelText('The code Nova showed you'), { target: { value: 'k7pq9xyz' } })
    expect(screen.getByTestId('add-code').textContent).toBe('K7PQ-9XYZ')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('on a phone: open it on the computer, with Share only where sharing exists (Review Focus 5)', () => {
    const share = vi.fn(async () => {})
    const { unmount } = renderPage(<AddPage platform={ANDROID} hash="#ABCD-2345" origin={ORIGIN} share={share} />)
    expect(screen.getByText('Open this on the computer you’re adding.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Share this link/ }))
    expect(share).toHaveBeenCalledWith({ title: 'Add a machine to Nova', url: `${ORIGIN}/add#ABCD-2345` })
    unmount()
    renderPage(<AddPage platform={ANDROID} hash="#ABCD-2345" origin={ORIGIN} share={undefined} />)
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull()
  })
  it('on Windows, says the agent is Linux-only today', () => {
    renderPage(<AddPage platform={WINDOWS} hash="#ABCD-2345" origin={ORIGIN} share={undefined} />)
    expect(screen.getByText('Nova’s agent runs on Linux today. Windows and macOS arrive with S42a.')).toBeTruthy()
  })
})
