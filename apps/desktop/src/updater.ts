// Auto-update (electron-updater, GitHub provider). Bundled separately (dist/updater.cjs) and only for builds signed
// for the target platform; loaded only when updateAvailability() says `enabled`. Signature checks stay at
// electron-updater's defaults: on Windows the installer's Authenticode publisher must match app-update.yml's
// publisherName (required by updatePolicy); on macOS Squirrel.Mac checks the new app's code signature against the
// running app's designated requirement. The UX is native dialogs and menu items only (src/lib/updateController.ts):
// no IPC, no preload, nothing reaches the renderer.
import { app, BrowserWindow, dialog, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { ListenGuard } from './lib/listenGuard.js';
import type { RotatingLog } from './lib/logger.js';
import { armOnUpdateDownloaded, type MacUpdaterLike } from './lib/updateArming.js';
import { configureUpdater, createUpdateController, type UpdateController, type UpdaterPort } from './lib/updateController.js';
import { isUpdateRequestAllowed, UPDATE_PARTITION } from './lib/updatePolicy.js';
import { loadUpdateSettings, saveUpdateSettings } from './lib/updateSettings.js';

export function startAutoUpdate(o: {
  log: RotatingLog;
  listenGuard: ListenGuard;
  appName: string;
  /** Directory of update-settings.json (the per-user data directory). */
  settingsDir: string;
  /** Called when the menu should be rebuilt (automatic checks toggled, phase changed). */
  onChange: () => void;
}): UpdateController {
  const { log } = o;
  // electron-updater downloads through its own session partition: restrict it to HTTPS GitHub hosts, every redirect
  // hop included. (session-created already applied the permission lockdown; this replaces the app-only request
  // filter for this partition.) Installed before anything can trigger a check.
  const s = session.fromPartition(UPDATE_PARTITION, { cache: false });
  s.webRequest.onBeforeRequest((details, callback) => {
    const ok = isUpdateRequestAllowed(details.url);
    if (!ok) log.warn('blocked updater request');
    callback({ cancel: !ok });
  });

  // macOS: electron-updater serves the downloaded zip to Squirrel.Mac from a one-off 127.0.0.1 server. The listener
  // guard is armed only for that hand-over, after the download has completed (single use, 60 s).
  armOnUpdateDownloaded(autoUpdater as unknown as MacUpdaterLike, o.listenGuard, {
    platform: process.platform,
    onUnsupported: () => log.warn('updater: Squirrel.Mac hand-over hook not found; macOS updates will fail closed'),
  });

  autoUpdater.logger = {
    info: (m: unknown) => log.info(`updater: ${String(m).slice(0, 500)}`),
    warn: (m: unknown) => log.warn(`updater: ${String(m).slice(0, 500)}`),
    error: (m: unknown) => log.error(`updater: ${String(m).slice(0, 500)}`),
    debug: () => {},
  };
  configureUpdater(autoUpdater, app.getVersion());

  const settings = loadUpdateSettings(o.settingsDir, (p) => log.warn(p));
  const controller = createUpdateController({
    updater: autoUpdater as unknown as UpdaterPort,
    dialog: {
      show: async (m) => {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const opts = { ...m, title: o.appName, noLink: true };
        const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        return r.response;
      },
    },
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    appName: o.appName,
    isMac: process.platform === 'darwin',
    currentVersion: app.getVersion(),
    automatic: settings.checkAutomatically,
    saveAutomatic: (on) => {
      if (!saveUpdateSettings(o.settingsDir, { checkAutomatically: on })) log.warn('update settings: could not be saved');
    },
    onChange: o.onChange,
  });
  controller.start();
  return controller;
}
