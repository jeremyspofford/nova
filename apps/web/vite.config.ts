/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // One origin in dev too: /api goes to core, exactly as nginx sends it in
    // the baked image, so nothing behaves differently between `npm run dev`
    // and the container.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Vitest stubs every .css to '' by default; typeFloor.test.ts reads the
    // real index.css to pin that word spacing reaches the body and not code;
    // lightModeSurfaces.test.ts reads it and highlight.css for light mode.
    css: { include: [/src\/index\.css/, /components\/highlight\.css/] },
    // mammoth's package.json maps its file reader to a browser version (the
    // `browser` field), which reads an ArrayBuffer; Vite's app build follows
    // that map, but the test runner resolves the Node entry, which wants a
    // path or a Node Buffer. Point tests at the browser bundle so DocxView is
    // tested on the code path the app actually ships.
    alias: { mammoth: 'mammoth/mammoth.browser.js' },
    // A test's own budget must exceed the longest wait INSIDE it, or the
    // wait can never finish and the failure arrives as an opaque "Test
    // timed out" instead of the assertion that actually broke.
    //
    // That is exactly what had been happening (found 2026-09-14). The
    // ChatPage take-back test was given `waitFor(..., { timeout: 5000 })`
    // on 2026-09-12 to survive the full suite — and 5000 is also vitest's
    // default testTimeout, so the test was killed at the same instant its
    // wait was allowed to run out. It reddened perhaps one run in four,
    // always in the full suite and never alone, and said nothing useful
    // when it did.
    //
    // Fifteen seconds costs nothing on a passing run and buys a real error
    // message on a failing one, against a suite whose whole wall clock is
    // about ten seconds.
    testTimeout: 15000,
  },
})
