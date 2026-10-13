// electron-builder configuration factory (used by ../electron-builder.config.cjs and the tests). Product identity comes from product.json (the single place to rename the app).
// Signing / notarization / publishing are driven purely by environment variables (CI secrets); without them the
// build is unsigned and never published.
const product = require('../product.json');

/** @param {NodeJS.ProcessEnv} env */
function buildConfig(env = process.env) {
  const has = (...keys) => keys.every((k) => typeof env[k] === 'string' && env[k].trim() !== '');
  const macSigning = has('CSC_LINK') || has('CSC_NAME');
  const notarize = macSigning && has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
  const azureSigning = has('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TRUSTED_SIGNING_ENDPOINT',
    'AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE', 'AZURE_PUBLISHER_NAME');
  const publish = env.ALTV_PUBLISH === 'github' ? [{ provider: 'github', releaseType: 'draft' }] : null;

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
      identity: macSigning ? undefined : null,
      notarize,
      minimumSystemVersion: '12.0',
    },
    dmg: { writeUpdateInfo: false },
    win: {
      executableName: product.executableName,
      icon: '../../assets/brand/chartmate.ico',
      target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
      ...(azureSigning ? {
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
