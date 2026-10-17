import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx'],
      reporter: ['text-summary', 'text'],
      // AGENTS.md §6: apps/web keeps at least 70 % line coverage.
      thresholds: { lines: 70 },
    },
  },
});
