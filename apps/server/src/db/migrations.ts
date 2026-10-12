import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { Database } from './schema.js';

const dbl = sql`double precision`;

const m001: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('bars')
      .addColumn('symbol', 'text', c => c.notNull())
      .addColumn('tf', 'text', c => c.notNull())
      .addColumn('ts', 'bigint', c => c.notNull())
      .addColumn('open', dbl, c => c.notNull())
      .addColumn('high', dbl, c => c.notNull())
      .addColumn('low', dbl, c => c.notNull())
      .addColumn('close', dbl, c => c.notNull())
      .addColumn('volume', dbl, c => c.notNull())
      .addColumn('session', 'text')
      .addPrimaryKeyConstraint('bars_pk', ['symbol', 'tf', 'ts'])
      .execute();
    await db.schema.createTable('coverage')
      .addColumn('symbol', 'text', c => c.notNull())
      .addColumn('tf', 'text', c => c.notNull())
      .addColumn('from_ts', 'bigint', c => c.notNull())
      .addColumn('to_ts', 'bigint', c => c.notNull())
      .addPrimaryKeyConstraint('coverage_pk', ['symbol', 'tf', 'from_ts'])
      .execute();
    await db.schema.createTable('symbols')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('name', 'text', c => c.notNull())
      .addColumn('exchange', 'text')
      .addColumn('price_precision', 'integer', c => c.notNull())
      .addColumn('first_ts', 'bigint')
      .addColumn('updated_at', 'bigint', c => c.notNull())
      .execute();
    await db.schema.createTable('baskets')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('name', 'text', c => c.notNull())
      .addColumn('base_value', dbl, c => c.notNull())
      .addColumn('created_at', 'bigint', c => c.notNull())
      .addColumn('updated_at', 'bigint', c => c.notNull())
      .execute();
    await db.schema.createTable('basket_versions')
      .addColumn('basket_id', 'text', c => c.notNull().references('baskets.id').onDelete('cascade'))
      .addColumn('idx', 'integer', c => c.notNull())
      .addColumn('effective_from', 'text', c => c.notNull())
      .addColumn('weights_json', 'text', c => c.notNull())
      .addPrimaryKeyConstraint('basket_versions_pk', ['basket_id', 'idx'])
      .execute();
    await db.schema.createTable('watchlist')
      .addColumn('symbol', 'text', c => c.primaryKey())
      .addColumn('position', 'integer', c => c.notNull())
      .execute();
    await db.schema.createTable('layouts')
      .addColumn('key', 'text', c => c.primaryKey())
      .addColumn('json', 'text', c => c.notNull())
      .addColumn('updated_at', 'bigint', c => c.notNull())
      .execute();
    await db.schema.createTable('drawings')
      .addColumn('symbol', 'text', c => c.primaryKey())
      .addColumn('json', 'text', c => c.notNull())
      .addColumn('updated_at', 'bigint', c => c.notNull())
      .execute();
  },
};

/** Symbol metadata: provider ticker, and when splits were last checked (cache invalidation on stock splits). */
const m002: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable('symbols').addColumn('ticker', 'text').execute();
    await db.schema.alterTable('symbols').addColumn('splits_checked_at', 'bigint').execute();
  },
};

const provider: MigrationProvider = {
  async getMigrations() {
    return { '001_init': m001, '002_symbol_splits': m002 };
  },
};

export async function migrate(db: Kysely<Database>): Promise<void> {
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
  const failed = results?.find(r => r.status === 'Error');
  if (error || failed) throw error instanceof Error ? error : new Error(`migration failed: ${failed?.migrationName ?? String(error)}`);
}
