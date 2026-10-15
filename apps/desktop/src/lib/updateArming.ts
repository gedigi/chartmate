import type { ListenGuard } from './listenGuard.js';

/** The part of electron-updater's MacUpdater this relies on: it opens the Squirrel.Mac proxy server here. */
export interface MacUpdaterLike {
  updateDownloaded?: (...args: unknown[]) => Promise<unknown>;
}

/** How long the single loopback listener may take to open once the downloaded update is handed over. */
export const ARM_WINDOW_MS = 60_000;

/**
 * Arms the listener guard exactly when electron-updater's MacUpdater starts serving an already *downloaded* update
 * to Squirrel.Mac (its `updateDownloaded` method creates the loopback server and calls listen() right away), so
 * slow downloads cannot outlast the window, and disarms when that step finishes or fails. Single use either way.
 * Returns false (and changes nothing) off macOS or if the updater does not have that method, in which case the
 * listener stays refused and a macOS update install fails closed.
 */
export function armOnUpdateDownloaded(
  updater: MacUpdaterLike,
  guard: ListenGuard,
  opts: {
    platform: NodeJS.Platform;
    onUnsupported?: () => void;
    /**
     * Pre-install check of the downloaded update (gets updateDownloaded's arguments: zipFileInfo, then the event with
     * `downloadedFile` and `version`). Throwing refuses the update: the guard is never armed and Squirrel.Mac never
     * sees the file.
     */
    beforeHandOver?: (args: unknown[]) => Promise<void>;
  },
): boolean {
  if (opts.platform !== 'darwin') return false;
  const original = updater.updateDownloaded;
  if (typeof original !== 'function') {
    opts.onUnsupported?.();
    return false;
  }
  updater.updateDownloaded = async function armed(this: unknown, ...args: unknown[]) {
    await opts.beforeHandOver?.(args);
    const disarm = guard.armForUpdateInstall(ARM_WINDOW_MS);
    try {
      return await original.apply(this ?? updater, args);
    } finally {
      disarm();
    }
  };
  return true;
}
