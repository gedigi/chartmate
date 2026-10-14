// Auto-update (electron-updater, GitHub provider). Bundled separately (dist/updater.cjs) and only for builds signed
// for the target platform; loaded only when shouldEnableAutoUpdate() allows it. Signature checks stay at
// electron-updater's defaults: on Windows the installer's Authenticode publisher must match app-update.yml's
// publisherName (required by updatePolicy); on macOS Squirrel.Mac checks the new app's code signature against the
// running app's designated requirement.
import { app, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { ListenGuard } from './lib/listenGuard.js';
import { armOnUpdateDownloaded, type MacUpdaterLike } from './lib/updateArming.js';
import type { RotatingLog } from './lib/logger.js';
import { allowsPrereleaseUpdates, UPDATE_HOSTS } from './lib/updatePolicy.js';

export function startAutoUpdate(log: RotatingLog, listenGuard: ListenGuard): void {
  // electron-updater uses its own session partition: restrict it to HTTPS GitHub hosts. (session-created already
  // applied the permission lockdown; this replaces the app-only request filter for this partition.)
  const s = session.fromPartition('electron-updater', { cache: false });
  s.webRequest.onBeforeRequest((details, callback) => {
    let ok = false;
    try {
      const u = new URL(details.url);
      ok = u.protocol === 'https:' && UPDATE_HOSTS.includes(u.hostname);
    } catch { /* invalid → blocked */ }
    if (!ok) log.warn('blocked updater request');
    callback({ cancel: !ok });
  });

  // macOS: electron-updater serves the downloaded zip to Squirrel.Mac from a one-off 127.0.0.1 server. The listener
  // guard is armed only for that hand-over, after the download has completed (single use, 60 s).
  armOnUpdateDownloaded(autoUpdater as unknown as MacUpdaterLike, listenGuard, {
    platform: process.platform,
    onUnsupported: () => log.warn('updater: Squirrel.Mac hand-over hook not found; macOS updates will fail closed'),
  });

  autoUpdater.logger = {
    info: (m: unknown) => log.info(`updater: ${String(m)}`),
    warn: (m: unknown) => log.warn(`updater: ${String(m)}`),
    error: (m: unknown) => log.error(`updater: ${String(m)}`),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Only suffixed tags are published as GitHub pre-releases; a full release never updates to one.
  autoUpdater.allowPrerelease = allowsPrereleaseUpdates(app.getVersion());
  autoUpdater.allowDowngrade = false;
  autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => log.error('update check failed', err));
}
