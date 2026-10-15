import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb } from '../../src/db/connect.js';

/** Postgres server for the DB-backed suites (CI's Postgres job), e.g. postgres://user:pw@127.0.0.1:5432/db. */
export const TEST_PG_URL = process.env.TEST_PG_URL || undefined;
/**
 * `CHARTMATE_TEST_DB=postgres` (with TEST_PG_URL) runs the suites built on createTestDb (routes, market, baskets,
 * HTTP) against Postgres instead of in-memory SQLite. The repo suite runs on both whenever TEST_PG_URL is set.
 */
export const USE_PG = process.env.CHARTMATE_TEST_DB === 'postgres' && TEST_PG_URL !== undefined;

export type TestDb = ReturnType<typeof createDb>;

/**
 * A fresh, empty database: in-memory SQLite, or on Postgres a schema of its own (so parallel test files never
 * share tables), selected through the connection's search_path and dropped again by `close()`.
 */
export async function createTestDb(url: string = USE_PG ? TEST_PG_URL! : 'sqlite::memory:'): Promise<TestDb> {
  if (!url.startsWith('postgres')) return createDb(url);
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`create schema ${schema}`);
  } finally {
    await admin.end();
  }
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${schema}`);
  const h = createDb(u.toString());
  return {
    ...h,
    async close() {
      await h.close();
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(`drop schema ${schema} cascade`);
      } finally {
        await c.end();
      }
    },
  };
}
