import { defineConfig } from '@playwright/test';

// Native-shell journeys (docs/16 §3.3): Playwright's Electron support against a real Hub. Run
// with `npm run test:shell -w apps/desktop` (on Linux without a display it wraps itself in
// xvfb-run). The web UI must be built first (`npm run build -w apps/web`).
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: '../../test-results/shell',
  use: { trace: 'retain-on-failure' },
});
