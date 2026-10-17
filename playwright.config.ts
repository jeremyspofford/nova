import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// E2E journeys run against a real Hub serving the built web UI (docs/16 §3.3).
const port = Number(process.env.NOVA_E2E_PORT ?? 7499);
export const E2E_DATA_DIR = process.env.NOVA_E2E_DATA_DIR ?? join(tmpdir(), `nova-e2e-${port}`);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/e2e-hub.mjs`,
    url: `http://127.0.0.1:${port}/api/v1/health`,
    reuseExistingServer: false,
    env: { NOVA_PORT: String(port), NOVA_DATA_DIR: E2E_DATA_DIR, NOVA_PORT_FALLBACKS: '0' },
    stdout: 'pipe',
  },
});
