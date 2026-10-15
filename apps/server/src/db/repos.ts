import { randomBytes } from 'node:crypto';
import { PostgresAdapter, sql, type Kysely } from 'kysely';
import { tryNormalizeSymbolId, watchlistSymbols, type Bar, type Basket, type BasketVersion, type DrawingState, type Layout, type NativeTimeframe, type SymbolId, type WatchlistEntry } from '@chartmate/shared';
import type { Database } from './schema.js';
import type { Dialect } from './connect.js';

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`corrupt JSON in ${what}: ${(e as Error).message}`);
  }
}

const CHUNK = 500;

/** The columns a split check stamps: the check time, and the start of split tracking when the row has none yet. */
function checkStamp(checkedAt: number, trackFrom: number | undefined) {
  return trackFrom === undefined
    ? { splits_checked_at: checkedAt }
    : { splits_checked_at: checkedAt, splits_tracked_from: sql<number>`coalesce(splits_tracked_from, ${trackFrom})` };
}

/** One step of a stock-split invalidation for a timeframe (see `BarRepo.applySplit`). */
export interface SplitOp {
  tf: NativeTimeframe;
  /** Bars (and coverage) with ts >= cut are deleted; use Number.MIN_SAFE_INTEGER to drop the whole timeframe. */
  cut: number;
  /** Bars with ts < cut are rescaled: prices / factor, volume * factor (absent = no older bars kept). */
  factor?: number;
}

/**
 * Serializes writers of one symbol's cached market data (bar fills, coverage merges, split invalidations) on
 * Postgres with a transaction-scoped advisory lock. SQLite needs none: it has a single writer, and Kysely runs one
 * transaction at a time on its single connection.
 */
async function lockSymbol(trx: Kysely<Database>, dialect: Dialect, symbol: string): Promise<void> {
  if (dialect === 'postgres') await sql`select pg_advisory_xact_lock(hashtext(${'bars:' + symbol}))`.execute(trx);
}

async function upsertBars(db: Kysely<Database>, symbol: string, tf: NativeTimeframe, bars: Bar[]): Promise<void> {
  const byTs = new Map<number, Bar>();
  for (const b of bars) byTs.set(b.ts, b); // last wins; Postgres rejects duplicate keys within one statement
  const unique = [...byTs.values()];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = unique.slice(i, i + CHUNK).map(b => ({
      symbol, tf, ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, session: b.session ?? null,
    }));
    await db.insertInto('bars').values(rows)
      .onConflict(oc => oc.columns(['symbol', 'tf', 'ts']).doUpdateSet(eb => ({
        open: eb.ref('excluded.open'), high: eb.ref('excluded.high'), low: eb.ref('excluded.low'),
        close: eb.ref('excluded.close'), volume: eb.ref('excluded.volume'), session: eb.ref('excluded.session'),
      })))
      .execute();
  }
}

function checkRange(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError(`coverage.add: non-finite range [${from}, ${to})`);
}

/** Merges [from, to) into the covered ranges of (symbol, tf), inside the caller's transaction. */
async function mergeCoverage(trx: Kysely<Database>, symbol: string, tf: NativeTimeframe, from: number, to: number): Promise<void> {
  const overlap = await trx.selectFrom('coverage').select(['from_ts', 'to_ts'])
    .where('symbol', '=', symbol).where('tf', '=', tf)
    .where('from_ts', '<=', to).where('to_ts', '>=', from).execute();
  let lo = from;
  let hi = to;
  for (const r of overlap) {
    lo = Math.min(lo, Number(r.from_ts));
    hi = Math.max(hi, Number(r.to_ts));
  }
  if (overlap.length > 0) {
    await trx.deleteFrom('coverage').where('symbol', '=', symbol).where('tf', '=', tf)
      .where('from_ts', 'in', overlap.map(r => r.from_ts)).execute();
  }
  await trx.insertInto('coverage').values({ symbol, tf, from_ts: lo, to_ts: hi }).execute();
}

export class BarRepo {
  constructor(private db: Kysely<Database>, private dialect: Dialect = 'sqlite') {}

  async upsert(symbol: string, tf: NativeTimeframe, bars: Bar[]): Promise<void> {
    await upsertBars(this.db, symbol, tf, bars);
  }

