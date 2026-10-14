// Stand-in for apps/server/src/db/connect.ts used by vitest.server-suite.config.ts: the server's own DB-backed
// test suites run unchanged on top of the desktop node:sqlite dialect.
import { createNodeSqliteDb } from '../../src/lib/nodeSqlite.js';

export type Dialect = 'sqlite' | 'postgres';

export function createDb(url: string) {
  if (!url.startsWith('sqlite:')) throw new Error(`node:sqlite shim only supports sqlite: URLs, got ${url.split(':')[0]}:`);
  const path = url.slice('sqlite:'.length);
  if (path.trim() === '') throw new Error('Invalid DATABASE_URL: sqlite: URL has an empty path');
  return createNodeSqliteDb(path);
}
