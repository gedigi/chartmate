import { PostgresAdapter, sql, type Kysely } from 'kysely';
import { tryNormalizeSymbolId } from '@chartmate/shared';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { Database } from './schema.js';

const dbl = sql`double precision`;

/** The current schema on Postgres (first existing entry of the search_path); undefined on SQLite. */
async function currentPgSchema(db: Kysely<any>): Promise<string | undefined> {
  if (!(db.getExecutor().adapter instanceof PostgresAdapter)) return undefined;
  return (await sql<{ s: string }>`select current_schema() as s`.execute(db)).rows[0]?.s ?? undefined;
}

/**
 * Column names of `table` in the current schema (on Postgres a same-named table in another schema on the
 * search_path, e.g. a leftover `public.symbols`, must not be mistaken for ours).
 */
async function columnsOf(db: Kysely<any>, table: string): Promise<Set<string>> {
  const schema = await currentPgSchema(db);
  const t = (await db.introspection.getTables()).find(x => x.name === table && (schema === undefined || x.schema === schema));
  return new Set(t?.columns.map(c => c.name) ?? []);
}

/**
 * Runs a migration body in one transaction. Kysely runs migrations without one on SQLite (its adapter does not
 * claim transactional DDL), so a failure halfway would otherwise leave rewritten data half deleted; Postgres
 * migrations already arrive inside a transaction.
 */
async function atomically(db: Kysely<any>, fn: (db: Kysely<any>) => Promise<void>): Promise<void> {
  if (db.isTransaction) return fn(db);
  await db.transaction().execute(fn);
}

/** Rows per multi-row insert: far below SQLite's bound-variable limit, whatever the column count. */
const INSERT_CHUNK = 100;

async function insertChunked(db: Kysely<any>, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) await db.insertInto(table).values(rows.slice(i, i + INSERT_CHUNK)).execute();
}

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
    const have = await columnsOf(db, 'symbols');
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
    await insertChunked(db, 'watchlist_entries', legacy.map((r: { symbol: string }, position: number) =>
      ({ position, kind: 'symbol', symbol: r.symbol, section_id: null, title: null, collapsed: null })));
  },
};

/** Layout symbol used when a stored layout's symbol is not a valid id (the web app's default symbol). */
export const FALLBACK_LAYOUT_SYMBOL = 'crypto:BTC';
const MAX_DRAWINGS = 500;

/**
 * Symbol ids are normalized (`crypto:btc` → `crypto:BTC`, see parseSymbolId) and validated from this version on.
 * Rewrites the ids stored by older versions to their canonical spelling:
 * - watchlist (entries and the legacy mirror): normalized; invalid ids and the later of two case variants dropped.
 * - layouts: `sym:<id>` keys normalized (invalid → row dropped; of two variants the newest wins); the `symbol` of
 *   each layout normalized, an invalid one replaced by FALLBACK_LAYOUT_SYMBOL.
 * - drawings: keys normalized; case variants are merged (oldest first, capped at MAX_DRAWINGS); invalid keys dropped.
 * - basket weights: keys normalized (case variants summed); invalid keys dropped and the rest rescaled to sum 1
 *   (a version left with no valid key is kept as it was).
 * - market cache (bars, coverage, symbols): rows under a non-canonical id are deleted (refetched under the new id).
 * Idempotent: canonical rows are left untouched.
 */
