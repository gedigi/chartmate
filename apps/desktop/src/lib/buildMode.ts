/**
 * Whether the startup guards and the renderer hardening apply.
 *
 * `app.isPackaged` alone is not a security boundary: Electron derives it from the executable's file name (anything
 * but `electron` / `electron.exe`), so a user-level copy of the shipped app whose executable is renamed to
 * `electron(.exe)` reports `isPackaged = false`. Only the development bundle (`scripts/bundle.mjs --dev`, used by
 * `pnpm start` and the unpackaged smoke run) may run unhardened, and only when unpackaged. Every production bundle
 * (release builds and the TEST-ONLY inspectable copy) is hardened whatever its executable is called.
 */
export function isHardened(o: { devBundle: boolean; isPackaged: boolean }): boolean {
  return !o.devBundle || o.isPackaged;
}
