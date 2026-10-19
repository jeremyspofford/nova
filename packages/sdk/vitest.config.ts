import { defineConfig } from 'vitest/config';

// The SDK's test host mirrors the runtime's permission checks (AGENTS.md §6).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 80 },
    },
  },
});