  /**
   * Stores a fetched chunk: the bars and, when given, the covered range [from, to) in ONE transaction under the
   * symbol's lock, so a split invalidation (applySplit, same lock) can never land between them and leave
   * pre-split bars marked covered. An empty or inverted cover range is skipped.
   */
  async store(symbol: string, tf: NativeTimeframe, bars: Bar[], cover: [number, number] | null): Promise<void> {
    if (cover) checkRange(cover[0], cover[1]);
    if (bars.length === 0 && (!cover || cover[0] >= cover[1])) return;
    await this.db.transaction().execute(async trx => {
      await lockSymbol(trx, this.dialect, symbol);
      await upsertBars(trx, symbol, tf, bars);
      if (cover && cover[0] < cover[1]) await mergeCoverage(trx, symbol, tf, cover[0], cover[1]);
    });
  }

  async range(symbol: string, tf: NativeTimeframe, from: number, to: number): Promise<Bar[]> {
    const rows = await this.db.selectFrom('bars').selectAll()
      .where('symbol', '=', symbol).where('tf', '=', tf).where('ts', '>=', from).where('ts', '<', to)
      .orderBy('ts', 'asc').execute();
    return rows.map(toBar);
  }

  /**
   * Applies split ops for `symbol` in ONE transaction: per op, coverage at/after `cut` is removed (ranges straddling
   * it are trimmed) before the bars at/after `cut` are deleted, and older bars are rescaled by `factor`. The
   * symbol's `splits_checked_at` is set to `checkedAt` in the same transaction, so a split can never be applied
   * (rescaled) twice: either everything commits, including the stamp, or nothing does.
   */
  async applySplit(symbol: string, ops: SplitOp[], checkedAt: number, splitDays: number[] = [], trackFrom?: number): Promise<void> {
    await this.db.transaction().execute(async trx => {
      await lockSymbol(trx, this.dialect, symbol); // never interleaved with a fill of the same symbol (store)
      for (const op of ops) {
        await trx.deleteFrom('coverage').where('symbol', '=', symbol).where('tf', '=', op.tf).where('from_ts', '>=', op.cut).execute();
        await trx.updateTable('coverage').set({ to_ts: op.cut })
          .where('symbol', '=', symbol).where('tf', '=', op.tf).where('to_ts', '>', op.cut).execute();
        await trx.deleteFrom('bars').where('symbol', '=', symbol).where('tf', '=', op.tf).where('ts', '>=', op.cut).execute();
        const f = op.factor;
        if (f !== undefined) {
          if (!Number.isFinite(f) || !(f > 0)) throw new RangeError(`applySplit: invalid factor ${f}`);
          await trx.updateTable('bars').set(eb => ({
            open: eb('open', '/', f), high: eb('high', '/', f), low: eb('low', '/', f), close: eb('close', '/', f),
            volume: eb('volume', '*', f),
          })).where('symbol', '=', symbol).where('tf', '=', op.tf).where('ts', '<', op.cut).execute();
        }
      }
      await trx.updateTable('symbols').set(checkStamp(checkedAt, trackFrom)).where('id', '=', symbol).execute();
      if (splitDays.length > 0) {
        await trx.insertInto('applied_splits').values([...new Set(splitDays)].map(ts => ({ symbol, ts })))
          .onConflict(oc => oc.columns(['symbol', 'ts']).doNothing()).execute();
      }
    });
  }

  /** True when any bar of `symbol` is cached (any timeframe). */
  async hasAny(symbol: string): Promise<boolean> {
    const r = await this.db.selectFrom('bars').select('ts').where('symbol', '=', symbol).limit(1).executeTakeFirst();
    return r !== undefined;
  }

  async lastBefore(symbol: string, tf: NativeTimeframe, ts: number): Promise<Bar | null> {
    const row = await this.db.selectFrom('bars').selectAll()
      .where('symbol', '=', symbol).where('tf', '=', tf).where('ts', '<', ts)
      .orderBy('ts', 'desc').limit(1).executeTakeFirst();
    return row ? toBar(row) : null;
  }
}

