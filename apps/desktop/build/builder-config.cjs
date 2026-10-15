// electron-builder configuration factory (used by ../electron-builder.config.cjs and the tests). Product identity comes from product.json (the single place to rename the app).
// Signing / notarization are driven purely by environment variables (CI secrets, see build/signing.cjs); without
// them the build is unsigned. electron-builder never uploads anything (the CI publish job does).
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const product = require('../product.json');
const { signingFor, CERTUM_TIMESTAMP_URL } = require('./signing.cjs');

/**
 * beforePack hook: writes .bundle-meta/THIRD_PARTY_NOTICES.txt (shipped as an extra resource) from the installed
 * dependency graph (scripts/third-party-notices.mjs, profile `desktop`). A dependency with a license outside the
 * AGPL-3.0-compatible allowlist, or without a license text, fails the build.
 */
async function writeThirdPartyNotices() {
  const notices = await import(pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'third-party-notices.mjs')).href);
  const packages = notices.collect('desktop');
  const problems = notices.problems(packages);
  if (problems.length > 0) throw new Error(`third-party notices: ${problems.join('; ')}`);
  const dir = join(__dirname, '..', '.bundle-meta');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'THIRD_PARTY_NOTICES.txt'), notices.render('desktop', packages));
}

/**
 * GitHub publish settings (only for app-update.yml; artifacts are uploaded by the CI publish job, electron-builder
 * always runs with --publish never). The repository comes from GITHUB_REPOSITORY (owner/name), never hardcoded.
 */
function githubPublish(env) {
  if (env.CHARTMATE_PUBLISH !== 'github') return null;
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) throw new Error('CHARTMATE_PUBLISH=github needs GITHUB_REPOSITORY=owner/name');
  return [{ provider: 'github', owner, repo, releaseType: 'release' }];
}

/** @param {NodeJS.ProcessEnv} env */
function buildConfig(env = process.env) {
  const mac = signingFor(env, 'darwin');
  const win = signingFor(env, 'win32');
  const publish = githubPublish(env);

  return {
    appId: product.appId,
    productName: product.productName,
    // The macOS bundle keeps the product name (Chartmate.app); executables elsewhere use executableName.
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    copyright: product.copyright,
    directories: { output: 'release', buildResources: 'build' },
    // Only the esbuild bundle (main + web UI) is shipped; all JS dependencies are inlined, so there is no
    // node_modules in the package at all.
    files: ['package.json', 'dist/**/*', '!dist/**/*.map', '!**/*.{md,ts,tsx,map}', '!**/{test,tests,__tests__}/**'],
    extraMetadata: { main: 'dist/main.cjs', name: product.executableName, productName: product.productName, dependencies: {}, devDependencies: {}, scripts: {} },
    asar: true,
    compression: 'maximum',
    electronLanguages: ['en', 'en-US'],
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    includePdb: false,
    removePackageScripts: true,
    removePackageKeywords: true,
    beforePack: writeThirdPartyNotices,
    afterPack: './build/after-pack.cjs',
    // The AGPL-3.0 text and the third-party notices, as plain files next to app.asar (Contents/Resources on
    // macOS, resources on Windows).
    extraResources: [
      { from: '../../LICENSE', to: 'LICENSE' },
      { from: '.bundle-meta/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
    ],
    publish,
    mac: {
      category: 'public.app-category.finance',
      icon: '../../assets/brand/chartmate.icns',
      target: [
        { target: 'dmg', arch: ['arm64', 'x64'] },
        { target: 'zip', arch: ['arm64', 'x64'] },
      ],
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      // null = do not sign (and do not pick up a random identity from the keychain) when no CSC_* secret is set.
      identity: mac.signed ? undefined : null,
      notarize: mac.notarize,
      minimumSystemVersion: '12.0',
    },
    // A signed build signs the dmg container too (Developer ID), so the CI packaging step can notarize and staple
    // it and Gatekeeper accepts the download itself (`spctl -a -t open --context context:primary-signature`).
    dmg: { writeUpdateInfo: false, sign: mac.signed },
    win: {
      executableName: product.executableName,
      icon: '../../assets/brand/chartmate.ico',
      // NSIS installer + a portable zip, both architectures.
      target: [{ target: 'nsis', arch: ['x64', 'arm64'] }, { target: 'zip', arch: ['x64', 'arm64'] }],
      ...(win.azure ? {
        azureSignOptions: {
          publisherName: env.AZURE_PUBLISHER_NAME,
          endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
          codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT,
          certificateProfileName: env.AZURE_TRUSTED_SIGNING_PROFILE,
        },
      } : {}),
      ...(win.certum ? {
        // Certum SimplySign: electron-builder hands every file (app exe, uninstaller, installer) to build/win-sign.cjs.
        // publisherName goes into app-update.yml: electron-updater accepts only installers signed by that CN.
        signtoolOptions: {
          sign: require('./win-sign.cjs').sign,
          signingHashAlgorithms: ['sha256'],
          publisherName: env.CHARTMATE_WIN_PUBLISHER_NAME.trim(),
          rfc3161TimeStampServer: CERTUM_TIMESTAMP_URL,
        },
      } : {}),
    },
    linux: { executableName: product.executableName, icon: '../../assets/brand/png/icon-512.png' },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      deleteAppDataOnUninstall: false,
      differentialPackage: true,
    },
  };
}

module.exports = { buildConfig };