const m004: Migration = {
  async up(outer: Kysely<any>) {
    await atomically(outer, async (db) => {
      const canon = (id: unknown) => tryNormalizeSymbolId(id);

      // Watchlist entries (ordered) and the legacy mirror.
      const entries = await db.selectFrom('watchlist_entries').selectAll().orderBy('position', 'asc').execute();
      const seen = new Set<string>();
      const kept: any[] = [];
      let changed = false;
      for (const e of entries) {
        if (e.kind !== 'symbol') { kept.push(e); continue; }
        const id = canon(e.symbol);
        if (id === null || seen.has(id)) { changed = true; continue; }
        seen.add(id);
        if (id !== e.symbol) changed = true;
        kept.push({ ...e, symbol: id });
      }
      if (changed) {
        await db.deleteFrom('watchlist_entries').execute();
        await insertChunked(db, 'watchlist_entries', kept.map((e, position) => ({ ...e, position })));
      }
      const legacy = await db.selectFrom('watchlist').selectAll().orderBy('position', 'asc').execute();
      const legacySeen = new Set<string>();
      const legacyKept: { symbol: string; position: number }[] = [];
      for (const r of legacy) {
        const id = canon(r.symbol);
        if (id === null || legacySeen.has(id)) continue;
        legacySeen.add(id);
        legacyKept.push({ symbol: id, position: legacyKept.length });
      }
      if (legacyKept.length !== legacy.length || legacyKept.some((r, i) => r.symbol !== legacy[i]!.symbol)) {
        await db.deleteFrom('watchlist').execute();
        await insertChunked(db, 'watchlist', legacyKept);
      }

      // Layouts: keys, then the symbol inside each one.
      const layouts = await db.selectFrom('layouts').selectAll().orderBy('updated_at', 'asc').execute();
      const byKey = new Map<string, { key: string; json: string; updated_at: number }>();
      for (const l of layouts) {
        let key: string | null = l.key;
        if (l.key.startsWith('sym:')) {
          const id = canon(l.key.slice(4));
          key = id === null ? null : `sym:${id}`;
        }
        if (key === null) continue;
        let json: string = l.json;
        try {
          const parsed = JSON.parse(l.json) as { symbol?: unknown };
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const symbol = canon(parsed.symbol) ?? FALLBACK_LAYOUT_SYMBOL;
            if (symbol !== parsed.symbol) json = JSON.stringify({ ...parsed, symbol });
          }
        } catch {
          // Corrupt JSON stays as it is (the repo reports it when read).
        }
        byKey.set(key, { key, json, updated_at: Number(l.updated_at) }); // ascending: the newest variant wins
      }
      for (const l of layouts) {
        const next = byKey.get(l.key);
        if (next && next.json === l.json) continue;
        await db.deleteFrom('layouts').where('key', '=', l.key).execute();
      }
      for (const [key, v] of byKey) {
        const orig = layouts.find((l) => l.key === key);
        if (orig && orig.json === v.json) continue;
        await db.insertInto('layouts').values(v).execute();
      }

      // Drawings: keys normalized, case variants merged.
      const drawings = await db.selectFrom('drawings').selectAll().orderBy('updated_at', 'asc').execute();
      const merged = new Map<string, { items: unknown[]; updated_at: number; sources: string[] }>();
      for (const d of drawings) {
        const id = canon(d.symbol);
        if (id === null) continue;
        let items: unknown[];
        try {
          const parsed = JSON.parse(d.json) as unknown;
          items = Array.isArray(parsed) ? parsed : [];
        } catch {
          items = [];
        }
        const m = merged.get(id) ?? { items: [], updated_at: 0, sources: [] };
        m.items.push(...items);
        m.updated_at = Math.max(m.updated_at, Number(d.updated_at));
        m.sources.push(d.symbol);
        merged.set(id, m);
      }
      for (const d of drawings) {
        const id = canon(d.symbol);
        if (id !== null && id === d.symbol && merged.get(id)!.sources.length === 1) continue; // canonical, alone
        await db.deleteFrom('drawings').where('symbol', '=', d.symbol).execute();
      }
      for (const [symbol, m] of merged) {
        if (m.sources.length === 1 && m.sources[0] === symbol) continue;
        await db.insertInto('drawings')
          .values({ symbol, json: JSON.stringify(m.items.slice(-MAX_DRAWINGS)), updated_at: m.updated_at }).execute();
      }

      // Basket weights.
      const versions = await db.selectFrom('basket_versions').selectAll().execute();
      for (const v of versions) {
        let weights: Record<string, unknown>;
        try {
          weights = JSON.parse(v.weights_json) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!weights || typeof weights !== 'object' || Array.isArray(weights)) continue;
        const out: Record<string, number> = Object.create(null) as Record<string, number>;
        let dropped = false;
        for (const [k, w] of Object.entries(weights)) {
          const id = canon(k);
          if (id === null || typeof w !== 'number') { dropped = true; continue; }
          out[id] = (Object.hasOwn(out, id) ? out[id]! : 0) + w;
        }
        const keys = Object.keys(out);
        if (keys.length === 0) continue;
        if (dropped) {
          const sum = keys.reduce((a, k) => a + out[k]!, 0);
          if (!(sum > 0) || !Number.isFinite(sum)) continue;
          for (const k of keys) out[k] = out[k]! / sum;
        }
        // Never store a weight that is not a positive finite number (e.g. two huge variants summed to Infinity):
        // such a version is left exactly as it was.
        if (!keys.every((k) => Number.isFinite(out[k]) && out[k]! > 0)) continue;
        if (dropped) {
          console.warn(`Chartmate migration 004: basket ${String(v.basket_id)} version ${Number(v.idx) + 1} held an invalid `
            + 'symbol id; it was removed and the remaining weights were rescaled to sum to 100%.');
        }
        const json = JSON.stringify(out);
        if (json !== v.weights_json) {
          await db.updateTable('basket_versions').set({ weights_json: json })
            .where('basket_id', '=', v.basket_id).where('idx', '=', v.idx).execute();
        }
      }

      // Market cache: rows under a non-canonical id are dropped.
      for (const table of ['bars', 'coverage'] as const) {
        const ids = await db.selectFrom(table).select('symbol').distinct().execute();
        for (const { symbol } of ids) {
          if (canon(symbol) !== symbol) await db.deleteFrom(table).where('symbol', '=', symbol).execute();
        }
      }
      const symbols = await db.selectFrom('symbols').select('id').execute();
      for (const { id } of symbols) {
        if (canon(id) !== id) await db.deleteFrom('symbols').where('id', '=', id).execute();
      }
    });
  },
};

