import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type Dialect = 'sqlite' | 'postgres';

export function createDb(url: string): { db: Kysely<Database>; dialect: Dialect; close(): Promise<void> } {
  if (url.startsWith('sqlite:')) {
    const path = url.slice('sqlite:'.length);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const sqlite = new BetterSqlite3(path);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
    return { db, dialect: 'sqlite', close: () => db.destroy() };
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    pg.types.setTypeParser(20, (v: string) => Number(v)); // bigint -> number (ms timestamps are safe)
    pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric -> number
    const pool = new pg.Pool({ connectionString: url });
    pool.on('error', err => console.error('postgres pool error (idle client):', err));
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { db, dialect: 'postgres', close: () => db.destroy() };
  }
  throw new Error(`Unsupported database URL: ${url.split(':')[0]}:…`);
}
