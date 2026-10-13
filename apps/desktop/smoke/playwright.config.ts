import { defineConfig } from '@playwright/test';

/**
 * Desktop smoke tests (Playwright + Electron). Targets:
 * - default: the unpackaged app (`electron apps/desktop`, run `pnpm --filter @altv/desktop bundle` first);
 * - SMOKE_APP=<path to Chartmate.app | chartmate.exe>: a packaged build. See smoke/README in the main README
 *   ("Desktop app → Smoke test") for why the packaged run uses an inspectable copy.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../../../test-results/desktop-smoke',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
});
