import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against a *production build* served statically, because the
 * behaviour that matters most — the service worker, and therefore offline
 * trading — does not exist in the dev server.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