function toBar(r: Database['bars']): Bar {
  const bar: Bar = { ts: Number(r.ts), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
  if (r.session != null) bar.session = r.session as NonNullable<Bar['session']>;
  return bar;
}

export class CoverageRepo {
  constructor(private db: Kysely<Database>, private dialect: Dialect = 'sqlite') {}

  async list(symbol: string, tf: NativeTimeframe): Promise<Array<[number, number]>> {
    const rows = await this.db.selectFrom('coverage').select(['from_ts', 'to_ts'])
      .where('symbol', '=', symbol).where('tf', '=', tf).orderBy('from_ts', 'asc').execute();
    return rows.map(r => [Number(r.from_ts), Number(r.to_ts)]);
  }

  /** Merges [from, to) into the covered ranges. Empty/inverted ranges are a no-op; non-finite bounds throw. */
  async add(symbol: string, tf: NativeTimeframe, from: number, to: number): Promise<void> {
    checkRange(from, to);
    if (from >= to) return;
    await this.db.transaction().execute(async trx => {
      await lockSymbol(trx, this.dialect, symbol); // serialize concurrent merges (and splits) of the same symbol
      await mergeCoverage(trx, symbol, tf, from, to);
    });
  }
}

export interface SymbolInfoRow {
  id: string; name: string; exchange: string | null; pricePrecision: number; firstTs: number | null; updatedAt: number;
  /** Provider ticker; null/absent = derive from the id. */
  ticker?: string | null;
  /** Last stock-split check (read-only here; written by `markSplitsChecked`). */
  splitsCheckedAt?: number | null;
  /** Start of the applied-split record (read-only here; set on insert). */
  splitsTrackedFrom?: number | null;
}

export class SymbolRepo {
  constructor(private db: Kysely<Database>) {}

  async get(id: string): Promise<SymbolInfoRow | null> {
    const r = await this.db.selectFrom('symbols').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) return null;
    return {
      id: r.id, name: r.name, exchange: r.exchange, pricePrecision: r.price_precision,
      firstTs: r.first_ts == null ? null : Number(r.first_ts), updatedAt: Number(r.updated_at),
      ticker: r.ticker ?? null, splitsCheckedAt: r.splits_checked_at == null ? null : Number(r.splits_checked_at),
      splitsTrackedFrom: r.splits_tracked_from == null ? null : Number(r.splits_tracked_from),
    };
  }

  /** Inserts or updates metadata; `splits_checked_at` is set to `updatedAt` on insert only. */
  async upsert(row: SymbolInfoRow): Promise<void> {
    const v = {
      id: row.id, name: row.name, exchange: row.exchange, price_precision: row.pricePrecision, first_ts: row.firstTs,
      updated_at: row.updatedAt, ticker: row.ticker ?? null,
    };
    // A new row starts as "splits checked as of now": its bars are fetched after this point (updates keep the stamp).
    await this.db.insertInto('symbols').values({ ...v, splits_checked_at: row.updatedAt, splits_tracked_from: row.updatedAt })
      .onConflict(oc => oc.column('id').doUpdateSet({
        name: v.name, exchange: v.exchange, price_precision: v.price_precision, first_ts: v.first_ts, updated_at: v.updated_at, ticker: v.ticker,
      }))
      .execute();
  }

  /** The splits already applied to `id`'s cached bars, as NY trading dates (UTC midnight of the date). */
  async appliedSplits(id: string): Promise<Set<number>> {
    const rows = await this.db.selectFrom('applied_splits').select('ts').where('symbol', '=', id).execute();
    return new Set(rows.map(r => Number(r.ts)));
  }

  /** Stamps a split check; `trackFrom` starts the applied-split record of a row that has none (pre-migration 005). */
  async markSplitsChecked(id: string, ts: number, trackFrom?: number): Promise<void> {
    await this.db.updateTable('symbols').set(checkStamp(ts, trackFrom)).where('id', '=', id).execute();
  }
}

export class BasketRepo {
  constructor(private db: Kysely<Database>, private now: () => number = () => Date.now()) {}

  /** All baskets (created_at, id order) with their versions, read in a single joined query (atomic snapshot). */
  async list(): Promise<Basket[]> {
    const rows = await this.db.selectFrom('baskets as b')
      .leftJoin('basket_versions as v', 'v.basket_id', 'b.id')
      .select(['b.id', 'b.name', 'b.base_value', 'b.created_at', 'b.updated_at', 'v.basket_id', 'v.idx', 'v.effective_from', 'v.weights_json'])
      .orderBy('b.created_at', 'asc').orderBy('b.id', 'asc').orderBy('v.idx', 'asc')
      .execute();
    const out: Basket[] = [];
    let cur: Basket | undefined;
    for (const r of rows) {
      if (!cur || cur.id !== r.id) {
        cur = toBasket(r, []);
        out.push(cur);
      }
      if (r.basket_id !== null && r.idx !== null && r.effective_from !== null && r.weights_json !== null) {
        cur.versions.push(toVersion({ basket_id: r.basket_id, idx: r.idx, effective_from: r.effective_from, weights_json: r.weights_json }));
      }
    }
    return out;
  }

