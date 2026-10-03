import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/web',
  testMatch: '**/*.spec.ts',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  use: { ...devices['Desktop Chrome'], headless: true },
  projects: [{ name: 'chromium' }],
});
