import { defineConfig } from 'vitest/config';

// Unit and integration tests of the shell's pure parts; the Electron glue (main.ts, electron/,
// preloads, pages) runs only inside Electron and is covered by the Playwright Electron journey
// (`npm run test:shell`, e2e/). Coverage floor: AGENTS.md §6, 70 % lines.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/electron/**'],
      thresholds: { lines: 70 },
    },
  },
});
