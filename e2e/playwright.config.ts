import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Server port (`E2E_PORT`, default 8799). The SQLite file and the results folder are named after it, so runs on
 * different ports (e.g. from parallel worktrees or checkouts) never share a server, a database or an output dir.
 */
const PORT = Number(process.env.E2E_PORT ?? 8799);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`E2E_PORT must be a TCP port, got ${process.env.E2E_PORT}`);
const DB_FILE = `e2e-${PORT}.db`;
const BASE_URL = `http://localhost:${PORT}`;
/** Repo root: the web server runs from here so `apps/server/dist` and `test-results/` resolve. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './tests',
  outputDir: `../test-results/e2e-${PORT}`,
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
    command: `pnpm build && node e2e/reset-db.mjs test-results ${DB_FILE} && node apps/server/dist/main.js`,
    cwd: ROOT,
    env: {
      CHARTMATE_PROVIDERS: 'fixture',
      DATABASE_URL: `sqlite:./test-results/${DB_FILE}`,
      PORT: String(PORT),
      CHARTMATE_PASSWORD: '',
    },
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
