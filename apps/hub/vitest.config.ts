import { defineConfig } from 'vitest/config';

// Coverage floor for the Hub service (AGENTS.md §6: 70 % lines).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 70 },
    },
  },
});
