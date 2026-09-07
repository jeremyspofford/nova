import { afterEach } from 'vitest'

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
