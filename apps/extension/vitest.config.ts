import { defineConfig } from 'vitest/config';

// The extension's logic runs against a fake chrome.* API (test/fake-chrome.ts); the entry files
// only hand the real `chrome` to it and wire the pages' buttons. Coverage floor: AGENTS.md §6.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/background.ts', 'src/popup.ts', 'src/prompt.ts', 'src/chrome.ts'],
      thresholds: { lines: 70 },
    },
  },
});
