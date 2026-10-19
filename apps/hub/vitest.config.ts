import { defineConfig } from 'vitest/config';

// Coverage floor for the Hub service (AGENTS.md §6: 70 % lines).
export default defineConfig({
  test: {
    // Hub tests build whole Hubs, start listeners and real processes; when every package tests
    // at once one can take well over Vitest's 5 s default. A real hang still fails (R-011).
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 70 },
    },
  },
});
