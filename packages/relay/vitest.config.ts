import { defineConfig } from 'vitest/config';

// Security-sensitive protocol code: sealing, framing, replay windows (AGENTS.md §6).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
