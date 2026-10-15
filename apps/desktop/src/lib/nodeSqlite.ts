import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Kysely, SqliteDialect, type SqliteDatabase, type SqliteStatement } from 'kysely';
import type { Database } from '../../../server/src/db/schema.js';

/**
 * Kysely on Node's built-in `node:sqlite` (DatabaseSync), reusing Kysely's own SqliteDialect: `node:sqlite` is
 * adapted to the small better-sqlite3 subset that dialect needs (`prepare` → statement with `reader`, `all`,
 * `run`, `iterate`, taking positional parameter arrays). This removes the only native module (better-sqlite3)
 * from the desktop build.
 *
 * Prepared statements are cached per SQL text (LRU) since Kysely re-prepares on every query.
 */
export function adaptNodeSqlite(db: DatabaseSync, cacheSize = 128): SqliteDatabase {
  const cache = new Map<string, SqliteStatement>();
  const params = (p: ReadonlyArray<unknown>) => p as SQLInputValue[];

  const wrap = (sql: string, st: StatementSync): SqliteStatement => {
    const reader = st.columns().length > 0;
    return {
      reader,
      all: (p) => st.all(...params(p)),
      run: (p) => {
        const r = st.run(...params(p));
        return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
      },
      // Streaming gets its own statement: re-running a cached one would reset a live iterator.
      iterate: (p) => db.prepare(sql).iterate(...params(p)) as IterableIterator<unknown>,
    };
  };

  return {
    close: () => {
      cache.clear();
      db.close();
    },
    prepare: (sql: string) => {
      const hit = cache.get(sql);
      if (hit) {
        cache.delete(sql);
        cache.set(sql, hit);
        return hit;
      }
      const stmt = wrap(sql, db.prepare(sql));
      cache.set(sql, stmt);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
      return stmt;
    },
  };
}

export interface NodeSqliteHandle {
  db: Kysely<Database>;
  dialect: 'sqlite';
  close(): Promise<void>;
}

/** Opens (creating if needed) a SQLite file — or `:memory:` — with WAL and foreign keys, as the server does. */
export function createNodeSqliteDb(path: string): NodeSqliteHandle {
  if (path.trim() === '') throw new Error('Invalid database path: empty path');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  // The file holds user data (layouts, drawings, watchlists, baskets) besides the bar cache. WAL + NORMAL: a
  // committed transaction survives an application crash, and the database never corrupts; only an OS crash or power
  // loss can roll back the last few commits (no fsync per commit, which matters for frequent drawing/layout saves).
  // FULL would close that window at the cost of an fsync on every write (docs/desktop.md).
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: adaptNodeSqlite(raw) }) });
  return { db, dialect: 'sqlite', close: () => db.destroy() };
}
