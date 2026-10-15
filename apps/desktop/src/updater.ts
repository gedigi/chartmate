// Auto-update (electron-updater, GitHub provider). Bundled separately (dist/updater.cjs) and only for builds signed
// for the target platform; loaded only when updateAvailability() says `enabled`.
// - Windows: the installer's Authenticode signature is checked by our fail-closed verifier (winSignature.ts) against
//   the publisher DN pinned at build time (__WIN_PUBLISHER_DN__), replacing electron-updater's default, which skips
//   the check when PowerShell cannot run.
// - macOS: before the zip is handed to Squirrel.Mac, its app's Info.plist version must match the release and be newer
//   (updateBundle.ts); Squirrel.Mac then checks the new app's code signature against the running app's designated
//   requirement.
// The UX is native dialogs and (macOS) menu items only (src/lib/updateController.ts): no IPC, no preload, nothing
// reaches the renderer.
import { execFile } from 'node:child_process';
import { app, BrowserWindow, dialog, session } from 'electron';
import { autoUpdater, type NsisUpdater } from 'electron-updater';
import type { ListenGuard } from './lib/listenGuard.js';
import type { RotatingLog } from './lib/logger.js';
import { isNewerVersion } from './lib/semver.js';
import { armOnUpdateDownloaded, type MacUpdaterLike } from './lib/updateArming.js';
import { checkDownloadedBundle } from './lib/updateBundle.js';
import { configureUpdater, createUpdateController, logLine, type UpdateController, type UpdaterPort } from './lib/updateController.js';
import { isUpdateRequestAllowed, UPDATE_PARTITION } from './lib/updatePolicy.js';
import { loadUpdateSettings, saveUpdateSettings } from './lib/updateSettings.js';
import { createWindowsSignatureVerifier, type ExecFile } from './lib/winSignature.js';

/** Publisher DN pinned at bundle time (CHARTMATE_WIN_PUBLISHER_DN), or ''. */
declare const __WIN_PUBLISHER_DN__: string;

const execFileAsync: ExecFile = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
});

export function startAutoUpdate(o: {
  log: RotatingLog;
  listenGuard: ListenGuard;
  appName: string;
  /** Directory of update-settings.json (the per-user data directory). */
  settingsDir: string;
  /** Called after "Check for Updates Automatically" was toggled, so the menu shows the new checkbox state. */
  onChange: () => void;
}): UpdateController {
  const { log } = o;
  const currentVersion = app.getVersion();
  // electron-updater downloads through its own session partition: restrict it to HTTPS GitHub hosts, every redirect
  // hop included, over direct connections (no system or PAC proxy, like provider traffic). TLS uses Chromium's
  // certificate verification with the operating system's trust store. (session-created already applied the
  // permission lockdown; this replaces the app-only request filter for this partition.) Set up before anything can
  // trigger a check.
  const s = session.fromPartition(UPDATE_PARTITION, { cache: false });
  void s.setProxy({ mode: 'direct' });
  s.webRequest.onBeforeRequest((details, callback) => {
    const ok = isUpdateRequestAllowed(details.url);
    if (!ok) log.warn('blocked updater request');
    callback({ cancel: !ok });
  });

  // macOS: electron-updater serves the downloaded zip to Squirrel.Mac from a one-off 127.0.0.1 server. First the
  // bundle's real version is checked; only then is the listener guard armed for that hand-over (single use, 60 s).
  armOnUpdateDownloaded(autoUpdater as unknown as MacUpdaterLike, o.listenGuard, {
    platform: process.platform,
    onUnsupported: () => log.warn('updater: Squirrel.Mac hand-over hook not found; macOS updates will fail closed'),
    beforeHandOver: async (args) => {
      const event = (args[1] ?? {}) as { downloadedFile?: unknown; version?: unknown };
      if (typeof event.downloadedFile !== 'string') throw new Error('downloaded update file is missing');
      await checkDownloadedBundle(event.downloadedFile, { advertised: event.version, current: currentVersion });
    },
  });

  if (process.platform === 'win32') {
    (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = createWindowsSignatureVerifier({
      exec: execFileAsync,
      expectedDn: __WIN_PUBLISHER_DN__,
      log: (m) => log.warn(logLine(m)),
      baseEnv: process.env,
    });
  }

  autoUpdater.logger = {
    info: (m: unknown) => log.info(`updater: ${logLine(m)}`),
    warn: (m: unknown) => log.warn(`updater: ${logLine(m)}`),
    error: (m: unknown) => log.error(`updater: ${logLine(m)}`),
    debug: () => {},
  };
  configureUpdater(autoUpdater, currentVersion);
  // Belt and braces next to allowDowngrade = false: only a strictly newer, valid semver release is an update.
  autoUpdater.isUpdateSupported = (info) => isNewerVersion(info.version, currentVersion);

  const settings = loadUpdateSettings(o.settingsDir, (p) => log.warn(p));
  const controller = createUpdateController({
    updater: autoUpdater as unknown as UpdaterPort,
    dialog: {
      show: async (m) => {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const opts = { ...m, title: o.appName, noLink: true };
        if (parent && !parent.isDestroyed()) return (await dialog.showMessageBox(parent, opts)).response;
        // macOS with every window closed: bring the app forward so the prompt is not hidden behind other apps.
        if (process.platform === 'darwin') app.focus({ steal: false });
        return (await dialog.showMessageBox(opts)).response;
      },
    },
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    appName: o.appName,
    isMac: process.platform === 'darwin',
    currentVersion,
    automatic: settings.checkAutomatically,
    saveAutomatic: (on) => {
      if (!saveUpdateSettings(o.settingsDir, { checkAutomatically: on })) log.warn('update settings: could not be saved');
    },
    onChange: o.onChange,
  });
  // No background check may start while quitting (Restart now stops the schedule itself).
  app.on('before-quit', () => controller.stop());
  controller.start();
  return controller;
}
