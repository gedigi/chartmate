// electron-builder afterPack hook: flips the Electron fuses (build/fuses.cjs) into the packaged executable before
// electron-builder signs it. On macOS the ad-hoc signature is reset so unsigned arm64 builds still launch; a real
// Developer ID signature (when CSC_* secrets are present) is applied afterwards by electron-builder.
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { flipFuses } = require('@electron/fuses');
const { fuseOptions } = require('./fuses.cjs');

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const product = packager.appInfo.productFilename;
  const candidates = electronPlatformName === 'darwin' || electronPlatformName === 'mas'
    ? [join(appOutDir, `${product}.app`)]
    : electronPlatformName === 'win32'
      ? [join(appOutDir, `${packager.executableName}.exe`), join(appOutDir, `${product}.exe`)]
      : [join(appOutDir, packager.executableName)];
  const target = candidates.find((p) => existsSync(p));
  if (!target) throw new Error(`after-pack: executable not found (tried ${candidates.join(', ')})`);
  await flipFuses(target, { ...fuseOptions(), resetAdHocDarwinSignature: electronPlatformName === 'darwin' });
  console.log(`  • fuses flipped  target=${target}`);
};
