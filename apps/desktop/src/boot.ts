// First module evaluated in the main bundle (main.ts imports it before anything else, and esbuild keeps ES import
// order): a hardened build refuses to start with dangerous command-line switches or with environment variables
// that Node has already acted on during pre-execution (proxy dispatcher, extra CA certificates, TLS key logging).
// Every production bundle is hardened, whatever its executable is called (lib/buildMode.ts).
import { app, dialog } from 'electron';
import product from '../product.json' with { type: 'json' };
import { isHardened } from './lib/buildMode.js';
import { runStartupGuards } from './lib/startupGuards.js';

/** True only in the test-only inspectable copy built by smoke/prepare-inspectable.mjs; false (compiled out) otherwise. */
declare const __TEST_INSPECTABLE__: boolean;
/** True only in the development bundle (`bundle.mjs --dev`); false (compiled out) in release and TEST-ONLY bundles. */
declare const __DEV_BUNDLE__: boolean;

/** Startup guards, DevTools lockdown, request filter, fixed profile: on unless this is the dev bundle run unpackaged. */
export const hardened = isHardened({ devBundle: __DEV_BUNDLE__, isPackaged: app.isPackaged });

runStartupGuards({
  hardened,
  checkSwitches: !__TEST_INSPECTABLE__,
  // Judged on the switches actually passed (process.argv), not on app.commandLine: Electron appends some of these
  // to its own browser command line (e.g. --allow-file-access-from-files), which is not caller input.
  argv: process.argv,
  env: process.env,
  platform: process.platform,
  productName: product.productName,
  showError: (title, content) => dialog.showErrorBox(title, content), // safe before 'ready'
  writeStderr: (line) => process.stderr.write(line),
  exit: (code) => process.exit(code),
});
