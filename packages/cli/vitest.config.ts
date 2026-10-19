import { defineConfig } from 'vitest/config';

// The `nova` command (AGENTS.md §6: 70 % lines).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts'],
      thresholds: { lines: 70 },
    },
  },
});
