import { load } from 'js-yaml';
import { isPrereleaseVersion } from './semver.js';
import { isPinnedPublisherDn } from './winSignature.js';

/** The session partition electron-updater downloads through (its NET_SESSION_NAME; pinned by a test). */
export const UPDATE_PARTITION = 'electron-updater';

/**
 * Hosts electron-updater's public GitHub provider actually contacts: github.com (releases feed, latest-release
 * lookup, asset downloads), then the asset CDN hosts GitHub redirects downloads to. Not api.github.com: the public
 * provider only uses it for a custom `host` (pinned by a test against the installed electron-updater).
 */
export const UPDATE_HOSTS: readonly string[] = Object.freeze([
  'github.com',
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
 * True when electron-builder's app-update.yml (parsed as YAML) names a Windows publisher: a non-empty string or a
 * non-empty list of non-empty strings at the top level. electron-updater calls the installer signature verifier
 * only when this is set, so updates are refused without it.
 */
export function hasWindowsPublisher(appUpdateYml: string): boolean {
  let doc: unknown;
  try {
    doc = load(appUpdateYml);
  } catch {
    return false;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const v = (doc as Record<string, unknown>).publisherName;
  const ok = (x: unknown) => typeof x === 'string' && x.trim() !== '';
  return ok(v) || (Array.isArray(v) && v.length > 0 && v.every(ok));
}

/**
 * Whether the updater may offer pre-releases: only to a pre-release build (`1.1.0-beta.1`). Releases are published
 * as GitHub pre-releases exactly when their tag has a suffix, so a full release only ever updates to full releases.
 */
export function allowsPrereleaseUpdates(version: string): boolean {
  return isPrereleaseVersion(version);
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
  /** Windows publisher DN pinned at build time (CHARTMATE_WIN_PUBLISHER_DN), or ''. */
  winPublisherDn: string;
}

/**
 * Auto-update runs (`enabled`) only when ALL hold:
 * - the user has not turned it off with CHARTMATE_DISABLE_UPDATES=1 (else `disabled-by-env`, whatever the build);
 * - the build is code-signed for THIS platform (decided at bundle time by build/signing.cjs; unsigned bundles do
 *   not even contain the updater), else `unsigned`;
 * - packaged build (never from a dev checkout), on macOS or Windows;
 * - product.json `autoUpdate: true`;
 * - electron-builder generated `app-update.yml` (publish provider configured at build time);
 * - on Windows, app-update.yml names `publisherName` (so the signature verifier runs at all) and the build pins
 *   the publisher's DN (CN, O and C) that the fail-closed verifier checks (winSignature.ts).
 * The last four fail as `unavailable`.
 */
export function updateAvailability(i: UpdatePolicyInput): UpdateAvailability {
  if (i.env.CHARTMATE_DISABLE_UPDATES === '1') return 'disabled-by-env';
  if (!i.isSigned) return 'unsigned';
  if (!i.isPackaged || !i.productAutoUpdate || i.updateConfig === null) return 'unavailable';
  if (i.platform === 'darwin') return 'enabled';
  if (i.platform === 'win32' && hasWindowsPublisher(i.updateConfig) && isPinnedPublisherDn(i.winPublisherDn)) return 'enabled';
  return 'unavailable';
}

export function shouldEnableAutoUpdate(i: UpdatePolicyInput): boolean {
  return updateAvailability(i) === 'enabled';
}
