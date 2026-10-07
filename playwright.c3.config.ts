import { defineConfig, devices } from '@playwright/test';

/**
 * C3 four-mode matrix runner: NO global webServer — the spec itself spawns
 * real `next start` servers per mode with explicit isolated environments and
 * proves each mode through the live runtime probe before any page case.
 */
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /c3-(mode-matrix|browser-preservation)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3110',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
