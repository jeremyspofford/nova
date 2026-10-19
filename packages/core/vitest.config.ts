import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many core tests run real git, sandbox and helper processes; when every package tests at
    // once (npm test, CI) one can take well over Vitest's 5 s default. A real hang still fails
    // (R-011).
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 70 },
    },
  },
});
