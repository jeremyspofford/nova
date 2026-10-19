import { defineConfig } from 'vitest/config';

// Coverage floor for services (AGENTS.md §6: 70 % lines).
export default defineConfig({
  test: {
    // Sandboxed commands, clones and caps take real seconds.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts'],
      thresholds: { lines: 70 },
    },
  },
});
