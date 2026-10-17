import { defineConfig } from 'vitest/config';

// Coverage floor (AGENTS.md §6: 70 % lines for core services).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 70 },
    },
  },
});