  async get(id: string): Promise<Basket | null> {
    return getBasket(this.db, id);
  }

  async create(b: Omit<Basket, 'createdAt' | 'updatedAt'>): Promise<Basket> {
    const now = this.now();
    await this.db.transaction().execute(async trx => {
      await trx.insertInto('baskets').values({ id: b.id, name: b.name, base_value: b.baseValue, created_at: now, updated_at: now }).execute();
      await insertVersions(trx, b.id, b.versions);
    });
    return { ...b, createdAt: now, updatedAt: now };
  }

  async update(id: string, patch: { name?: string; versions?: BasketVersion[] }): Promise<Basket | null> {
    return this.db.transaction().execute(async trx => {
      const exists = await trx.selectFrom('baskets').select('id').where('id', '=', id).executeTakeFirst();
      if (!exists) return null;
      const set: { updated_at: number; name?: string } = { updated_at: this.now() };
      if (patch.name !== undefined) set.name = patch.name;
      await trx.updateTable('baskets').set(set).where('id', '=', id).execute();
      if (patch.versions) {
        await trx.deleteFrom('basket_versions').where('basket_id', '=', id).execute();
        await insertVersions(trx, id, patch.versions);
      }
      return getBasket(trx, id);
    });
  }

  /**
   * Appends `v` as the last version, in one transaction, provided the stored versions still equal `expected` (what
   * the caller validated the new list against): null = no such basket, 'conflict' = the versions changed meanwhile.
   */
  async appendVersion(id: string, v: BasketVersion, expected: BasketVersion[]): Promise<Basket | null | 'conflict'> {
    return this.db.transaction().execute(async trx => {
      // Touching the row first locks it (Postgres), so a concurrent append waits here and then reads the
      // committed versions; SQLite runs one transaction at a time anyway.
      const touched = await trx.updateTable('baskets').set({ updated_at: this.now() }).where('id', '=', id).executeTakeFirst();
      if (Number(touched.numUpdatedRows) === 0) return null;
      const current = await getBasket(trx, id);
      if (!current || JSON.stringify(current.versions) !== JSON.stringify(expected)) return 'conflict';
      await trx.insertInto('basket_versions')
        .values({ basket_id: id, idx: current.versions.length, effective_from: v.effectiveFrom, weights_json: JSON.stringify(v.weights) })
        .execute();
      return getBasket(trx, id);
    });
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.deleteFrom('baskets').where('id', '=', id).executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }
}

async function insertVersions(db: Kysely<Database>, basketId: string, versions: BasketVersion[]): Promise<void> {
  if (versions.length === 0) return;
  await db.insertInto('basket_versions').values(
    versions.map((v, idx) => ({ basket_id: basketId, idx, effective_from: v.effectiveFrom, weights_json: JSON.stringify(v.weights) })),
  ).execute();
}

async function getBasket(db: Kysely<Database>, id: string): Promise<Basket | null> {
  const r = await db.selectFrom('baskets').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) return null;
  const vers = await db.selectFrom('basket_versions').selectAll().where('basket_id', '=', id).orderBy('idx', 'asc').execute();
  return toBasket(r, vers.map(toVersion));
}

function toVersion(v: Database['basket_versions']): BasketVersion {
  return { effectiveFrom: v.effective_from, weights: parseJson<BasketVersion['weights']>(v.weights_json, `basket_versions basket_id=${v.basket_id} idx=${v.idx}`) };
}

