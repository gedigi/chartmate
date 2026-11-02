// pnpm install hooks.
//
// @electron/get (used by electron-builder at build time only) lists `global-agent` as an optional dependency. It
// is only loaded, inside a try/catch, to download Electron through an HTTP(S) proxy, and it pulls in
// roarr → sprintf-js, which has an unpatched advisory (GHSA-hp3w-g68c-fv3c). Nothing here downloads through a
// proxy, so the optional dependency is dropped. None of these packages are part of the shipped app.
//
// app-builder-lib (electron-builder) lists two packages that only other targets use, and both pull in minimatch 3, which
// has an unpatched advisory (GHSA-g3hv-75wg-m249): electron-builder-squirrel-windows (a peer, loaded only to build
// Squirrel.Windows installers; Chartmate builds NSIS) and @electron/universal (loaded with a dynamic import only for
// macOS universal builds; Chartmate builds arm64 and x64 apps). Both are dropped. The minimatch / glob / @electron/asar
// overrides in pnpm-workspace.yaml handle the rest.
function readPackage(pkg) {
  if (pkg.name === '@electron/get' && pkg.optionalDependencies) {
    delete pkg.optionalDependencies['global-agent'];
  }
  if (pkg.name === 'app-builder-lib') {
    if (pkg.peerDependencies) delete pkg.peerDependencies['electron-builder-squirrel-windows'];
    if (pkg.dependencies) delete pkg.dependencies['@electron/universal'];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
