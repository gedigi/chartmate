// pnpm install hooks.
//
// @electron/get (used by electron-builder at build time only) lists `global-agent` as an optional dependency. It
// is only loaded, inside a try/catch, to download Electron through an HTTP(S) proxy, and it pulls in
// roarr → sprintf-js, which has an unpatched advisory (GHSA-hp3w-g68c-fv3c). Nothing here downloads through a
// proxy, so the optional dependency is dropped. None of these packages are part of the shipped app.
function readPackage(pkg) {
  if (pkg.name === '@electron/get' && pkg.optionalDependencies) {
    delete pkg.optionalDependencies['global-agent'];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
