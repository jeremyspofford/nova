import type { ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// S42b: the public manifest (Task 19/28) — the one-liners with a {CODE} slot
// /add fills in the browser, never sends anywhere. Same shape the chat card
// and Settings read.
const MANIFEST = {
  version: 'aaaaaaaaaaaa',
  commands: { linux: 'L --code {CODE}', macos: 'M --code {CODE}', windows: 'W --code {CODE}' },
  commands_reason: null,
  walks: { linux: 'Linux: walked', macos: 'macOS: not walked yet', windows: 'Windows: walked' },
  notes: { linux: '', macos: '', windows: '' },
}

// PublicShell draws the brand mark from the live palette (useTheme), exactly
// as Sidebar and Login do — in the real app App.tsx's ThemeProvider is always
// an ancestor. Sidebar.test.tsx wraps the same way for the same reason.
function renderPage(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

// This project carries no @types/node (a browser app), so process is typed
// locally, just enough to listen for a real unhandled rejection below.
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void
}
const nodeProcess = process

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
  it('reads a lowercase code from the link and shows it the way it is read, filling the Linux line (Review Focus 2)', async () => {
    const getManifest = vi.fn(async () => MANIFEST)
    renderPage(<AddPage platform={LINUX} hash="#abcd2345" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
    expect(screen.getByTestId('add-code').textContent).toBe('ABCD-2345')
    expect(await screen.findByText('L --code ABCD-2345')).toBeTruthy()
  })
  it('makes one request, the public manifest, and fills the code in on the page (P18)', async () => {
    const getManifest = vi.fn(async () => MANIFEST)
    renderPage(<AddPage platform={WINDOWS} hash="#abcd2345" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
    expect(await screen.findByText('W --code ABCD-2345')).toBeTruthy()
    expect(getManifest).toHaveBeenCalledTimes(1)
    expect(getManifest.mock.calls[0]).toEqual([]) // the code never leaves the page
  })
  it('says why there is no command when the hub has no build', async () => {
    const getManifest = vi.fn(async () => {
      throw new Error('the hub has no agent build yet')
    })
    renderPage(<AddPage platform={LINUX} hash="#ABCD-2345" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
    expect((await screen.findByRole('alert')).textContent).toContain('the hub has no agent build yet')
  })
  it('says nothing is wrong while still asking — no alert while the manifest is pending (K1)', () => {
    renderPage(<AddPage platform={LINUX} hash="#ABCD-2345" origin={ORIGIN} share={undefined} getManifest={() => new Promise(() => {})} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Asking Nova for the command…')).toBeTruthy()
  })
  it('passes through core’s own commands_reason when the manifest answers with none (K2)', async () => {
    const getManifest = vi.fn(async () => ({
      ...MANIFEST,
      commands: null,
      commands_reason: 'Nova has no address another device can reach',
    }))
    renderPage(<AddPage platform={LINUX} hash="#ABCD-2345" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Nova has no address another device can reach')
  })
  it('a bare "#" carries no code either, and asks the same friendly way (Review Focus 2)', () => {
    renderPage(<AddPage platform={LINUX} hash="#" origin={ORIGIN} share={undefined} />)
    expect(screen.getByText('This page adds a machine to Nova. Type the code Nova showed you.')).toBeTruthy()
    expect(screen.queryByText(/That link carries no code Nova can read/)).toBeNull()
    expect(screen.getByLabelText('The code Nova showed you')).toBeTruthy()
  })
  it('typing the code reaches the server only once it forms a real code, and then exactly once', async () => {
    const getManifest = vi.fn(async () => MANIFEST)
    renderPage(<AddPage platform={LINUX} hash="" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
    expect(getManifest).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('The code Nova showed you'), { target: { value: 'k7pq9xyz' } })
    expect(screen.getByTestId('add-code').textContent).toBe('K7PQ-9XYZ')
    await waitFor(() => expect(getManifest).toHaveBeenCalledTimes(1))
  })
  it('on a phone: open it on the computer, with Share only where sharing exists (Review Focus 5)', async () => {
    const share = vi.fn(async () => {})
    const getManifest = vi.fn(async () => MANIFEST)
    const { unmount } = renderPage(<AddPage platform={ANDROID} hash="#ABCD-2345" origin={ORIGIN} share={share} getManifest={getManifest} />)
    expect(screen.getByText('Open this on the computer you’re adding.')).toBeTruthy()
    // K7: awaited so the manifest's own state update lands inside act(),
    // not as a stray warning once this test has already moved on.
    await screen.findByText('L --code ABCD-2345')
    fireEvent.click(screen.getByRole('button', { name: /Share this link/ }))
    expect(share).toHaveBeenCalledWith({ title: 'Add a machine to Nova', url: `${ORIGIN}/add#ABCD-2345` })
    unmount()
    renderPage(<AddPage platform={ANDROID} hash="#ABCD-2345" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
    await screen.findByText('L --code ABCD-2345')
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull()
  })
  it('a cancelled share leaves no unhandled rejection, and the page stays as it was', async () => {
    // A plain function, not vi.fn: vi.fn's own instrumentation attaches a
    // .then/.catch to any promise a mock returns (to populate
    // mock.settledResults), which would quietly "handle" the rejection for
    // us and hide exactly the bug this test exists to catch.
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    let calledWith: { title: string; url: string } | null = null
    const share = (data: { title: string; url: string }) => {
      calledWith = data
      return Promise.reject(abort)
    }
    const getManifest = vi.fn(async () => MANIFEST)
    const rejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason)
    // jsdom's own 'unhandledrejection' window event never fires for a plain
    // promise like this one — it only relays rejections from scripts jsdom
    // itself executes. Node's real tracking is the only thing that actually
    // sees this, so this listens there directly.
    nodeProcess.on('unhandledRejection', onUnhandledRejection)
    try {
      renderPage(<AddPage platform={ANDROID} hash="#ABCD-2345" origin={ORIGIN} share={share} getManifest={getManifest} />)
      // K7: awaited so the manifest's own state update lands inside act().
      await screen.findByText('L --code ABCD-2345')
      fireEvent.click(screen.getByRole('button', { name: /Share this link/ }))
      // Flushes past the microtask the rejection settles on. If nothing in
      // AddPage catches it, it surfaces here as an unhandled rejection —
      // the page itself never shows an error for a cancelled share.
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      nodeProcess.off('unhandledRejection', onUnhandledRejection)
    }
    expect(calledWith).toEqual({ title: 'Add a machine to Nova', url: `${ORIGIN}/add#ABCD-2345` })
    expect(rejections).toEqual([])
    expect(screen.getByRole('button', { name: /Share this link/ })).toBeTruthy()
  })

  // S42b K8: the two tests above inject `getManifest` and never touch the
  // real wire. These pin the same claims one layer down — the REAL default
  // getManifest, against a stubbed global fetch — so a regression in
  // getAgentManifest/apiGet itself (not just in AddPage's own plumbing)
  // would also be caught here.
  describe('the security claims, pinned at the fetch level', () => {
    it('exactly one request, to the manifest, carrying the code nowhere — not in its URL, not in its body', async () => {
      const fetchSpy = vi.fn(
        async () => ({ ok: true, status: 200, json: async () => MANIFEST, text: async () => JSON.stringify(MANIFEST) }) as unknown as Response,
      )
      vi.stubGlobal('fetch', fetchSpy)
      renderPage(<AddPage platform={LINUX} hash="#abcd2345" origin={ORIGIN} share={undefined} />)
      expect(await screen.findByText('L --code ABCD-2345')).toBeTruthy()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('/api/v1/agent/manifest')
      expect(init.body).toBeUndefined()
      const whole = JSON.stringify(fetchSpy.mock.calls).toUpperCase()
      expect(whole).not.toContain('ABCD')
      expect(whole).not.toContain('2345')
    })

    it('typing: a partial code makes no request; a whole one makes exactly one', async () => {
      const fetchSpy = vi.fn(
        async () => ({ ok: true, status: 200, json: async () => MANIFEST, text: async () => '' }) as unknown as Response,
      )
      vi.stubGlobal('fetch', fetchSpy)
      renderPage(<AddPage platform={LINUX} hash="" origin={ORIGIN} share={undefined} />)
      fireEvent.change(screen.getByLabelText('The code Nova showed you'), { target: { value: 'k7pq9' } })
      expect(fetchSpy).not.toHaveBeenCalled()
      fireEvent.change(screen.getByLabelText('The code Nova showed you'), { target: { value: 'k7pq9xyz' } })
      expect(await screen.findByText('L --code K7PQ-9XYZ')).toBeTruthy()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })
})
