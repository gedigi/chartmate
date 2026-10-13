// Electron Fuses flipped into the packaged binary (see build/after-pack.cjs). Fuses are compile-time-like switches
// baked into the executable; they cannot be changed at runtime or via command-line/env.
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

/** @type {Record<string, boolean>} fuse name → enabled */
const FUSES = Object.freeze({
  // ELECTRON_RUN_AS_NODE would turn the signed binary into a plain Node interpreter.
  RunAsNode: false,
  // Encrypt cookies at rest with the OS keychain/DPAPI.
  EnableCookieEncryption: true,
  // NODE_OPTIONS / NODE_EXTRA_CA_CERTS-style environment injection into the main process.
  EnableNodeOptionsEnvironmentVariable: false,
  // --inspect / --inspect-brk debugger flags.
  EnableNodeCliInspectArguments: false,
  // Validate app.asar against the hash embedded at package time (Info.plist / Windows resource).
  EnableEmbeddedAsarIntegrityValidation: true,
  // Never load the app from a loose `app/` folder next to app.asar.
  OnlyLoadAppFromAsar: true,
  // No separate browser-process V8 snapshot file.
  LoadBrowserProcessSpecificV8Snapshot: false,
  // file:// gets no extra privileges (the app never uses file://).
  GrantFileProtocolExtraPrivileges: false,
});

/** Options for @electron/fuses `flipFuses` (minus resetAdHocDarwinSignature, decided per platform/arch). */
function fuseOptions() {
  const opts = { version: FuseVersion.V1 };
  for (const [name, enabled] of Object.entries(FUSES)) {
    const key = FuseV1Options[name];
    if (key === undefined) throw new Error(`unknown fuse ${name}`);
    opts[key] = enabled;
  }
  return opts;
}

module.exports = { FUSES, fuseOptions };
