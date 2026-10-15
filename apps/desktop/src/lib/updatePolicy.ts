/** The session partition electron-updater downloads through (its NET_SESSION_NAME; pinned by a test). */
export const UPDATE_PARTITION = 'electron-updater';

/** Hosts electron-updater needs for the GitHub provider (release metadata + asset downloads). */
export const UPDATE_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * Request filter of the updater's partition: HTTPS only, default port, no URL credentials, exact GitHub hosts. Every
 * redirect hop goes through it again.
 */
export function isUpdateRequestAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' && UPDATE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

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
 * Whether the updater may offer pre-releases: only to a pre-release build (`1.1.0-beta.1`). Releases are published
 * as GitHub pre-releases exactly when their tag has a suffix, so a full release only ever updates to full releases.
 */
export function allowsPrereleaseUpdates(version: string): boolean {
  return version.includes('-');
}

/** Why updates do or do not run in this build. */
export type UpdateAvailability = 'enabled' | 'disabled-by-env' | 'unsigned' | 'unavailable';

export interface UpdatePolicyInput {
  isPackaged: boolean;
  productAutoUpdate: boolean;
  isSigned: boolean;
  platform: NodeJS.Platform;
  /** Contents of resources/app-update.yml, or null when absent. */
  updateConfig: string | null;
  env: Record<string, string | undefined>;
}

/**
 * Auto-update runs (`enabled`) only when ALL hold:
 * - the user has not turned it off with CHARTMATE_DISABLE_UPDATES=1 (else `disabled-by-env`, whatever the build);
 * - the build is code-signed for THIS platform (decided at bundle time by build/signing.cjs; unsigned bundles do
 *   not even contain the updater), else `unsigned`;
 * - packaged build (never from a dev checkout), on macOS or Windows;
 * - product.json `autoUpdate: true`;
 * - electron-builder generated `app-update.yml` (publish provider configured at build time);
 * - on Windows, app-update.yml pins `publisherName` (Authenticode publisher check).
 * The last four fail as `unavailable`.
 */
export function updateAvailability(i: UpdatePolicyInput): UpdateAvailability {
  if (i.env.CHARTMATE_DISABLE_UPDATES === '1') return 'disabled-by-env';
  if (!i.isSigned) return 'unsigned';
  if (!i.isPackaged || !i.productAutoUpdate || i.updateConfig === null) return 'unavailable';
  if (i.platform === 'darwin') return 'enabled';
  if (i.platform === 'win32' && hasWindowsPublisher(i.updateConfig)) return 'enabled';
  return 'unavailable';
}

export function shouldEnableAutoUpdate(i: UpdatePolicyInput): boolean {
  return updateAvailability(i) === 'enabled';
}
