// electron-builder afterPack hook:
// 1. refuses to package anything but a production bundle: dist/bundle-kind.json (written by scripts/bundle.mjs)
//    inside the packaged app.asar must say {"kind":"prod"}. A dev bundle (`bundle.mjs --dev`) runs unhardened when
//    unpackaged (src/lib/buildMode.ts), and a TEST-ONLY bundle has the switch guard compiled out; neither may ever
//    ship. (smoke/prepare-inspectable.mjs builds TEST-ONLY copies from an already packaged prod app, without
//    electron-builder, so this hook never sees them.)
// 2. flips the Electron fuses (build/fuses.cjs) into the packaged executable before electron-builder signs it. On
//    macOS the ad-hoc signature is reset so unsigned arm64 builds still launch; a real Developer ID signature (when
//    CSC_* secrets are present) is applied afterwards by electron-builder.
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const asar = require('@electron/asar');
const { flipFuses } = require('@electron/fuses');
const { fuseOptions } = require('./fuses.cjs');

/** Why the dist/bundle-kind.json content `raw` (null = missing) may not be packaged, or null if it may. */
function bundleKindProblem(raw) {
  if (raw === null) return 'no dist/bundle-kind.json: bundle with scripts/bundle.mjs first';
  let kind;
  try {
    kind = JSON.parse(raw).kind;
  } catch {
    return 'dist/bundle-kind.json is not valid JSON: rebuild the bundle with scripts/bundle.mjs';
  }
  if (kind === 'prod') return null;
  return `refusing to package a "${String(kind)}" bundle: only a production bundle (scripts/bundle.mjs without --dev or --test-inspectable) may be packaged`;
}

/** Throws unless the app.asar at `asarPath` holds a production bundle. */
function checkPackagedBundle(asarPath) {
  let raw = null;
  try {
    raw = asar.extractFile(asarPath, join('dist', 'bundle-kind.json')).toString('utf8');
  } catch {
    raw = null;
  }
  const problem = bundleKindProblem(raw);
  if (problem) throw new Error(`after-pack: ${problem}`);
}

/** Where electron-builder put app.asar for this platform. */
function packagedAsarPath({ appOutDir, platform, productFilename }) {
  return platform === 'darwin' || platform === 'mas'
    ? join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources', 'app.asar')
    : join(appOutDir, 'resources', 'app.asar');
}

/** @param {import('electron-builder').AfterPackContext} context */
async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const product = packager.appInfo.productFilename;
  checkPackagedBundle(packagedAsarPath({ appOutDir, platform: electronPlatformName, productFilename: product }));
  const candidates = electronPlatformName === 'darwin' || electronPlatformName === 'mas'
    ? [join(appOutDir, `${product}.app`)]
    : electronPlatformName === 'win32'
      ? [join(appOutDir, `${packager.executableName}.exe`), join(appOutDir, `${product}.exe`)]
      : [join(appOutDir, packager.executableName)];
  const target = candidates.find((p) => existsSync(p));
  if (!target) throw new Error(`after-pack: executable not found (tried ${candidates.join(', ')})`);
  await flipFuses(target, { ...fuseOptions(), resetAdHocDarwinSignature: electronPlatformName === 'darwin' });
  console.log(`  • production bundle checked, fuses flipped  target=${target}`);
}

module.exports = { default: afterPack, bundleKindProblem, checkPackagedBundle, packagedAsarPath };