function toBasket(r: Database['baskets'], versions: BasketVersion[]): Basket {
  return { id: r.id, name: r.name, baseValue: r.base_value, versions, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

export class WatchlistRepo {
  constructor(private db: Kysely<Database>) {}

  async list(): Promise<WatchlistEntry[]> {
    const rows = await this.db.selectFrom('watchlist_entries').selectAll().orderBy('position', 'asc').execute();
    const out: WatchlistEntry[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.kind === 'symbol') {
        // Ids are normalized on write; a stray old spelling is normalized here, an invalid one dropped.
        const id = tryNormalizeSymbolId(r.symbol);
        if (id !== null && !seen.has(id)) {
          seen.add(id);
          out.push({ type: 'symbol', id });
        }
      } else if (r.kind === 'section' && r.section_id !== null) {
        out.push({ type: 'section', id: r.section_id, title: r.title ?? '', collapsed: Number(r.collapsed) === 1 });
      }
    }
    return out;
  }

  /** Replaces the whole list; a repeated symbol or section id keeps its first occurrence. */
  async replace(entries: WatchlistEntry[]): Promise<void> {
    const symbols = new Set<string>();
    const sections = new Set<string>();
    const unique = entries.filter(e => {
      const seen = e.type === 'symbol' ? symbols : sections;
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    const rows = unique.map((e, position) => e.type === 'symbol'
      ? { position, kind: 'symbol', symbol: e.id, section_id: null, title: null, collapsed: null }
      : { position, kind: 'section', symbol: null, section_id: e.id, title: e.title, collapsed: e.collapsed ? 1 : 0 });
    const legacy = watchlistSymbols(unique).map((symbol, position) => ({ symbol, position }));
    await this.db.transaction().execute(async trx => {
      await trx.deleteFrom('watchlist_entries').execute();
      if (rows.length > 0) await trx.insertInto('watchlist_entries').values(rows).execute();
      // Mirror the symbols into the legacy table, read by an older server after a manual rollback (see README).
      await trx.deleteFrom('watchlist').execute();
      if (legacy.length > 0) await trx.insertInto('watchlist').values(legacy).execute();
    });
  }
}

export class LayoutRepo {
  constructor(private db: Kysely<Database>) {}

  async get(key: string): Promise<Layout | null> {
    const r = await this.db.selectFrom('layouts').select('json').where('key', '=', key).executeTakeFirst();
    return r ? parseJson<Layout>(r.json, `layouts key=${key}`) : null;
  }

  async put(key: string, l: Layout): Promise<void> {
    const json = JSON.stringify(l);
    const updated_at = Date.now();
    await this.db.insertInto('layouts').values({ key, json, updated_at })
      .onConflict(oc => oc.column('key').doUpdateSet({ json, updated_at })).execute();
  }
}

export class DrawingRepo {
  constructor(private db: Kysely<Database>) {}

  async get(symbol: SymbolId): Promise<DrawingState[]> {
    const r = await this.db.selectFrom('drawings').select('json').where('symbol', '=', symbol).executeTakeFirst();
    return r ? parseJson<DrawingState[]>(r.json, `drawings symbol=${symbol}`) : [];
  }

  async put(symbol: SymbolId, d: DrawingState[]): Promise<void> {
    const json = JSON.stringify(d);
    const updated_at = Date.now();
    await this.db.insertInto('drawings').values({ symbol, json, updated_at })
      .onConflict(oc => oc.column('symbol').doUpdateSet({ json, updated_at })).execute();
  }
}

export class SettingsRepo {
  constructor(private db: Kysely<Database>) {}

  async get(key: string): Promise<string | null> {
    const r = await this.db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
    return r?.value ?? null;
  }

  /** The stored value of `key`, storing `make()` first when there is none (the first writer wins). */
  async getOrCreate(key: string, make: () => string): Promise<string> {
    await this.db.insertInto('settings').values({ key, value: make() }).onConflict(oc => oc.column('key').doNothing()).execute();
    const v = await this.get(key);
    if (v === null) throw new Error(`setting ${key} could not be stored`);
    return v;
  }

  /** The cookie signing secret used when CHARTMATE_SESSION_SECRET is unset: 32 random bytes, generated once. */
  sessionSecret(): Promise<string> {
    return this.getOrCreate('session_secret', () => randomBytes(32).toString('hex'));
  }
}

export interface Repos {
  bars: BarRepo;
  coverage: CoverageRepo;
  symbols: SymbolRepo;
  baskets: BasketRepo;
  watchlist: WatchlistRepo;
  layouts: LayoutRepo;
  drawings: DrawingRepo;
  settings: SettingsRepo;
}

/** `opts.now`: clock for the baskets' created / updated stamps (tests). */
export function createRepos(db: Kysely<Database>, dialect?: Dialect, opts: { now?: () => number } = {}): Repos {
  const d: Dialect = dialect ?? (db.getExecutor().adapter instanceof PostgresAdapter ? 'postgres' : 'sqlite');
  return {
    bars: new BarRepo(db, d),
    coverage: new CoverageRepo(db, d),
    symbols: new SymbolRepo(db),
    baskets: new BasketRepo(db, opts.now),
    watchlist: new WatchlistRepo(db),
    layouts: new LayoutRepo(db),
    drawings: new DrawingRepo(db),
    settings: new SettingsRepo(db),
  };
}
