import { releaseNotesText, safeVersion } from './releaseNotes.js';
import { allowsPrereleaseUpdates } from './updatePolicy.js';

/**
 * Update UX, entirely in the main process: native dialogs only, nothing reaches the renderer. Pure logic over
 * injected ports (electron-updater, dialogs, timers, log), so it is unit-tested with fakes.
 *
 * Phases: idle → checking → downloading → downloaded. Once an update is downloaded, no further check runs (a new
 * check would make electron-updater hand the zip to Squirrel.Mac again; the loopback listener for that is single
 * use per hand-over): "Check for updates" then re-offers the restart. An error resets to idle so a later check can
 * retry.
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

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'downloaded';

export interface UpdateController {
  /** Starts the background schedule (if automatic checks are on). */
  start(): void;
  /** "Check for updates": always available; reports the outcome in a dialog. */
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
 * Downloads automatically, installs on quit when the user picks "Later", never downgrades, offers pre-releases only
 * to pre-release builds, and never runs from an unpackaged app. `channel` is never set (setting it would allow
 * downgrades), and signature verification is left at electron-updater's defaults.
 */
export function configureUpdater(u: ConfigurableUpdater, currentVersion: string): void {
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  u.allowPrerelease = allowsPrereleaseUpdates(currentVersion);
  u.allowDowngrade = false;
  u.forceDevUpdateConfig = false;
}

/** First line of an error message, capped, for the log only (never shown in a dialog). */
function errorSummary(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split('\n')[0] ?? '').slice(0, 300);
}

export function createUpdateController(o: {
  updater: UpdaterPort;
  dialog: DialogPort;
  log: LogPort;
  timers: TimerPort;
  appName: string;
  isMac: boolean;
  currentVersion: string;
  automatic: boolean;
  saveAutomatic: (on: boolean) => void;
  onChange?: () => void;
  startupDelayMs?: number;
  intervalMs?: number;
}): UpdateController {
  const startupDelay = o.startupDelayMs ?? STARTUP_CHECK_DELAY_MS;
  const interval = o.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const t = (mac: string, win: string) => (o.isMac ? mac : win);
  let automatic = o.automatic;
  let phase: UpdatePhase = 'idle';
  /** The current check/download was asked for by the user: report its outcome. */
  let manual = false;
  let version: string | null = null;
  let notes: string | null = null;
  let timer: unknown = null;
  let restartPromptOpen = false;

  const name = () => (version ? `${o.appName} ${version}` : null);

  const show = (m: MessageOptions): Promise<number> =>
    o.dialog.show(m).catch((err: unknown) => {
      o.log.error(`updater: dialog failed: ${errorSummary(err)}`);
      return m.cancelId;
    });

  const info = (message: string, detail: string) => show({ type: 'info', message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0 });

  const setPhase = (p: UpdatePhase) => {
    phase = p;
  };

  const remember = (i: UpdateInfoLike) => {
    version = safeVersion(i?.version);
    notes = releaseNotesText(i?.releaseNotes);
  };

  function fail(err: unknown): void {
    o.log.error(`updater: ${phase === 'downloaded' ? 'install hand-over' : phase} failed: ${errorSummary(err)}`);
    const wasManual = manual;
    manual = false;
    setPhase('idle');
    if (wasManual) {
      void show({
        type: 'error',
        message: 'Couldn’t check for updates',
        detail: 'Check your internet connection and try again later. Details are in the log.',
        buttons: ['OK'], defaultId: 0, cancelId: 0,
      });
    }
  }

  async function promptRestart(): Promise<void> {
    if (restartPromptOpen) return;
    restartPromptOpen = true;
    try {
      const tail = `Restart ${o.appName} to finish updating, or choose Later to install it the next time you quit.`;
      const choice = await show({
        type: 'info',
        message: name() ? `${name()} is ready to install` : `A new version of ${o.appName} is ready to install`,
        detail: notes ? `${notes}\n\n${tail}` : tail,
        buttons: [t('Restart Now', 'Restart now'), 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice === 0 && phase === 'downloaded') {
        o.log.info('updater: restarting to install the update');
        o.updater.quitAndInstall();
      }
    } finally {
      restartPromptOpen = false;
    }
  }

  o.updater.on('update-available', (i) => {
    remember(i);
    o.log.info(`updater: update available (${version ?? 'unknown version'})`);
    setPhase('downloading');
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
    setPhase('idle');
    if (wasManual) void info('You’re up to date', `${o.appName} ${o.currentVersion} is the latest version.`);
  });
  o.updater.on('update-downloaded', (i) => {
    remember(i);
    o.log.info(`updater: update downloaded (${version ?? 'unknown version'})`);
    manual = false;
    setPhase('downloaded');
    void promptRestart();
  });
  o.updater.on('error', (err) => {
    if (phase === 'idle') {
      o.log.warn(`updater: ${errorSummary(err)}`);
      return;
    }
    fail(err);
  });

  function runCheck(): void {
    setPhase('checking');
    o.updater.checkForUpdates().then(
      (result) => {
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
    if (timer !== null) o.timers.clearTimeout(timer);
    timer = o.timers.setTimeout(() => {
      timer = null;
      if (!automatic) return;
      if (phase === 'idle') runCheck();
      schedule(interval);
    }, ms);
  }

  function stopSchedule(): void {
    if (timer !== null) o.timers.clearTimeout(timer);
    timer = null;
  }

  return {
    start() {
      if (automatic) schedule(startupDelay);
    },
    async checkNow() {
      switch (phase) {
        case 'downloaded':
          await promptRestart();
          return;
        case 'downloading':
          await info(
            name() ? `${name()} is downloading` : `A new version of ${o.appName} is downloading`,
            'You’ll be asked to restart when it’s ready.',
          );
          return;
        case 'checking':
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
