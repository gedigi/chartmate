import { PostgresAdapter, sql, type Kysely } from 'kysely';
import type { Bar, Basket, BasketVersion, DrawingState, Layout, NativeTimeframe, SymbolId } from '@altv/shared';
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

export class BarRepo {
  constructor(private db: Kysely<Database>) {}

  async upsert(symbol: string, tf: NativeTimeframe, bars: Bar[]): Promise<void> {
    const byTs = new Map<number, Bar>();
    for (const b of bars) byTs.set(b.ts, b); // last wins; Postgres rejects duplicate keys within one statement
    const unique = [...byTs.values()];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const rows = unique.slice(i, i + CHUNK).map(b => ({
        symbol, tf, ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, session: b.session ?? null,
      }));
      await this.db.insertInto('bars').values(rows)
        .onConflict(oc => oc.columns(['symbol', 'tf', 'ts']).doUpdateSet(eb => ({
          open: eb.ref('excluded.open'), high: eb.ref('excluded.high'), low: eb.ref('excluded.low'),
          close: eb.ref('excluded.close'), volume: eb.ref('excluded.volume'), session: eb.ref('excluded.session'),
        })))
        .execute();
    }
  }

  async range(symbol: string, tf: NativeTimeframe, from: number, to: number): Promise<Bar[]> {
    const rows = await this.db.selectFrom('bars').selectAll()
      .where('symbol', '=', symbol).where('tf', '=', tf).where('ts', '>=', from).where('ts', '<', to)
      .orderBy('ts', 'asc').execute();
    return rows.map(toBar);
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
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError(`coverage.add: non-finite range [${from}, ${to})`);
    if (from >= to) return;
    await this.db.transaction().execute(async trx => {
      if (this.dialect === 'postgres') {
        // serialize concurrent merges for the same series
        await sql`select pg_advisory_xact_lock(hashtext(${symbol + ':' + tf}))`.execute(trx);
      }
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
    });
  }
}

export interface SymbolInfoRow { id: string; name: string; exchange: string | null; pricePrecision: number; firstTs: number | null; updatedAt: number }

export class SymbolRepo {
  constructor(private db: Kysely<Database>) {}

  async get(id: string): Promise<SymbolInfoRow | null> {
    const r = await this.db.selectFrom('symbols').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) return null;
    return { id: r.id, name: r.name, exchange: r.exchange, pricePrecision: r.price_precision, firstTs: r.first_ts == null ? null : Number(r.first_ts), updatedAt: Number(r.updated_at) };
  }

  async upsert(row: SymbolInfoRow): Promise<void> {
    const v = { id: row.id, name: row.name, exchange: row.exchange, price_precision: row.pricePrecision, first_ts: row.firstTs, updated_at: row.updatedAt };
    await this.db.insertInto('symbols').values(v)
      .onConflict(oc => oc.column('id').doUpdateSet({ name: v.name, exchange: v.exchange, price_precision: v.price_precision, first_ts: v.first_ts, updated_at: v.updated_at }))
      .execute();
  }
}

export class BasketRepo {
  constructor(private db: Kysely<Database>) {}

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
    const now = Date.now();
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
      const set: { updated_at: number; name?: string } = { updated_at: Date.now() };
      if (patch.name !== undefined) set.name = patch.name;
      await trx.updateTable('baskets').set(set).where('id', '=', id).execute();
      if (patch.versions) {
        await trx.deleteFrom('basket_versions').where('basket_id', '=', id).execute();
        await insertVersions(trx, id, patch.versions);
      }
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

  async list(): Promise<SymbolId[]> {
    const rows = await this.db.selectFrom('watchlist').select('symbol').orderBy('position', 'asc').execute();
    return rows.map(r => r.symbol);
  }

  async replace(ids: SymbolId[]): Promise<void> {
    const unique = [...new Set(ids)];
    await this.db.transaction().execute(async trx => {
      await trx.deleteFrom('watchlist').execute();
      if (unique.length > 0) await trx.insertInto('watchlist').values(unique.map((symbol, position) => ({ symbol, position }))).execute();
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

export interface Repos {
  bars: BarRepo;
  coverage: CoverageRepo;
  symbols: SymbolRepo;
  baskets: BasketRepo;
  watchlist: WatchlistRepo;
  layouts: LayoutRepo;
  drawings: DrawingRepo;
}

export function createRepos(db: Kysely<Database>, dialect?: Dialect): Repos {
  const d: Dialect = dialect ?? (db.getExecutor().adapter instanceof PostgresAdapter ? 'postgres' : 'sqlite');
  return {
    bars: new BarRepo(db),
    coverage: new CoverageRepo(db, d),
    symbols: new SymbolRepo(db),
    baskets: new BasketRepo(db),
    watchlist: new WatchlistRepo(db),
    layouts: new LayoutRepo(db),
    drawings: new DrawingRepo(db),
  };
}
