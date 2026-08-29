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

afterEach(() => {
  localStorage.clear()
  document.getElementById('nova-theme-vars')?.remove()
  document.documentElement.classList.remove('dark')
})
