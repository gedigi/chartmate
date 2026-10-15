import type { MenuItemConstructorOptions } from 'electron';
import type { MessageOptions } from './updateController.js';
import type { UpdateAvailability } from './updatePolicy.js';

/**
 * The update items of the native application menu (macOS: app menu, under About; Windows: Help menu). Labels follow
 * each platform's menu capitalization: title case on macOS, sentence case on Windows.
 */
export type UpdateMenuState =
  | { kind: 'enabled'; automatic: boolean }
  | { kind: Exclude<UpdateAvailability, 'enabled'> };

export interface UpdateMenuOptions {
  state: UpdateMenuState;
  onCheck: () => void;
  onToggleAutomatic: (on: boolean) => void;
}

export function updateMenuItems(isMac: boolean, o: UpdateMenuOptions): MenuItemConstructorOptions[] {
  const check = isMac ? 'Check for Updates…' : 'Check for updates…';
  switch (o.state.kind) {
    case 'enabled':
      return [
        { label: check, click: () => o.onCheck() },
        {
          label: isMac ? 'Check for Updates Automatically' : 'Check for updates automatically',
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

/** The dialog shown by "Check for updates" when this build cannot update itself. Plain text only. */
export function unsupportedUpdateMessage(
  kind: 'unsigned' | 'unavailable',
  o: { appName: string; isMac: boolean; hasReleasesPage: boolean },
): MessageOptions {
  const download = o.hasReleasesPage
    ? 'Download new versions from the releases page and install them over this one. Your data is kept.'
    : 'Download new versions from the project’s releases page and install them over this one. Your data is kept.';
  const buttons = o.hasReleasesPage ? [o.isMac ? 'Open Releases Page' : 'Open releases page', 'Close'] : ['OK'];
  const common = { type: 'info' as const, buttons, defaultId: 0, cancelId: buttons.length - 1 };
  return kind === 'unsigned'
    ? { ...common, message: 'Automatic updates need a signed build', detail: `This copy of ${o.appName} is not code-signed, so it cannot update itself. ${download}` }
    : { ...common, message: 'Automatic updates are not available in this build', detail: download };
}
