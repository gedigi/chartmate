import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createDb } from '../../src/db/connect.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos } from '../../src/db/repos.js';
import { sql } from 'kysely';
import type { WatchlistEntry } from '@chartmate/shared';

const sym = (id: string): WatchlistEntry => ({ type: 'symbol', id });
const SEC_A = '0b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f60';
const SEC_B = '1b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f61';
const SEC_C = '2b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f62';

const TABLES = ['basket_versions','baskets','bars','coverage','symbols','watchlist','watchlist_entries','layouts','drawings','kysely_migration','kysely_migration_lock'];
const urls = ['sqlite::memory:', ...(process.env.TEST_PG_URL ? [process.env.TEST_PG_URL] : [])];
describe.each(urls)('repos on %s', (url) => {
  const h = createDb(url);
  const r = createRepos(h.db);
  beforeEach(async () => {
    for (const t of TABLES) await sql`drop table if exists ${sql.table(t)}`.execute(h.db);
    await migrate(h.db);
  });
  afterAll(() => h.close());

  it('bars upsert/range/lastBefore with session round-trip', async () => {
    await r.bars.upsert('stock:A', '1h', [
      { ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, session: 'pre' },
      { ts: 2000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 3 },
    ]);
    await r.bars.upsert('stock:A', '1h', [{ ts: 2000, open: 1.5, high: 3, low: 1, close: 2.5, volume: 4 }]);
    const rows = await r.bars.range('stock:A', '1h', 0, 3000);
    expect(rows).toEqual([
      { ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, session: 'pre' },
      { ts: 2000, open: 1.5, high: 3, low: 1, close: 2.5, volume: 4 },
    ]);
    expect(await r.bars.range('stock:A', '1h', 1000, 2000)).toHaveLength(1);
    expect((await r.bars.lastBefore('stock:A', '1h', 2000))?.ts).toBe(1000);
    expect(typeof rows[0]!.ts).toBe('number');
  });
  it('large timestamps survive (bigint)', async () => {
    const ts = Date.UTC(2030, 0, 1);
    await r.bars.upsert('crypto:BTC', '1m', [{ ts, open: 1, high: 1, low: 1, close: 1, volume: 0 }]);
    expect((await r.bars.range('crypto:BTC', '1m', ts, ts + 1))[0]!.ts).toBe(ts);
  });
  it('coverage merges overlapping and adjacent ranges', async () => {
    await r.coverage.add('s', '1D', 0, 10);
    await r.coverage.add('s', '1D', 20, 30);
    await r.coverage.add('s', '1D', 10, 15);
    await r.coverage.add('s', '1D', 14, 21);
    expect(await r.coverage.list('s', '1D')).toEqual([[0, 30]]);
    expect(await r.coverage.list('s', '1h')).toEqual([]);
  });
  it('baskets CRUD with versions', async () => {
    const b = await r.baskets.create({ id: 'b1', name: 'Tech', baseValue: 100, versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:A': 1 } }] });
    expect(b.createdAt).toBeGreaterThan(0);
    const u = await r.baskets.update('b1', { versions: [...b.versions, { effectiveFrom: '2024-02-01', weights: { 'stock:A': 0.5, 'crypto:BTC': 0.5 } }] });
    expect(u!.versions).toHaveLength(2);
    expect(u!.versions[1]!.weights).toEqual({ 'stock:A': 0.5, 'crypto:BTC': 0.5 });
    expect(b.versions[0]!.weights).toEqual({ 'stock:A': 1 });
    expect((await r.baskets.list()).map(x => x.id)).toEqual(['b1']);
    expect(await r.baskets.delete('b1')).toBe(true);
    expect(await r.baskets.get('b1')).toBeNull();
    expect(await r.baskets.update('nope', { name: 'x' })).toBeNull();
  });
  it('watchlist, layouts, drawings', async () => {
    await r.watchlist.replace([sym('stock:A'), sym('crypto:BTC')]);
    expect(await r.watchlist.list()).toEqual([sym('stock:A'), sym('crypto:BTC')]);
    const l = { symbol: 'stock:A', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] } as const;
    await r.layouts.put('default', l as any);
    expect(await r.layouts.get('default')).toEqual(l);
    expect(await r.drawings.get('stock:A')).toEqual([]);
    await r.drawings.put('stock:A', [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }]);
    expect((await r.drawings.get('stock:A'))[0]!.name).toBe('segment');
  });
  it('bars store writes the bars and their coverage together; nothing to store is a no-op', async () => {
    const bar = { ts: 5, open: 1, high: 1, low: 1, close: 1, volume: 1 };
    await r.bars.store('stock:ST', '1D', [bar], [0, 10]);
    expect(await r.bars.range('stock:ST', '1D', 0, 10)).toEqual([bar]);
    expect(await r.coverage.list('stock:ST', '1D')).toEqual([[0, 10]]);
    await r.bars.store('stock:ST', '1D', [], null);
    await r.bars.store('stock:ST', '1D', [], [20, 20]);
    await r.bars.store('stock:ST', '1D', [], [10, 20]); // empty but trusted: covered
    expect(await r.coverage.list('stock:ST', '1D')).toEqual([[0, 20]]);
    await r.bars.store('stock:ST', '1D', [{ ...bar, ts: 30 }], null); // bars without coverage
    expect(await r.coverage.list('stock:ST', '1D')).toEqual([[0, 20]]);
    expect(await r.bars.range('stock:ST', '1D', 0, 40)).toHaveLength(2);
    await Promise.all([[40, 50], [45, 60], [100, 110]].map(([a, b]) => r.bars.store('stock:ST', '1D', [{ ...bar, ts: a! }], [a!, b!])));
    expect(await r.coverage.list('stock:ST', '1D')).toEqual([[0, 20], [40, 60], [100, 110]]);
  });
  it('coverage add is safe under concurrency', async () => {
    await Promise.all([[0, 10], [5, 15], [12, 20], [20, 30], [28, 40], [100, 110]].map(([a, b]) => r.coverage.add('c', '1D', a!, b!)));
    expect(await r.coverage.list('c', '1D')).toEqual([[0, 40], [100, 110]]);
  });
  it('bars upsert tolerates duplicate ts in one call (last wins)', async () => {
    await r.bars.upsert('d', '1m', [
      { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { ts: 1, open: 2, high: 2, low: 2, close: 2, volume: 2 },
    ]);
    const rows = await r.bars.range('d', '1m', 0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.close).toBe(2);
  });
  it('deleting a basket cascades to versions', async () => {
    await r.baskets.create({ id: 'bc', name: 'C', baseValue: 1, versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:A': 1 } }] });
    await r.baskets.delete('bc');
    const left = await h.db.selectFrom('basket_versions').selectAll().where('basket_id', '=', 'bc').execute();
    expect(left).toEqual([]);
  });
  it('symbols get/upsert round-trip', async () => {
    expect(await r.symbols.get('stock:A')).toBeNull();
    const row = { id: 'stock:A', name: 'A Inc', exchange: 'NYSE', pricePrecision: 2, firstTs: Date.UTC(1999, 0, 1), updatedAt: Date.UTC(2030, 0, 1) };
    await r.symbols.upsert(row);
    expect(await r.symbols.get('stock:A')).toEqual({ ...row, ticker: null, splitsCheckedAt: row.updatedAt }); // insert stamps the split check
    await r.symbols.upsert({ ...row, name: 'B', exchange: null, firstTs: null, ticker: 'A.X' });
    expect(await r.symbols.get('stock:A')).toEqual({ ...row, name: 'B', exchange: null, firstTs: null, ticker: 'A.X', splitsCheckedAt: row.updatedAt });
  });
  it('symbols splits_checked_at is set separately and survives upserts; bars/coverage deleteSymbol', async () => {
    const row = { id: 'stock:S', name: 'S', exchange: null, pricePrecision: 2, firstTs: null, updatedAt: 1 };
    await r.symbols.upsert(row);
    const at = Date.UTC(2031, 0, 1);
    await r.symbols.markSplitsChecked('stock:S', at);
    await r.symbols.upsert({ ...row, updatedAt: 2 });
    expect((await r.symbols.get('stock:S'))?.splitsCheckedAt).toBe(at);
    const bar = { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 };
    await r.bars.upsert('stock:S', '1D', [bar]);
    await r.bars.upsert('stock:S', '1h', [bar]);
    await r.bars.upsert('stock:T', '1D', [bar]);
    await r.coverage.add('stock:S', '1D', 0, 10);
    await r.coverage.add('stock:T', '1D', 0, 10);
    await r.bars.deleteSymbol('stock:S');
    await r.coverage.deleteSymbol('stock:S');
    expect(await r.bars.range('stock:S', '1D', 0, 10)).toEqual([]);
    expect(await r.bars.range('stock:S', '1h', 0, 10)).toEqual([]);
    expect(await r.bars.range('stock:T', '1D', 0, 10)).toHaveLength(1);
    expect(await r.coverage.list('stock:S', '1D')).toEqual([]);
    expect(await r.coverage.list('stock:T', '1D')).toEqual([[0, 10]]);
  });
  it('baskets list: ordered by created_at then id, each with its own versions in idx order', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1000);
      await r.baskets.create({ id: 'z', name: 'Z', baseValue: 1, versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:Z': 1 } }] });
      now.mockReturnValue(2000);
      await r.baskets.create({ id: 'm', name: 'M', baseValue: 1, versions: [
        { effectiveFrom: '2024-01-02', weights: { 'stock:M': 1 } },
        { effectiveFrom: '2024-02-02', weights: { 'stock:N': 1 } },
      ] });
      await r.baskets.create({ id: 'a', name: 'A', baseValue: 1, versions: [{ effectiveFrom: '2024-01-03', weights: { 'stock:A': 1 } }] });
    } finally {
      now.mockRestore();
    }
    const list = await r.baskets.list();
    expect(list.map(b => b.id)).toEqual(['z', 'a', 'm']);
    expect(list[2]!.versions.map(v => Object.keys(v.weights)[0])).toEqual(['stock:M', 'stock:N']);
    expect(list[1]!.versions).toEqual([{ effectiveFrom: '2024-01-03', weights: { 'stock:A': 1 } }]);
  });
  it('bars upsert across chunk boundaries (1203 bars)', async () => {
    const bars = Array.from({ length: 1203 }, (_, i) => ({ ts: i * 60_000, open: i, high: i, low: i, close: i, volume: i }));
    await r.bars.upsert('chunk', '1m', bars);
    const rows = await r.bars.range('chunk', '1m', 0, Number.MAX_SAFE_INTEGER);
    expect(rows).toHaveLength(1203);
    expect(rows[499]!.close).toBe(499);
    expect(rows[500]!.close).toBe(500);
    expect(rows[1000]!.close).toBe(1000);
    expect(rows[1202]!.close).toBe(1202);
  });
  it('watchlist replace with duplicates keeps first-occurrence order', async () => {
    await r.watchlist.replace(['stock:B', 'stock:A', 'stock:B', 'crypto:C', 'stock:A'].map(sym));
    expect(await r.watchlist.list()).toEqual(['stock:B', 'stock:A', 'crypto:C'].map(sym));
  });
  it('watchlist sections round-trip (order, titles, collapsed); replace overwrites', async () => {
    const list: WatchlistEntry[] = [
      sym('stock:SPY'),
      { type: 'section', id: SEC_A, title: 'Tech — “big”', collapsed: true },
      sym('stock:AAPL'),
      { type: 'section', id: SEC_B, title: 'Empty', collapsed: false },
      { type: 'section', id: SEC_C, title: 'Crypto', collapsed: false },
      sym('crypto:BTC'),
    ];
    await r.watchlist.replace(list);
    expect(await r.watchlist.list()).toEqual(list);
    await r.watchlist.replace([sym('crypto:ETH')]);
    expect(await r.watchlist.list()).toEqual([sym('crypto:ETH')]);
    await r.watchlist.replace([]);
    expect(await r.watchlist.list()).toEqual([]);
  });
  it('migration 003 copies the legacy watchlist (in order) and is idempotent', async () => {
    for (const t of TABLES) await sql`drop table if exists ${sql.table(t)}`.execute(h.db);
    await migrate(h.db, '002_symbol_splits');
    await h.db.insertInto('watchlist').values([
      { symbol: 'crypto:BTC', position: 2 }, { symbol: 'stock:SPY', position: 0 }, { symbol: 'stock:AAPL', position: 1 },
    ]).execute();
    await migrate(h.db);
    const expected = ['stock:SPY', 'stock:AAPL', 'crypto:BTC'].map(sym);
    expect(await r.watchlist.list()).toEqual(expected);
    // A re-run (e.g. after a partially recorded run) neither fails nor duplicates rows.
    await h.db.deleteFrom('kysely_migration' as any).where('name' as any, '>=', '003_watchlist_sections').execute();
    await migrate(h.db);
    expect(await r.watchlist.list()).toEqual(expected);
    // Once migrated, the new table is authoritative: edits are not overwritten by a later re-run.
    await r.watchlist.replace([sym('crypto:ETH')]);
    await h.db.deleteFrom('kysely_migration' as any).where('name' as any, '>=', '003_watchlist_sections').execute();
    await migrate(h.db);
    expect(await r.watchlist.list()).toEqual([sym('crypto:ETH')]);
  });
  it('migration 004 rewrites ids stored by older versions to their canonical spelling', async () => {
    for (const t of TABLES) await sql`drop table if exists ${sql.table(t)}`.execute(h.db);
    await migrate(h.db, '003_watchlist_sections');
    const L = (symbol: string, extra: object = {}) => JSON.stringify({ symbol, tf: '1D', session: 'rth', chartType: 'candle', indicators: [], ...extra });
    await h.db.insertInto('watchlist_entries').values([
      { position: 0, kind: 'symbol', symbol: 'stock:aapl', section_id: null, title: null, collapsed: null },
      { position: 1, kind: 'section', symbol: null, section_id: SEC_A, title: 'Tech', collapsed: 0 },
      { position: 2, kind: 'symbol', symbol: 'stock:AAPL', section_id: null, title: null, collapsed: null },
      { position: 3, kind: 'symbol', symbol: 'stock:bad/id', section_id: null, title: null, collapsed: null },
      { position: 4, kind: 'symbol', symbol: 'crypto:btc', section_id: null, title: null, collapsed: null },
    ]).execute();
    await h.db.insertInto('watchlist').values([{ symbol: 'stock:aapl', position: 0 }, { symbol: 'crypto:btc', position: 1 }]).execute();
    await h.db.insertInto('layouts').values([
      { key: 'default', json: L('crypto:eth'), updated_at: 1 },
      { key: 'sym:stock:msft', json: L('stock:msft', { tf: '1h' }), updated_at: 5 },
      { key: 'sym:stock:MSFT', json: L('stock:MSFT', { tf: '1W' }), updated_at: 3 },
      { key: 'sym:stock:x y', json: L('stock:x y'), updated_at: 1 },
      { key: 'sym:crypto:SOL', json: L('nonsense'), updated_at: 1 },
    ]).execute();
    const d = (name: string) => ({ name, points: [], lock: false });
    await h.db.insertInto('drawings').values([
      { symbol: 'stock:spy', json: JSON.stringify([d('a')]), updated_at: 1 },
      { symbol: 'stock:SPY', json: JSON.stringify([d('b')]), updated_at: 2 },
      { symbol: 'stock:QQQ', json: JSON.stringify([d('c')]), updated_at: 2 },
      { symbol: 'stock:no/pe', json: JSON.stringify([d('x')]), updated_at: 2 },
    ]).execute();
    await h.db.insertInto('baskets').values({ id: 'b1', name: 'B', base_value: 100, created_at: 1, updated_at: 1 }).execute();
    await h.db.insertInto('basket_versions').values([
      { basket_id: 'b1', idx: 0, effective_from: '2024-01-02', weights_json: JSON.stringify({ 'stock:aapl': 0.25, 'stock:AAPL': 0.25, 'crypto:BTC': 0.5 }) },
      { basket_id: 'b1', idx: 1, effective_from: '2024-02-01', weights_json: JSON.stringify({ 'stock:bad/x': 0.5, 'crypto:eth': 0.5 }) },
    ]).execute();
    await r.bars.upsert('crypto:btc', '1D', [{ ts: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    await r.bars.upsert('crypto:BTC', '1D', [{ ts: 0, open: 2, high: 2, low: 2, close: 2, volume: 2 }]);
    await r.coverage.add('crypto:btc', '1D', 0, 10);
    await h.db.insertInto('symbols').values({ id: 'crypto:btc', name: 'x', exchange: null, price_precision: 2, first_ts: null, updated_at: 1, ticker: null, splits_checked_at: null }).execute();

    await migrate(h.db);

    expect(await r.watchlist.list()).toEqual([
      sym('stock:AAPL'), { type: 'section', id: SEC_A, title: 'Tech', collapsed: false }, sym('crypto:BTC'),
    ]);
    const legacy = await h.db.selectFrom('watchlist').selectAll().orderBy('position').execute();
    expect(legacy.map((x) => x.symbol)).toEqual(['stock:AAPL', 'crypto:BTC']);
    const keys = (await h.db.selectFrom('layouts').select('key').orderBy('key').execute()).map((x) => x.key);
    expect(keys).toEqual(['default', 'sym:crypto:SOL', 'sym:stock:MSFT']);
    expect(await r.layouts.get('default')).toMatchObject({ symbol: 'crypto:ETH' });
    expect(await r.layouts.get('sym:stock:MSFT')).toMatchObject({ symbol: 'stock:MSFT', tf: '1h' }); // newest variant wins
    expect(await r.layouts.get('sym:crypto:SOL')).toMatchObject({ symbol: 'crypto:BTC' }); // invalid → fallback
    expect((await r.drawings.get('stock:SPY')).map((x) => x.name)).toEqual(['a', 'b']);
    expect((await r.drawings.get('stock:QQQ')).map((x) => x.name)).toEqual(['c']);
    expect(await h.db.selectFrom('drawings').select('symbol').where('symbol', '=', 'stock:no/pe').execute()).toEqual([]);
    const b = await r.baskets.get('b1');
    expect(b!.versions.map((v) => v.weights)).toEqual([{ 'stock:AAPL': 0.5, 'crypto:BTC': 0.5 }, { 'crypto:ETH': 1 }]);
    expect(await r.bars.range('crypto:BTC', '1D', 0, 1)).toEqual([{ ts: 0, open: 2, high: 2, low: 2, close: 2, volume: 2 }]);
    expect(await r.bars.hasAny('crypto:btc')).toBe(false);
    expect(await r.coverage.list('crypto:btc', '1D')).toEqual([]);
    expect(await r.symbols.get('crypto:btc')).toBeNull();

    // Idempotent: a re-run changes nothing.
    await h.db.deleteFrom('kysely_migration' as any).where('name' as any, '>=', '004_symbol_ids').execute();
    await migrate(h.db);
    expect((await r.drawings.get('stock:SPY')).map((x) => x.name)).toEqual(['a', 'b']);
    expect(await r.watchlist.list()).toHaveLength(3);
  });
  it('corrupt JSON rows raise a descriptive error', async () => {
    await h.db.insertInto('layouts').values({ key: 'bad', json: '{nope', updated_at: 1 }).execute();
    await expect(r.layouts.get('bad')).rejects.toThrow(/corrupt JSON in layouts key=bad/);
    await h.db.insertInto('drawings').values({ symbol: 'stock:X', json: '[', updated_at: 1 }).execute();
    await expect(r.drawings.get('stock:X')).rejects.toThrow(/corrupt JSON in drawings symbol=stock:X/);
    await r.baskets.create({ id: 'cj', name: 'C', baseValue: 1, versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:A': 1 } }] });
    await h.db.updateTable('basket_versions').set({ weights_json: 'x' }).where('basket_id', '=', 'cj').execute();
    await expect(r.baskets.get('cj')).rejects.toThrow(/corrupt JSON in basket_versions basket_id=cj idx=0/);
    await expect(r.baskets.list()).rejects.toThrow(/corrupt JSON/);
  });
  it('coverage add: empty/inverted range is a no-op, non-finite throws', async () => {
    await r.coverage.add('e', '1D', 10, 10);
    await r.coverage.add('e', '1D', 20, 5);
    expect(await r.coverage.list('e', '1D')).toEqual([]);
    await r.coverage.add('e', '1D', 0, 10);
    await r.coverage.add('e', '1D', 10, 10); // touching but empty: still a no-op
    expect(await r.coverage.list('e', '1D')).toEqual([[0, 10]]);
    await expect(r.coverage.add('e', '1D', NaN, 10)).rejects.toThrow(RangeError);
    await expect(r.coverage.add('e', '1D', 0, Infinity)).rejects.toThrow(RangeError);
  });
  it('migration 002 is idempotent when its columns already exist', async () => {
    // Kysely re-runs migrations in order only, so the later ones are re-run (idempotently) too.
    await h.db.deleteFrom('kysely_migration' as any).where('name' as any, '>=', '002_symbol_splits').execute();
    await expect(migrate(h.db)).resolves.toBeUndefined();
    const row = { id: 'stock:M', name: 'M', exchange: null, pricePrecision: 2, firstTs: null, updatedAt: 5, ticker: 'M' };
    await r.symbols.upsert(row);
    expect(await r.symbols.get('stock:M')).toEqual({ ...row, splitsCheckedAt: 5 });
  });
});
