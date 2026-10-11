import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;
const BASE_URL = `http://localhost:${PORT}`;
/** Repo root: the web server runs from here so `apps/server/dist` and `test-results/` resolve. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './tests',
  outputDir: '../test-results/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // Build, wipe the previous run's SQLite file, then start the built server in fixture mode (no live network).
    command: 'pnpm build && node e2e/reset-db.mjs test-results && node apps/server/dist/main.js',
    cwd: ROOT,
    env: {
      ALTV_PROVIDERS: 'fixture',
      DATABASE_URL: 'sqlite:./test-results/e2e.db',
      PORT: String(PORT),
      ALTV_PASSWORD: '',
    },
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
