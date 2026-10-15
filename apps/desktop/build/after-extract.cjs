// electron-builder afterExtract hook: keeps Electron's license and the Chromium credits in the macOS app.
// Electron's macOS zip has LICENSE and LICENSES.chromium.html next to Electron.app; electron-builder deletes both
// when it turns Electron.app into Chartmate.app, so they are copied into Contents/Resources first (as
// LICENSE.electron.txt and LICENSES.chromium.html, the names the Windows build keeps next to chartmate.exe).
const { copyFileSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** @param {{ appOutDir: string, electronPlatformName: string }} context */
async function afterExtract({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'mas') return;
  const app = readdirSync(appOutDir).find((f) => f.endsWith('.app'));
  if (!app) throw new Error(`after-extract: no .app in ${appOutDir}`);
  const resources = join(appOutDir, app, 'Contents', 'Resources');
  for (const [from, to] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    const src = join(appOutDir, from);
    if (!existsSync(src)) throw new Error(`after-extract: ${from} is missing from the Electron distribution`);
    copyFileSync(src, join(resources, to));
  }
}

module.exports = { default: afterExtract };
