import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    stock = new FakeProvider('stock', () => now, undefined, ['AAPL']);
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

  it('never-checked symbol with cached bars: its whole history is checked once', async () => {
    await repos.bars.upsert('stock:AAPL', '1D', [{ ts: NOW - 10 * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    stock.splits.AAPL = [Date.UTC(2020, 7, 31)];
    const epoch = svc.cacheEpoch;
    await daily();
    expect(stock.splitsCalls).toEqual([{ code: 'AAPL', since: 0 }]);
    expect(svc.cacheEpoch).toBe(epoch + 1);
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
