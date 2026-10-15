import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../src/db/connect.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import { ProviderError } from '../../src/errors.js';
import { MarketDataService } from '../../src/market/service.js';
import { RequestQueue } from '../../src/providers/queue.js';
import { FakeProvider } from '../helpers/fakeProvider.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4, 18, 20);

describe('MarketDataService stock split check', () => {
  let h: ReturnType<typeof createDb>;
  let repos: Repos;
  let now: number;
  let stock: FakeProvider;
  let crypto: FakeProvider;
  let svc: MarketDataService;
  const make = () => {
    const clock = () => now;
    const queues = {
      stock: new RequestQueue({ concurrency: 2, minIntervalMs: 0, now: clock }),
      crypto: new RequestQueue({ concurrency: 2, minIntervalMs: 0, now: clock }),
    };
    return new MarketDataService({ repos, registry: { stock, crypto }, now: clock, queues });
  };
  const daily = (s = svc) => s.getNativeBars('stock:AAPL', '1D', NOW - 30 * DAY, NOW);

  beforeEach(async () => {
    h = createDb('sqlite::memory:');
    await migrate(h.db);
    repos = createRepos(h.db);
    now = NOW;
    stock = new FakeProvider('stock', () => now, { maxLookbackMs: { '1m': 29 * DAY, '1h': 729 * DAY }, maxSpanPerRequestMs: {} }, ['AAPL']);
    crypto = new FakeProvider('crypto', () => now, undefined, ['BTC']);
    svc = make();
    await svc.symbolInfo('stock:AAPL');
  });
  afterEach(async () => { await h.close(); });

  it('nothing cached: first check just stamps (no lookup); then at most once per day (also across restarts)', async () => {
    await daily();
    expect(stock.splitsCalls).toHaveLength(0);
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW);
    now = NOW + 23 * HOUR;
    await daily();
    await make().getNativeBars('stock:AAPL', '1D', NOW - 30 * DAY, NOW); // fresh instance reads the DB stamp
    expect(stock.splitsCalls).toHaveLength(0);
    now = NOW + DAY;
    await daily();
    expect(stock.splitsCalls).toEqual([{ code: 'AAPL', since: NOW }]);
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW + DAY);
  });

  it('a split after the last check deletes the symbol bars + coverage, refetches, bumps cacheEpoch', async () => {
    await daily();
    await svc.getNativeBars('stock:AAPL', '1h', NOW - 5 * DAY, NOW);
    expect(await repos.coverage.list('stock:AAPL', '1h')).not.toEqual([]);
    const epoch = svc.cacheEpoch;
    stock.splits.AAPL = [NOW + 12 * HOUR];
    now = NOW + DAY;
    stock.calls = [];
    const r = await daily();
    expect(svc.cacheEpoch).toBe(epoch + 1);
    expect(r.bars.length).toBeGreaterThan(0);
    // historical part refetched (not only the recent span)
    expect(stock.calls.some((c) => c.tf === '1D' && c.from <= NOW - 29 * DAY)).toBe(true);
    // other timeframes were dropped too
    expect(await repos.coverage.list('stock:AAPL', '1h')).toEqual([]);
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW + DAY);
    // the same split is not acted on twice
    now = NOW + 2 * DAY;
    await daily();
    expect(svc.cacheEpoch).toBe(epoch + 1);
  });

  const bar = (ts: number, p = 100) => ({ ts, open: p, high: p + 2, low: p - 2, close: p + 1, volume: 10 });
  const neverChecked = async (updatedAt: number) => {
    await h.db.updateTable('symbols').set({ splits_checked_at: null, updated_at: updatedAt }).where('id', '=', 'stock:AAPL').execute();
  };

  it('never-checked (pre-migration) symbol: baseline is updated_at − 7 days, so old splits purge nothing', async () => {
    await neverChecked(NOW - 2 * DAY);
    await repos.bars.upsert('stock:AAPL', '1h', [bar(NOW - 800 * DAY)]);
    stock.splits.AAPL = [Date.UTC(2020, 7, 31)];
    const epoch = svc.cacheEpoch;
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(stock.splitsCalls).toEqual([{ code: 'AAPL', since: NOW - 9 * DAY }]);
    expect(svc.cacheEpoch).toBe(epoch);
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([bar(NOW - 800 * DAY)]);
  });

  it('split at X: 1D purged; intraday bars at ts ≥ X − lookback deleted (coverage trimmed), older ones rescaled', async () => {
    const X = NOW - DAY; // after the last check
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 3 * DAY }).where('id', '=', 'stock:AAPL').execute();
    const L1h = 729 * DAY;
    const L1m = 29 * DAY;
    await repos.bars.upsert('stock:AAPL', '1D', [bar(NOW - 1000 * DAY), bar(NOW - 2 * DAY)]);
    await repos.coverage.add('stock:AAPL', '1D', NOW - 1000 * DAY, NOW - DAY);
    await repos.bars.upsert('stock:AAPL', '1h', [bar(X - L1h - HOUR), bar(X - L1h), bar(X - 10 * DAY)]);
    await repos.coverage.add('stock:AAPL', '1h', X - L1h - 2 * HOUR, X - 5 * DAY);
    await repos.bars.upsert('stock:AAPL', '1m', [bar(X - L1m - 60_000), bar(X - L1m)]);
    await repos.coverage.add('stock:AAPL', '1m', X - L1m - 120_000, X - L1m + 60_000);
    await repos.bars.upsert('stock:AAPL', '5m', [bar(X - 400 * DAY)]); // no lookback limit → refetchable
    stock.splits.AAPL = [X];
    const epoch = svc.cacheEpoch;
    now = NOW + HOUR;
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(svc.cacheEpoch).toBe(epoch + 1);
    expect(await repos.bars.range('stock:AAPL', '1D', 0, NOW)).toEqual([]);
    expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([]);
    const half = { ts: X - L1h - HOUR, open: 50, high: 51, low: 49, close: 50.5, volume: 20 };
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([half]);
    expect(await repos.coverage.list('stock:AAPL', '1h')).toEqual([[X - L1h - 2 * HOUR, X - L1h]]);
    expect(await repos.bars.range('stock:AAPL', '1m', 0, NOW)).toEqual([{ ...half, ts: X - L1m - 60_000 }]);
    expect(await repos.coverage.list('stock:AAPL', '1m')).toEqual([[X - L1m - 120_000, X - L1m]]);
    expect(await repos.bars.range('stock:AAPL', '5m', 0, NOW)).toEqual([]);
  });

  it('the split invalidation and the check stamp run in one transaction', async () => {
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 3 * DAY }).where('id', '=', 'stock:AAPL').execute();
    await repos.bars.upsert('stock:AAPL', '1h', [bar(NOW - 800 * DAY), bar(NOW - 10 * DAY)]);
    stock.splits.AAPL = [NOW - DAY];
    const tx = vi.spyOn(h.db, 'transaction');
    const del = vi.spyOn(h.db, 'deleteFrom');
    const upd = vi.spyOn(h.db, 'updateTable');
    now = NOW + HOUR;
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(tx).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled(); // every delete/update went through the transaction
    expect(upd).not.toHaveBeenCalled(); // including the splits_checked_at stamp
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW + HOUR);
  });

  it('a failing stamp write rolls the whole split back; the retry rescales exactly once', async () => {
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 3 * DAY }).where('id', '=', 'stock:AAPL').execute();
    const old = bar(NOW - 800 * DAY);
    await repos.bars.upsert('stock:AAPL', '1h', [old]);
    stock.splits.AAPL = [NOW - DAY];
    await sql`create trigger fail_stamp before update of splits_checked_at on symbols begin select raise(abort, 'stamp failed'); end`.execute(h.db);
    now = NOW + HOUR;
    const epoch = svc.cacheEpoch;
    await svc.ensureSplitsChecked('stock:AAPL'); // never throws
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([old]); // rolled back: not rescaled
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW - 3 * DAY);
    expect(svc.cacheEpoch).toBe(epoch);
    await sql`drop trigger fail_stamp`.execute(h.db);
    now = NOW + 2 * HOUR; // retry window passed
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([{ ...old, open: 50, high: 51, low: 49, close: 50.5, volume: 20 }]);
    now = NOW + 4 * HOUR;
    await svc.ensureSplitsChecked('stock:AAPL'); // stamped: not checked (or applied) again today
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([{ ...old, open: 50, high: 51, low: 49, close: 50.5, volume: 20 }]);
    expect(svc.cacheEpoch).toBe(epoch + 1);
  });

  it('a future-dated split event is not applied early', async () => {
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 3 * DAY }).where('id', '=', 'stock:AAPL').execute();
    const old = bar(NOW - 800 * DAY);
    await repos.bars.upsert('stock:AAPL', '1h', [old]);
    stock.splits.AAPL = [NOW + 2 * DAY];
    const epoch = svc.cacheEpoch;
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(svc.cacheEpoch).toBe(epoch);
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([old]);
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW);
    now = NOW + 3 * DAY; // once it has happened (after the last stamp), it is applied
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(svc.cacheEpoch).toBe(epoch + 1);
  });

  it('a split reported only after a check that postdates it is still applied, exactly once', async () => {
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 10 * DAY, splits_tracked_from: NOW - 30 * DAY })
      .where('id', '=', 'stock:AAPL').execute();
    const old = bar(NOW - 800 * DAY);
    await repos.bars.upsert('stock:AAPL', '1h', [old]);
    const X = NOW - 2 * DAY;
    now = NOW; // check 1: the provider does not know the split yet
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(stock.splitsCalls.at(-1)).toEqual({ code: 'AAPL', since: NOW - 17 * DAY });
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW);
    const epoch = svc.cacheEpoch;
    stock.splits.AAPL = [X]; // reported late, dated before the last check
    now = NOW + DAY;
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(stock.splitsCalls.at(-1)).toEqual({ code: 'AAPL', since: NOW - 7 * DAY });
    expect(svc.cacheEpoch).toBe(epoch + 1);
    const halved = { ...old, open: 50, high: 51, low: 49, close: 50.5, volume: 20 };
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([halved]);
    expect(await repos.symbols.appliedSplits('stock:AAPL')).toEqual(new Set([X]));
    now = NOW + 2 * DAY; // still inside the look-back window: not applied again
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(svc.cacheEpoch).toBe(epoch + 1);
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([halved]);
  });

  it('the look-back never reaches before tracking began (splits an earlier version may have applied)', async () => {
    // Upgraded row: tracking starts at its last check (migration 005), so a split just before it is left alone.
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 2 * DAY, splits_tracked_from: NOW - 2 * DAY })
      .where('id', '=', 'stock:AAPL').execute();
    const old = bar(NOW - 800 * DAY);
    await repos.bars.upsert('stock:AAPL', '1h', [old]);
    stock.splits.AAPL = [NOW - 4 * DAY];
    const epoch = svc.cacheEpoch;
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(stock.splitsCalls.at(-1)).toEqual({ code: 'AAPL', since: NOW - 2 * DAY });
    expect(svc.cacheEpoch).toBe(epoch);
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([old]);
  });

  it('migration 005 starts tracking existing rows at their last check', async () => {
    await h.db.updateTable('symbols').set({ splits_checked_at: 123, splits_tracked_from: null }).execute();
    await h.db.deleteFrom('kysely_migration' as any).where('name' as any, '=', '005_applied_splits').execute();
    await h.db.schema.alterTable('symbols').dropColumn('splits_tracked_from').execute();
    await migrate(h.db);
    expect((await repos.symbols.get('stock:AAPL'))?.splitsTrackedFrom).toBe(123);
  });

  it('a row inserted after its bars were cached drops the refetchable bars, keeps older intraday as is', async () => {
    await h.db.deleteFrom('symbols').execute();
    const L1h = 729 * DAY;
    const oldIntraday = bar(NOW - L1h - DAY);
    await repos.bars.upsert('stock:AAPL', '1h', [oldIntraday, bar(NOW - 10 * DAY)]);
    await repos.bars.upsert('stock:AAPL', '1D', [bar(NOW - 10 * DAY)]);
    await repos.coverage.add('stock:AAPL', '1D', NOW - 20 * DAY, NOW - 5 * DAY);
    const fresh = make();
    const epoch = fresh.cacheEpoch;
    await fresh.symbolInfo('stock:AAPL');
    expect(fresh.cacheEpoch).toBe(epoch + 1);
    expect(await repos.bars.range('stock:AAPL', '1D', 0, NOW)).toEqual([]);
    expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([]);
    expect(await repos.bars.range('stock:AAPL', '1h', 0, NOW)).toEqual([oldIntraday]);
  });

  it('a new symbol whose first bars this process fetched is not purged when its row arrives', async () => {
    await h.db.deleteFrom('symbols').execute();
    const fresh = make();
    await fresh.getNativeBars('stock:AAPL', '1D', NOW - 30 * DAY, NOW); // no row yet: seen with nothing cached
    const epoch = fresh.cacheEpoch;
    await fresh.symbolInfo('stock:AAPL');
    expect(fresh.cacheEpoch).toBe(epoch);
    expect((await repos.bars.range('stock:AAPL', '1D', 0, NOW)).length).toBeGreaterThan(0);
  });

  it('reverse split (factor < 1) rescales old intraday bars up and volume down', async () => {
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 3 * DAY }).where('id', '=', 'stock:AAPL').execute();
    await repos.bars.upsert('stock:AAPL', '1h', [bar(NOW - 800 * DAY)]);
    stock.splits.AAPL = [{ ts: NOW - DAY, factor: 0.1 }]; // 1-for-10
    now = NOW + HOUR;
    await svc.ensureSplitsChecked('stock:AAPL');
    const [b] = await repos.bars.range('stock:AAPL', '1h', 0, NOW);
    expect(b!.open).toBeCloseTo(1000, 9);
    expect(b!.high).toBeCloseTo(1020, 9);
    expect(b!.low).toBeCloseTo(980, 9);
    expect(b!.close).toBeCloseTo(1010, 9);
    expect(b!.volume).toBeCloseTo(1, 9);
  });

  it('first chart of a new symbol (no row yet): the row insert stamps the check, so day 2 never uses since = 0', async () => {
    await h.db.deleteFrom('symbols').execute();
    const fresh = make();
    await fresh.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: NOW - 30 * DAY, to: NOW });
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW);
    stock.splits.AAPL = [Date.UTC(2020, 7, 31)];
    now = NOW + DAY;
    const epoch = fresh.cacheEpoch;
    await fresh.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: NOW - 30 * DAY, to: NOW });
    expect(stock.splitsCalls).toEqual([{ code: 'AAPL', since: NOW }]);
    expect(fresh.cacheEpoch).toBe(epoch);
  });

  it('no row and no bars: remembered in memory as checked now (no repeated DB lookups)', async () => {
    await h.db.deleteFrom('symbols').execute();
    const fresh = make();
    const hasAny = vi.spyOn(repos.bars, 'hasAny');
    await fresh.ensureSplitsChecked('stock:AAPL');
    await fresh.ensureSplitsChecked('stock:AAPL');
    expect(hasAny).toHaveBeenCalledTimes(1);
  });

  it('a retryable split lookup failure backs the stock queue off', async () => {
    await h.db.updateTable('symbols').set({ splits_checked_at: NOW - 3 * DAY }).where('id', '=', 'stock:AAPL').execute();
    await repos.bars.upsert('stock:AAPL', '1h', [bar(NOW - 10 * DAY)]);
    const q = (svc as unknown as { queues: { stock: { backoff(ms: number): void } } }).queues.stock;
    const spy = vi.spyOn(q, 'backoff');
    stock.splitsFail = new ProviderError('yahoo', '429', true, 429);
    await svc.ensureSplitsChecked('stock:AAPL');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a failing split lookup never fails bars and is retried no sooner than an hour later', async () => {
    await daily(); // stamps NOW
    now = NOW + DAY;
    stock.splitsFail = new ProviderError('yahoo', 'down', true);
    const r = await daily();
    expect(r.bars.length).toBeGreaterThan(0);
    expect(stock.splitsCalls).toHaveLength(1);
    now = NOW + DAY + 59 * 60_000;
    await daily();
    expect(stock.splitsCalls).toHaveLength(1);
    now = NOW + DAY + HOUR;
    await daily();
    expect(stock.splitsCalls).toHaveLength(2);
    expect((await repos.symbols.get('stock:AAPL'))?.splitsCheckedAt).toBe(NOW); // failures don't stamp
  });

  it('concurrent requests share one check; crypto is never checked; rows-less symbols are skipped', async () => {
    await daily();
    now = NOW + DAY;
    await Promise.all([daily(), daily(), svc.getNativeBars('stock:AAPL', '1h', NOW - DAY, NOW)]);
    expect(stock.splitsCalls).toHaveLength(1);
    await svc.getNativeBars('crypto:BTC', '1D', NOW - 5 * DAY, NOW);
    expect(crypto.splitsCalls).toEqual([]);
    await svc.getNativeBars('stock:MSFT', '1D', NOW - 5 * DAY, NOW);
    expect(stock.splitsCalls.map((c) => c.code)).toEqual(['AAPL']);
  });
});
