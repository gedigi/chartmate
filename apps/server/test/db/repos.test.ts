import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createDb } from '../../src/db/connect.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos } from '../../src/db/repos.js';
import { sql } from 'kysely';

const urls = ['sqlite::memory:', ...(process.env.TEST_PG_URL ? [process.env.TEST_PG_URL] : [])];
describe.each(urls)('repos on %s', (url) => {
  const h = createDb(url);
  const r = createRepos(h.db);
  beforeEach(async () => {
    for (const t of ['basket_versions','baskets','bars','coverage','symbols','watchlist','layouts','drawings','kysely_migration','kysely_migration_lock'])
      await sql`drop table if exists ${sql.table(t)}`.execute(h.db);
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
    await r.watchlist.replace(['stock:A', 'crypto:BTC']);
    expect(await r.watchlist.list()).toEqual(['stock:A', 'crypto:BTC']);
    const l = { symbol: 'stock:A', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] } as const;
    await r.layouts.put('default', l as any);
    expect(await r.layouts.get('default')).toEqual(l);
    expect(await r.drawings.get('stock:A')).toEqual([]);
    await r.drawings.put('stock:A', [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }]);
    expect((await r.drawings.get('stock:A'))[0]!.name).toBe('segment');
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
    expect(await r.symbols.get('stock:A')).toEqual({ ...row, ticker: null, splitsCheckedAt: null });
    await r.symbols.upsert({ ...row, name: 'B', exchange: null, firstTs: null, ticker: 'A.X' });
    expect(await r.symbols.get('stock:A')).toEqual({ ...row, name: 'B', exchange: null, firstTs: null, ticker: 'A.X', splitsCheckedAt: null });
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
    await r.watchlist.replace(['stock:B', 'stock:A', 'stock:B', 'crypto:C', 'stock:A']);
    expect(await r.watchlist.list()).toEqual(['stock:B', 'stock:A', 'crypto:C']);
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
});
