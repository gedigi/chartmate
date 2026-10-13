// Auto-update (electron-updater, GitHub provider). Bundled separately (dist/updater.cjs) and loaded only when
// shouldEnableAutoUpdate() allows it. Signature verification stays at electron-updater's defaults.
import { session } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { RotatingLog } from './lib/logger.js';
import { UPDATE_HOSTS } from './lib/updatePolicy.js';

export function startAutoUpdate(log: RotatingLog): void {
  // electron-updater uses its own session partition: restrict it to HTTPS GitHub hosts.
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
  autoUpdater.logger = { info: (m: unknown) => log.info(`updater: ${String(m)}`), warn: (m: unknown) => log.warn(`updater: ${String(m)}`), error: (m: unknown) => log.error(`updater: ${String(m)}`), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => log.error('update check failed', err));
}
