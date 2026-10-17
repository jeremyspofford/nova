import { defineConfig } from 'vitest/config';

// Security-sensitive module: 90 % branch coverage floor (AGENTS.md §6).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { branches: 90, lines: 90, functions: 90, statements: 90 },
    },
  },
});
