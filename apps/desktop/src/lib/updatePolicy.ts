import { brandEnv } from '../../../server/src/brandEnv.js';

/** Hosts electron-updater needs for the GitHub provider (release metadata + asset downloads). */
export const UPDATE_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * True when electron-builder's app-update.yml pins the Windows publisher. electron-updater then refuses an
 * installer whose Authenticode signature is not from that publisher; without it, it would accept any (or no)
 * signature, so updates are refused instead.
 */
export function hasWindowsPublisher(appUpdateYml: string): boolean {
  const m = /^publisherName:\s*(.*)$/m.exec(appUpdateYml);
  if (!m) return false;
  const inline = m[1]!.trim();
  if (inline !== '' && inline !== '[]' && inline !== 'null' && inline !== '~') return true;
  // YAML list form: "publisherName:\n  - CN=…"
  const after = appUpdateYml.slice(m.index + m[0].length);
  return /^\n\s+-\s+\S/.test(after);
}

/**
 * Auto-update is opt-in and off by default. It only runs when ALL hold:
 * - the build is code-signed for THIS platform (decided at bundle time by build/signing.cjs; unsigned bundles do
 *   not even contain the updater);
 * - packaged build (never from a dev checkout), on macOS or Windows;
 * - product.json `autoUpdate: true`;
 * - electron-builder generated `app-update.yml` (publish provider configured at build time);
 * - on Windows, app-update.yml pins `publisherName` (Authenticode publisher check);
 * - the user has not disabled it with CHARTMATE_DISABLE_UPDATES=1 (legacy ALTV_DISABLE_UPDATES=1 also works).
 */
export function shouldEnableAutoUpdate(i: {
  isPackaged: boolean;
  productAutoUpdate: boolean;
  isSigned: boolean;
  platform: NodeJS.Platform;
  /** Contents of resources/app-update.yml, or null when absent. */
  updateConfig: string | null;
  env: Record<string, string | undefined>;
}): boolean {
  if (brandEnv(i.env, 'DISABLE_UPDATES') === '1') return false;
  if (!i.isSigned || !i.isPackaged || !i.productAutoUpdate || i.updateConfig === null) return false;
  if (i.platform === 'darwin') return true;
  if (i.platform === 'win32') return hasWindowsPublisher(i.updateConfig);
  return false;
}
