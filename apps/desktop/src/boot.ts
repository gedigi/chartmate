// First module evaluated in the main bundle (main.ts imports it before anything else, and esbuild keeps ES import
// order): a packaged build refuses to start with dangerous command-line switches or with environment variables
// that Node has already acted on during pre-execution (proxy dispatcher, extra CA stores, TLS key logging).
import { app } from 'electron';
import { findForbiddenEnv, findForbiddenSwitches } from './lib/startupGuards.js';

/** True only in the test-only inspectable copy built by smoke/prepare-inspectable.mjs; false (compiled out) otherwise. */
declare const __TEST_INSPECTABLE__: boolean;

if (app.isPackaged) {
  const env = findForbiddenEnv(process.env);
  if (env.length > 0) {
    process.stderr.write(`refusing to start: forbidden environment variable(s): ${env.join(', ')}\n`);
    process.exit(1);
  }
  if (!__TEST_INSPECTABLE__) {
    // Judged on the switches actually passed (process.argv), not on app.commandLine: Electron appends some of these
    // to its own browser command line (e.g. --allow-file-access-from-files), which is not caller input.
    const bad = findForbiddenSwitches(process.argv, process.platform);
    if (bad.length > 0) {
      process.stderr.write(`refusing to start: forbidden command-line switch(es): ${bad.join(', ')}\n`);
      process.exit(1);
    }
  }
}
