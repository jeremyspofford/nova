import { defineConfig, devices } from '@playwright/test'
import { config } from './lib/env'

/**
 * One worker, one order, no parallelism — deliberately.
 *
 * These are not isolated unit tests: scenario 1 mints the owner and installs
 * the model, scenario 2 says something worth remembering, scenario 3 restarts
 * the whole stack underneath the browser. They are five steps of one walk
 * through one live instance, so they run in file-name order in a single
 * worker and share the session cookie scenario 1 saved.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  // A retry would re-run a step whose side effects already happened (the owner
  // exists, the model is installed). A red result here is a fact to read, not
  // a flake to paper over.
  retries: 0,
  timeout: 3 * 60 * 1000,
  expect: { timeout: 15_000 },
  outputDir: './test-results',
  // Baselines live beside the suite so a first run can create them and every
  // later run diffs against them.
  snapshotPathTemplate: '{testDir}/../__screenshots__/{arg}{ext}',
  updateSnapshots: 'missing',
  reporter: [
    ['list'],
    ['html', { outputFolder: './playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: config.baseUrl,
    // Every run leaves a trace zip, passing or failing: "it worked" is a claim,
    // the trace is the fact.
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
})
