// First module evaluated in the main bundle (main.ts imports it before anything else, and esbuild keeps ES import
// order): a packaged build refuses to start with dangerous command-line switches or with environment variables
// that Node has already acted on during pre-execution (proxy dispatcher, system CA store, TLS key logging).
import { app, dialog } from 'electron';
import product from '../product.json' with { type: 'json' };
import { runStartupGuards } from './lib/startupGuards.js';

/** True only in the test-only inspectable copy built by smoke/prepare-inspectable.mjs; false (compiled out) otherwise. */
declare const __TEST_INSPECTABLE__: boolean;

runStartupGuards({
  isPackaged: app.isPackaged,
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
