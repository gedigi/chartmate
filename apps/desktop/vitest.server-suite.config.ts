import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Runs the server's DB-backed test suites (repos, market service, baskets, HTTP routes) against the desktop
 * node:sqlite dialect instead of better-sqlite3, by aliasing the server's `db/connect.js` to a shim.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@chartmate/shared', replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
      { find: /^(\.\.\/)+src\/db\/connect\.js$/, replacement: fileURLToPath(new URL('./test/shims/connect-node-sqlite.ts', import.meta.url)) },
    ],
  },
  test: {
    root: fileURLToPath(new URL('../server', import.meta.url)),
    include: [
      'test/db/**/*.test.ts',
      'test/market/**/*.test.ts',
      'test/baskets/**/*.test.ts',
      'test/routes/**/*.test.ts',
      'test/http/**/*.test.ts',
    ],
  },
});
