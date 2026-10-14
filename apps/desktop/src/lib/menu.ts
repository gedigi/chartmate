import type { MenuItemConstructorOptions } from 'electron';

/**
 * Application menu. macOS gets the standard app/Edit/View/Window menus (Edit is what makes ⌘C/⌘V/⌘A work in
 * text fields); Windows gets Edit/View/Window under a File menu. DevTools entries exist only in development.
 */
export function menuTemplate(opts: { isMac: boolean; isPackaged: boolean; appName: string }): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    ...(opts.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
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
          { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
        ],
      } as MenuItemConstructorOptions]
      : [{ label: 'File', submenu: [{ role: 'quit' }] } as MenuItemConstructorOptions]),
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { role: 'windowMenu' },
  ];
}
