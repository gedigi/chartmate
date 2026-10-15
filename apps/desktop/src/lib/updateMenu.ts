import type { MenuItemConstructorOptions } from 'electron';
import type { MessageOptions } from './updateController.js';
import type { UpdateAvailability } from './updatePolicy.js';

/**
 * The update items of the native macOS app menu (under About). Native macOS menu items and dialog buttons use the
 * platform's title case. Windows gets none: its frameless window (title bar overlay) shows no menu bar, so a menu
 * item there would be unreachable; Windows updates run in the background only.
 */
export type UpdateMenuState =
  | { kind: 'enabled'; automatic: boolean }
  | { kind: Exclude<UpdateAvailability, 'enabled'> };

export interface UpdateMenuOptions {
  state: UpdateMenuState;
  onCheck: () => void;
  onToggleAutomatic: (on: boolean) => void;
}

export function updateMenuItems(o: UpdateMenuOptions): MenuItemConstructorOptions[] {
  const check = 'Check for Updates…';
  switch (o.state.kind) {
    case 'enabled':
      return [
        { label: check, click: () => o.onCheck() },
        {
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: o.state.automatic,
          click: (item) => o.onToggleAutomatic(item.checked),
        },
      ];
    case 'disabled-by-env':
      return [
        { label: check, enabled: false },
        { label: 'Updates turned off by CHARTMATE_DISABLE_UPDATES', enabled: false },
      ];
    default:
      // Unsigned or not configured: still clickable, and the click explains (see unsupportedUpdateMessage).
      return [{ label: check, click: () => o.onCheck() }];
  }
}

/** The dialog shown by "Check for Updates…" (macOS) when this build cannot update itself. Plain text only. */
export function unsupportedUpdateMessage(
  kind: 'unsigned' | 'unavailable',
  o: { appName: string; hasReleasesPage: boolean },
): MessageOptions {
  const download = o.hasReleasesPage
    ? 'Download new versions from the releases page and install them over this one. Your data is kept.'
    : 'Download new versions from the project’s releases page and install them over this one. Your data is kept.';
  const buttons = o.hasReleasesPage ? ['Open Releases Page', 'Close'] : ['OK'];
  const common = { type: 'info' as const, buttons, defaultId: 0, cancelId: buttons.length - 1 };
  return kind === 'unsigned'
    ? { ...common, message: 'Automatic updates need a signed build', detail: `This copy of ${o.appName} is not code-signed, so it cannot update itself. ${download}` }
    : { ...common, message: 'Automatic updates are not available in this build', detail: download };
}

/**
 * Starts the updater (sync or async) without ever taking the app down with it: a failure (say, updater.cjs cannot
 * load, or its session cannot be set up) is reported through `onError`, and the app keeps running with updates
 * `unavailable`.
 */
export async function startUpdatesSafely<T>(
  start: () => T | null | Promise<T | null>,
  onError: (err: unknown) => void,
): Promise<{ controller: T | null; availability: 'enabled' | 'unavailable' }> {
  try {
    const controller = await start();
    return controller ? { controller, availability: 'enabled' } : { controller: null, availability: 'unavailable' };
  } catch (err) {
    onError(err);
    return { controller: null, availability: 'unavailable' };
  }
}