/**
 * Split bookkeeping: `applied_splits` records each split applied to a symbol's cache, so a split reported late
 * (dated before the last check) is still applied, and exactly once. `symbols.splits_tracked_from` is when that
 * record starts: splits at or before it may have been applied by an earlier version without being recorded, so the
 * late-report look-back never reaches past it. Existing rows start tracking at their last check. Idempotent.
 */
const m005: Migration = {
  async up(outer: Kysely<any>) {
    await atomically(outer, async (db) => {
      await db.schema.createTable('applied_splits').ifNotExists()
        .addColumn('symbol', 'text', c => c.notNull())
        .addColumn('ts', 'bigint', c => c.notNull())
        .addPrimaryKeyConstraint('applied_splits_pk', ['symbol', 'ts'])
        .execute();
      if (!(await columnsOf(db, 'symbols')).has('splits_tracked_from')) {
        await db.schema.alterTable('symbols').addColumn('splits_tracked_from', 'bigint').execute();
        await db.updateTable('symbols').set({ splits_tracked_from: sql`splits_checked_at` }).execute();
      }
    });
  },
};

/** Server settings (key/value), e.g. the generated session secret. Idempotent. */
const m006: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('settings').ifNotExists()
      .addColumn('key', 'text', c => c.primaryKey())
      .addColumn('value', 'text', c => c.notNull())
      .execute();
  },
};

const migrations: Record<string, Migration> = {
  '001_init': m001, '002_symbol_splits': m002, '003_watchlist_sections': m003, '004_symbol_ids': m004,
  '005_applied_splits': m005, '006_settings': m006,
};
const provider: MigrationProvider = {
  async getMigrations() { return migrations; },
};

/** Migrates to the latest version (or up to and including `target`, for tests). */
export async function migrate(db: Kysely<Database>, target?: string): Promise<void> {
  // On Postgres the migration bookkeeping lives in the current schema, named explicitly: otherwise Kysely takes a
  // kysely_migration table in any other schema of the database as ours.
  const migrationTableSchema = await currentPgSchema(db);
  const migrator = new Migrator({ db, provider, ...(migrationTableSchema ? { migrationTableSchema } : {}) });
  const { error, results } = target === undefined ? await migrator.migrateToLatest() : await migrator.migrateTo(target);
  const failed = results?.find(r => r.status === 'Error');
  if (error || failed) throw error instanceof Error ? error : new Error(`migration failed: ${failed?.migrationName ?? String(error)}`);
}
