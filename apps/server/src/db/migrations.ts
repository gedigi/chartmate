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
    // Idempotent: a column that already exists (e.g. a partially applied run) is not added again.
    const symbols = (await db.introspection.getTables()).find(t => t.name === 'symbols');
    const have = new Set(symbols?.columns.map(c => c.name) ?? []);
    if (!have.has('ticker')) await db.schema.alterTable('symbols').addColumn('ticker', 'text').execute();
    if (!have.has('splits_checked_at')) await db.schema.alterTable('symbols').addColumn('splits_checked_at', 'bigint').execute();
  },
};

/**
 * Watchlist sections: an ordered entry table (symbols and section headers). Existing watchlist rows are copied in
 * order. Idempotent: the table is created only if missing and filled only while empty. The legacy `watchlist`
 * table is kept and mirrored by the repo. An older server refuses to start once this migration is recorded; a manual
 * rollback (README, "Troubleshooting") deletes its kysely_migration row, and the older server then reads the
 * mirrored symbols.
 */
const m003: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('watchlist_entries').ifNotExists()
      .addColumn('position', 'integer', c => c.primaryKey())
      .addColumn('kind', 'text', c => c.notNull())
      .addColumn('symbol', 'text')
      .addColumn('section_id', 'text')
      .addColumn('title', 'text')
      .addColumn('collapsed', 'integer')
      .execute();
    const existing = await db.selectFrom('watchlist_entries').select('position').limit(1).execute();
    if (existing.length > 0) return;
    const legacy = await db.selectFrom('watchlist').select('symbol').orderBy('position', 'asc').execute();
    if (legacy.length === 0) return;
    await db.insertInto('watchlist_entries').values(legacy.map((r: { symbol: string }, position: number) =>
      ({ position, kind: 'symbol', symbol: r.symbol, section_id: null, title: null, collapsed: null }))).execute();
  },
};

const migrations: Record<string, Migration> = { '001_init': m001, '002_symbol_splits': m002, '003_watchlist_sections': m003 };
const provider: MigrationProvider = {
  async getMigrations() { return migrations; },
};

/** Migrates to the latest version (or up to and including `target`, for tests). */
export async function migrate(db: Kysely<Database>, target?: string): Promise<void> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = target === undefined ? await migrator.migrateToLatest() : await migrator.migrateTo(target);
  const failed = results?.find(r => r.status === 'Error');
  if (error || failed) throw error instanceof Error ? error : new Error(`migration failed: ${failed?.migrationName ?? String(error)}`);
}
