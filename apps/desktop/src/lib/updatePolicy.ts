/** Hosts electron-updater needs for the GitHub provider (release metadata + asset downloads). */
export const UPDATE_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * Auto-update is opt-in and off by default. It only runs when ALL hold:
 * - packaged build (never from a dev checkout);
 * - product.json `autoUpdate: true`;
 * - electron-builder generated `app-update.yml` (only happens when a publish provider is configured, i.e. CI
 *   release builds with ALTV_PUBLISH=github);
 * - the build is code-signed (macOS Squirrel refuses unsigned updates; on Windows electron-updater verifies the
 *   installer's Authenticode publisher against the running app);
 * - the user has not disabled it with ALTV_DISABLE_UPDATES=1.
 */
export function shouldEnableAutoUpdate(i: {
  isPackaged: boolean;
  productAutoUpdate: boolean;
  hasUpdateConfig: boolean;
  isSigned: boolean;
  env: Record<string, string | undefined>;
}): boolean {
  if (i.env.ALTV_DISABLE_UPDATES === '1') return false;
  return i.isPackaged && i.productAutoUpdate && i.hasUpdateConfig && i.isSigned;
}
