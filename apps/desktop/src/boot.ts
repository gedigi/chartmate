// First module evaluated in the main bundle (main.ts imports it before anything else, and esbuild keeps ES import
// order): refuses dangerous command-line switches in packaged builds and strips proxy/CA environment variables
// before any other code runs.
import { app } from 'electron';
import { findForbiddenSwitches, sanitizeEnv } from './lib/startupGuards.js';

/** True only in the test-only inspectable copy built by smoke/prepare-inspectable.mjs; false (compiled out) otherwise. */
declare const __TEST_INSPECTABLE__: boolean;

sanitizeEnv(process.env);

if (app.isPackaged && !__TEST_INSPECTABLE__) {
  const bad = findForbiddenSwitches(process.argv, process.platform, (s) => app.commandLine.hasSwitch(s));
  if (bad.length > 0) {
    process.stderr.write(`refusing to start: forbidden command-line switch(es): ${bad.join(', ')}\n`);
    process.exit(1);
  }
}
