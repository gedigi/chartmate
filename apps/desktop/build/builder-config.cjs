// electron-builder configuration factory (used by ../electron-builder.config.cjs and the tests). Product identity comes from product.json (the single place to rename the app).
// Signing / notarization are driven purely by environment variables (CI secrets, see build/signing.cjs); without
// them the build is unsigned. electron-builder never uploads anything (the CI publish job does).
const product = require('../product.json');
const { signingFor } = require('./signing.cjs');

/**
 * GitHub publish settings (only for app-update.yml; artifacts are uploaded by the CI publish job, electron-builder
 * always runs with --publish never). The repository comes from GITHUB_REPOSITORY (owner/name), never hardcoded.
 */
function githubPublish(env) {
  if (env.ALTV_PUBLISH !== 'github') return null;
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) throw new Error('ALTV_PUBLISH=github needs GITHUB_REPOSITORY=owner/name');
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
    afterPack: './build/after-pack.cjs',
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
    dmg: { writeUpdateInfo: false },
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
