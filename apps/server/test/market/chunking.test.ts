import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import { MarketDataService } from '../../src/market/service.js';
import { BinanceProvider } from '../../src/providers/binance.js';
import { CoinbaseProvider } from '../../src/providers/coinbase.js';
import { RequestQueue } from '../../src/providers/queue.js';
import { FakeProvider } from '../helpers/fakeProvider.js';
import { fakeFetch, jsonResponse } from '../providers/helpers.js';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 9, 18);

describe('crypto gaps are split into queue-paced, one-request chunks (item 4)', () => {
  let h: TestDb;
  let repos: Repos;
  let now: number;
  let queue: RequestQueue;

  beforeEach(async () => {
    h = await createTestDb();
    await migrate(h.db);
    repos = createRepos(h.db);
    now = NOW;
    queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, now: () => now });
  });
  afterEach(async () => { await h.close(); });

  function service(crypto: BinanceProvider | CoinbaseProvider) {
    const clock = () => now;
    return new MarketDataService({
      repos, registry: { stock: new FakeProvider('stock', clock), crypto }, now: clock,
      queues: { stock: new RequestQueue({ concurrency: 1, minIntervalMs: 0, now: clock }), crypto: queue },
    });
  }

  it('Binance: 2500 minutes → three 1000-kline jobs; a 429 keeps earlier progress and stops the rest', async () => {
    let n = 0;
    let failOn = 2;
    const f = fakeFetch((url) => {
      n++;
      if (n === failOn) return jsonResponse({ code: -1003, msg: 'Too many requests' }, 429);
      const start = Number(url.searchParams.get('startTime'));
      const end = Number(url.searchParams.get('endTime'));
      const rows = [];
      for (let t = start; t <= end && rows.length < 1000; t += MIN) rows.push([t, '1', '2', '0.5', '1.5', '3', t + MIN - 1]);
      return jsonResponse(rows);
    });
    const svc = service(new BinanceProvider({ baseUrl: 'http://binance', fetchImpl: f.impl, now: () => now }));
    const from = NOW - 5 * DAY;
    const to = from + 2500 * MIN;

    const r1 = await svc.getNativeBars('crypto:BTC', '1m', from, to);
    expect(r1.stale).toBe(true);
    // Chunk 1 ok, chunk 2 → 429 → cooldown, chunk 3 refused by the queue without an upstream request.
    expect(f.calls).toHaveLength(2);
    expect(await repos.coverage.list('crypto:BTC', '1m')).toEqual([[from, from + 1000 * MIN]]);
    expect(r1.bars).toHaveLength(1000);

    now += 31_000; // past the cooldown
    failOn = -1;
    const r2 = await svc.getNativeBars('crypto:BTC', '1m', from, to);
    expect(r2.stale).toBe(false);
    expect(r2.bars).toHaveLength(2500);
    const spans = f.calls.slice(2).map((u) => [Number(u.searchParams.get('startTime')), Number(u.searchParams.get('endTime')) + 1]);
    expect(spans).toEqual([[from + 1000 * MIN, from + 2000 * MIN], [from + 2000 * MIN, to]]);
  });

  it('Coinbase 30m (built from 5m): every upstream request asks for at most 300 candles', async () => {
    const f = fakeFetch(() => jsonResponse([]));
    const svc = service(new CoinbaseProvider({ fetchImpl: f.impl, now: () => now }));
    await svc.getNativeBars('crypto:BTC', '30m', NOW - 10 * DAY, NOW - 5 * DAY);
    expect(f.calls.length).toBe(Math.ceil((5 * DAY) / (1500 * MIN)));
    for (const u of f.calls) {
      const span = Date.parse(u.searchParams.get('end')!) + 1 - Date.parse(u.searchParams.get('start')!);
      expect(span / (5 * MIN)).toBeLessThanOrEqual(300);
    }
  });
});
