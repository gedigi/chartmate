import type { MenuItemConstructorOptions } from 'electron';
import { updateMenuItems, type UpdateMenuOptions } from './updateMenu.js';

/**
 * Application menu. macOS gets the standard app/Edit/View/Window menus (Edit is what makes ⌘C/⌘V/⌘A work in
 * text fields); Windows gets Edit/View/Window under a File menu. DevTools entries exist only in unhardened development runs.
 * The update items (`updates`) go under About in the macOS app menu. Windows gets none: its frameless window has
 * no visible menu bar, so they would be unreachable there.
 */
export function menuTemplate(opts: { isMac: boolean; hardened: boolean; appName: string; updates?: UpdateMenuOptions }): MenuItemConstructorOptions[] {
  const updates = opts.isMac && opts.updates ? updateMenuItems(opts.updates) : [];
  const view: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    ...(opts.hardened ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  return [
    ...(opts.isMac
      ? [{
        label: opts.appName,
        submenu: [
          { role: 'about' }, ...updates, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
        ],
      } as MenuItemConstructorOptions]
      : [{ label: 'File', submenu: [{ role: 'quit' }] } as MenuItemConstructorOptions]),
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { role: 'windowMenu' },
  ];
}
