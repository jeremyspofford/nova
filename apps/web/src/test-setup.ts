import { afterEach } from 'vitest'
import { configure } from '@testing-library/dom'

// Testing Library's default waitFor budget is 1 s, comfortable when this
// suite was small and marginal now: 63 files run in parallel, and a test
// that mounts two pages under three providers and waits on several async
// loads can spend most of a second just being scheduled. SettingsPage's
// model-switch test reddened that way — a flake that says nothing about the
// product and erodes the suite's authority every time it fires.
//
// This is HALF the fix and useless alone. A wait bounded at 5 s inside a
// test bounded at 5 s can never actually run out, so vitest kills the test
// first and reports "Test timed out" instead of the assertion that broke —
// which is precisely what the ChatPage take-back test had been doing. See
// `testTimeout` in vite.config.ts, which is deliberately much larger than
// this.
//
// Both bounds describe the ENVIRONMENT, not the code under test. Raising
// them costs nothing on a passing run: waitFor returns the moment its
// condition holds.
configure({ asyncUtilTimeout: 5000 })

// jsdom does not implement matchMedia; theme-store listens for OS color
// scheme changes unconditionally on mount, so every test that renders
// ThemeProvider needs this polyfill.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// jsdom does not implement scrollIntoView; ChatPage scrolls a bottom anchor
// into view on load (Part C, the scroll-to-newest fix), so any test that
// renders it needs this no-op. A test asserting the scroll happened replaces
// this with its own spy.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {}
}

// Node 25+ defines a `localStorage` getter on globalThis that yields undefined
// unless the process runs with --localstorage-file, and vitest's jsdom
// environment copies window keys onto global only where global lacks them —
// so on that Node jsdom's real Storage never lands and every test dies in the
// afterEach below. The former fix was NODE_OPTIONS=--no-experimental-webstorage
// in the npm script, which Node 20 (CI) refuses inside NODE_OPTIONS. This is
// the flag-free version: when global has no usable Storage, build one from
// jsdom itself (it IS the environment; a no-op on Node 20/22 where jsdom's own
// lands). Loud if that fails — a suite that quietly ran without storage would
// prove nothing.
if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  const { JSDOM } = await import('jsdom')
  const storage = new JSDOM('', { url: 'http://localhost/' }).window.localStorage
  if (typeof storage?.clear !== 'function') {
    throw new Error('test-setup: neither global nor jsdom provides localStorage — cannot run the suite')
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
}

afterEach(() => {
  localStorage.clear()
  document.getElementById('nova-theme-vars')?.remove()
  document.documentElement.classList.remove('dark')
})
