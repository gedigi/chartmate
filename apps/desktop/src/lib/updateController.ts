import { releaseNotesText, safeVersion } from './releaseNotes.js';
import { allowsPrereleaseUpdates } from './updatePolicy.js';

/**
 * Update UX, entirely in the main process: native dialogs only, nothing reaches the renderer. Pure logic over
 * injected ports (electron-updater, dialogs, timers, log), so it is unit-tested with fakes.
 *
 * Phases: idle → checking → downloading → downloaded → installing (after Restart Now). Once an update is
 * downloaded, no further check runs (a new check would make electron-updater hand the zip to Squirrel.Mac again; the loopback
 * listener for that is single use per hand-over): "Check for Updates…" (macOS) then offers the restart again. An
 * error resets to idle so a later check can retry; it is reported in a dialog only when the user is waiting on the
 * outcome (a manual check, or Restart Now), worded by what failed (check, download or install), never with the raw
 * error. A version whose install failed is not offered again in the same session.
 */

export const STARTUP_CHECK_DELAY_MS = 15_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateInfoLike {
  version?: unknown;
  releaseNotes?: unknown;
}

/** The part of electron-updater's AppUpdater this uses. */
export interface UpdaterPort {
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  /** macOS only (see waitForInstallReady): Squirrel.Mac has fetched and verified the update. */
  on(event: 'install-ready', listener: () => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/** Native message box options (plain text; Electron never renders them as HTML). */
export interface MessageOptions {
  type: 'info' | 'error' | 'none';
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export interface DialogPort {
  /** Shows a message box; resolves with the index of the clicked button. */
  show(o: MessageOptions): Promise<number>;
}

export interface LogPort {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'installing';

export interface UpdateController {
  /** Starts the background schedule (if automatic checks are on). */
  start(): void;
  /** Stops the background schedule (the app is quitting). */
  stop(): void;
  /** "Check for Updates…" (macOS menu): reports the outcome in a dialog. */
  checkNow(): Promise<void>;
  setAutomatic(on: boolean): void;
  readonly automatic: boolean;
  readonly phase: UpdatePhase;
}

/** The settings of electron-updater that matter for safety; everything else stays at its defaults. */
export interface ConfigurableUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  forceDevUpdateConfig: boolean;
}

/**
 * Downloads automatically, installs on quit when the user picks "Later", refuses versions older than the running one
 * (as advertised by the release metadata; see updateBundle.ts for the macOS bundle check), offers pre-releases only
 * to pre-release builds, and never runs from an unpackaged app. `channel` is never set (setting it would allow
 * downgrades).
 */
export function configureUpdater(u: ConfigurableUpdater, currentVersion: string): void {
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  u.allowPrerelease = allowsPrereleaseUpdates(currentVersion);
  u.allowDowngrade = false;
  u.forceDevUpdateConfig = false;
}

/** One log line from untrusted text: CR, LF, U+2028 and U+2029 escaped (no forged log lines), capped. */
export function logLine(v: unknown): string {
  const text = v instanceof Error ? `${v.name}: ${v.message}` : String(v);
  return text
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .slice(0, 500);
}

/** How long "installing" may last before the app should have quit; then the state resets. */
export const INSTALL_WATCHDOG_MS = 60_000;

const FAILURE: Record<'checking' | 'downloading' | 'installing', { message: string; detail: string }> = {
  checking: { message: 'Couldn’t check for updates', detail: 'Check your internet connection and try again later. Details are in the log.' },
  downloading: { message: 'Couldn’t download the update', detail: 'It will be tried again later. Details are in the log.' },
  installing: {
    message: 'Couldn’t install the update',
    detail: 'Your current version keeps running. The update is offered again the next time the app starts. Details are in the log.',
  },
};

export function createUpdateController(o: {
  updater: UpdaterPort;
  dialog: DialogPort;
  log: LogPort;
  timers: TimerPort;
  appName: string;
  isMac: boolean;
  currentVersion: string;
  /**
   * macOS: electron-updater emits `update-downloaded` before Squirrel.Mac has fetched and verified the update, so
   * the restart prompt waits for `install-ready` (Squirrel.Mac's own `update-downloaded`). Off elsewhere.
   */
  waitForInstallReady?: boolean;
  automatic: boolean;
  saveAutomatic: (on: boolean) => void;
  /** Called after automatic checks were toggled (the menu checkbox is rebuilt). */
  onChange?: () => void;
  startupDelayMs?: number;
  intervalMs?: number;
}): UpdateController {
  const startupDelay = o.startupDelayMs ?? STARTUP_CHECK_DELAY_MS;
  const interval = o.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  let automatic = o.automatic;
  let phase: UpdatePhase = 'idle';
  /** The current check/download/hand-over was asked for by the user: report its outcome. */
  let manual = false;
  let version: string | null = null;
  let notes: string | null = null;
  let timer: unknown = null;
  let watchdog: unknown = null;
  let restartPromptOpen = false;
  /** The downloaded update can be installed now (Squirrel.Mac has it, or no hand-over is needed). */
  let installReady = false;
  /** An install failure arrived while the restart prompt was open: Restart Now reports it instead of installing. */
  let installFailedWhilePrompting = false;
  /** Versions whose install failed in this session: not offered again (no dead "Restart Now" every 6 hours). */
  const failedVersions = new Set<string>();

  const name = () => (version ? `${o.appName} ${version}` : null);

  const show = (m: MessageOptions): Promise<number> =>
    o.dialog.show(m).catch((err: unknown) => {
      o.log.error(`updater: dialog failed: ${logLine(err)}`);
      return m.cancelId;
    });

  const info = (message: string, detail: string) => show({ type: 'info', message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0 });
  const failure = (kind: keyof typeof FAILURE) => show({ type: 'error', ...FAILURE[kind], buttons: ['OK'], defaultId: 0, cancelId: 0 });

  function stopSchedule(): void {
    if (timer !== null) o.timers.clearTimeout(timer);
    timer = null;
  }

  function stopWatchdog(): void {
    if (watchdog !== null) o.timers.clearTimeout(watchdog);
    watchdog = null;
  }

  const remember = (i: UpdateInfoLike) => {
    version = safeVersion(i?.version);
    notes = releaseNotesText(i?.releaseNotes);
  };

  function fail(err: unknown): void {
    const failed: UpdatePhase = phase;
    o.log.error(`updater: ${failed === 'downloaded' ? 'install hand-over' : failed} failed: ${logLine(err)}`);
    stopWatchdog();
    // A failure after the download (macOS: Squirrel.Mac's hand-over; any platform: the install) marks the version.
    if ((failed === 'downloaded' || failed === 'installing') && version) failedVersions.add(version);
    if (failed === 'downloaded' && restartPromptOpen) installFailedWhilePrompting = true;
    // Who is waiting on the outcome: the user after a manual check (check, download or hand-over) or after
    // Restart Now. An error after a download nobody is waiting on stays in the log; the next check retries.
    const kind = failed === 'installing' ? 'installing'
      : manual && (failed === 'checking' || failed === 'downloading') ? failed
        : manual && failed === 'downloaded' ? 'installing'
          : null;
    manual = false;
    phase = 'idle';
    installReady = false;
    // Restart Now stopped the schedule; resume it so later versions are still found.
    if (automatic && timer === null) schedule(interval);
    if (kind) void failure(kind);
  }

  async function promptRestart(): Promise<void> {
    if (restartPromptOpen) return;
    restartPromptOpen = true;
    installFailedWhilePrompting = false;
    try {
      const tail = `Restart ${o.appName} to finish updating, or choose Later to install it the next time you quit.`;
      const choice = await show({
        type: 'info',
        message: name() ? `${name()} is ready to install` : `A new version of ${o.appName} is ready to install`,
        detail: notes ? `${notes}\n\n${tail}` : tail,
        buttons: [o.isMac ? 'Restart Now' : 'Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice !== 0) return;
      if (installFailedWhilePrompting) {
        // The hand-over failed while the prompt was open: installing now would silently do nothing.
        void failure('installing');
        return;
      }
      if (phase !== 'downloaded') return;
      o.log.info('updater: restarting to install the update');
      phase = 'installing';
      stopSchedule();
      // If the app has not quit after a minute, something went wrong without an error event: start over.
      watchdog = o.timers.setTimeout(() => {
        watchdog = null;
        if (phase !== 'installing') return;
        o.log.warn('updater: the app did not quit to install the update; resetting');
        if (version) failedVersions.add(version);
        phase = 'idle';
        installReady = false;
        if (automatic) schedule(interval);
      }, INSTALL_WATCHDOG_MS);
      // A failure here (sync or later) arrives as an 'error' event and is reported as an install failure.
      o.updater.quitAndInstall();
    } finally {
      restartPromptOpen = false;
      installFailedWhilePrompting = false;
    }
  }

  /** The update is ready to install (Windows: downloaded; macOS: Squirrel.Mac has it too). */
  function readyToInstall(): void {
    manual = false;
    installReady = true;
    if (version && failedVersions.has(version)) {
      o.log.info(`updater: not offering ${version} again (its install failed in this session)`);
      return;
    }
    void promptRestart();
  }

  o.updater.on('update-available', (i) => {
    remember(i);
    o.log.info(`updater: update available (${version ?? 'unknown version'})`);
    phase = 'downloading';
    if (manual) {
      void info(
        name() ? `${name()} is available` : `A new version of ${o.appName} is available`,
        'It’s downloading in the background. You’ll be asked to restart when it’s ready.',
      );
    }
  });
  o.updater.on('update-not-available', () => {
    const wasManual = manual;
    manual = false;
    phase = 'idle';
    if (wasManual) void info('You’re up to date', `${o.appName} ${o.currentVersion} is the latest version.`);
  });
  o.updater.on('update-downloaded', (i) => {
    remember(i);
    o.log.info(`updater: update downloaded (${version ?? 'unknown version'})`);
    phase = 'downloaded';
    installReady = false;
    if (!o.waitForInstallReady) readyToInstall();
  });
  o.updater.on('install-ready', () => {
    if (!o.waitForInstallReady || phase !== 'downloaded') return;
    o.log.info('updater: update handed over and ready to install');
    if (version) failedVersions.delete(version);
    readyToInstall();
  });
  o.updater.on('error', (err) => {
    if (phase === 'idle') {
      o.log.warn(`updater: ${logLine(err)}`);
      return;
    }
    fail(err);
  });

  function runCheck(): void {
    phase = 'checking';
    o.updater.checkForUpdates().then(
      (result) => {
        // electron-updater also reports download failures as 'error' events; keep the promise from going unhandled.
        const download = (result as { downloadPromise?: unknown } | null)?.downloadPromise;
        if (download instanceof Promise) download.catch(() => {});
        // No result and no event: the updater is inactive (should not happen in a packaged, configured build).
        if (result == null && phase === 'checking') fail(new Error('update check returned no result'));
      },
      (err: unknown) => {
        // electron-updater also emits 'error' for this; report it only if that has not happened already.
        if (phase === 'checking') fail(err);
      },
    );
  }

  function schedule(ms: number): void {
    stopSchedule();
    timer = o.timers.setTimeout(() => {
      timer = null;
      if (!automatic) return;
      if (phase === 'idle') runCheck();
      schedule(interval);
    }, ms);
  }

  return {
    start() {
      if (automatic) schedule(startupDelay);
    },
    stop() {
      stopSchedule();
    },
    async checkNow() {
      switch (phase) {
        case 'downloaded':
          if (!installReady) {
            // Still being handed over to Squirrel.Mac: report how that ends.
            manual = true;
            return;
          }
          await promptRestart();
          return;
        case 'installing':
          return;
        case 'downloading':
          await info(
            name() ? `${name()} is downloading` : `A new version of ${o.appName} is downloading`,
            'You’ll be asked to restart when it’s ready.',
          );
          return;
        case 'checking':
          // A background check is already running: mark it as the user's, so its outcome is reported in a dialog.
          // That dialog appears only when the running check ends (at worst after electron-updater's request
          // timeout). Accepted: starting a second, parallel check would be worse.
          manual = true;
          return;
        default:
          manual = true;
          runCheck();
      }
    },
    setAutomatic(on: boolean) {
      automatic = on;
      o.saveAutomatic(on);
      if (on) schedule(startupDelay);
      else stopSchedule();
      o.onChange?.();
    },
    get automatic() {
      return automatic;
    },
    get phase() {
      return phase;
    },
  };
}
