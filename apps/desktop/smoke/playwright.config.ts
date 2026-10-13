import { defineConfig } from '@playwright/test';

/**
 * Desktop smoke tests (Playwright + Electron). Targets:
 * - default: the unpackaged app (`electron apps/desktop`, run `pnpm --filter @chartmate/desktop bundle` first);
 * - SMOKE_APP=<TEST-ONLY copy from smoke/prepare-inspectable.mjs>: a packaged build, driven over CDP;
 * - SMOKE_HARDENED_APP=<the unmodified packaged app>: packaged-hardening.spec.ts.
 * See the README, "Desktop app → Smoke tests", for the env vars and why the packaged run uses an inspectable copy.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../../../test-results/desktop-smoke',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  // A hung Electron process must fail the run with a report, not stall CI until the job timeout.
  globalTimeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
});
