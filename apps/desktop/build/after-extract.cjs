// electron-builder afterExtract hook: makes sure Electron's license and the Chromium credits ship in the macOS app.
// Electron's macOS zip has LICENSE and LICENSES.chromium.html next to Electron.app, outside the bundle. Since 26.18
// electron-builder moves both into Contents/Resources itself (as LICENSE.electron.txt and LICENSES.chromium.html, the
// names the Windows build keeps next to chartmate.exe); older versions deleted them, so a file still next to the app
// is copied there. Either way the build fails when one is in neither place.
const { copyFileSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** @param {{ appOutDir: string, electronPlatformName: string }} context */
async function afterExtract({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'mas') return;
  const app = readdirSync(appOutDir).find((f) => f.endsWith('.app'));
  if (!app) throw new Error(`after-extract: no .app in ${appOutDir}`);
  const resources = join(appOutDir, app, 'Contents', 'Resources');
  const files = [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']];
  for (const [from, to] of files) {
    const src = join(appOutDir, from);
    const dest = join(resources, to);
    if (existsSync(src)) copyFileSync(src, dest);
    else if (!existsSync(dest)) throw new Error(`after-extract: ${from} is missing from the Electron distribution`);
  }
}

module.exports = { default: afterExtract };
