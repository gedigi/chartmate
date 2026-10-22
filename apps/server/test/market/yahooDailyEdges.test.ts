import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import { MarketDataService } from '../../src/market/service.js';
import { RequestQueue } from '../../src/providers/queue.js';
import { YahooProvider, type YahooLike } from '../../src/providers/yahoo.js';
import { FakeProvider } from '../helpers/fakeProvider.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 9, 18); // Fri 2026-10-09 14:00 EDT
const D = Date.UTC(2026, 8, 15); // Tue 2026-09-15

/** Like Yahoo: daily bars stamped at the 09:30 NY open (13:30Z in EDT), only those in [period1, period2). */
function stampedAtOpen(): { client: YahooLike; calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  const client: YahooLike = {
    async chart(_sym, opts) {
      const p1 = (opts.period1 as Date).getTime();
      const p2 = (opts.period2 as Date).getTime();
      calls.push([p1, p2]);
      const quotes = [];
      for (let day = Math.floor(p1 / DAY) * DAY; day < p2; day += DAY) {
        const dow = new Date(day).getUTCDay();
        const ts = day + 13.5 * HOUR;
        if (dow === 0 || dow === 6 || ts < p1 || ts >= p2 || ts > NOW) continue;
        const v = day / DAY;
        quotes.push({ date: new Date(ts), open: v, high: v + 1, low: v - 1, close: v, volume: 1 });
      }
      return { meta: {}, quotes };
    },
    async search() { return { quotes: [{ symbol: 'AAPL', isYahooFinance: true, quoteType: 'EQUITY', shortname: 'Apple' }] }; },
    async quote() { return []; },
    async quoteSummary() { return {}; },
  };
  return { client, calls };
}

describe('Yahoo daily bars at non-midnight range edges (I-1)', () => {
  let h: TestDb;
  let repos: Repos;
  let yahoo: ReturnType<typeof stampedAtOpen>;
  let svc: MarketDataService;

  beforeEach(async () => {
    h = await createTestDb();
    await migrate(h.db);
    repos = createRepos(h.db);
    yahoo = stampedAtOpen();
    const clock = () => NOW;
    const stock = new YahooProvider({ client: yahoo.client, now: clock });
    const crypto = new FakeProvider('crypto', clock);
    svc = new MarketDataService({
      repos, registry: { stock, crypto }, now: clock,
      queues: {
        stock: new RequestQueue({ concurrency: 1, minIntervalMs: 0, now: clock }),
        crypto: new RequestQueue({ concurrency: 1, minIntervalMs: 0, now: clock }),
      },
    });
  });
  afterEach(async () => { await h.close(); });

  it('the provider asks one day past `to` so a bar stamped at 13:30Z on the last day is included', async () => {
    const p = new YahooProvider({ client: yahoo.client, now: () => NOW });
    const res = await p.fetchBars('AAPL', '1D', D, D + DAY);
    expect(yahoo.calls).toEqual([[D, D + 2 * DAY]]);
    expect(res.bars.map((b) => b.ts)).toEqual([D]);
    // period2 never runs past now
    yahoo.calls.length = 0;
    await p.fetchBars('AAPL', '1D', NOW - 2 * DAY, NOW + DAY);
    expect(yahoo.calls[0]![1]).toBe(NOW);
  });

  it('a request starting at 10:00Z, then paging back, leaves no missing day and aligned coverage', async () => {
    const first = await svc.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: D + 10 * HOUR, to: D + 10 * DAY });
    expect(first.bars[0]!.ts).toBe(D + DAY); // D itself starts before `from`
    const back = await svc.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: D - 10 * DAY + 10 * HOUR, to: D + 10 * HOUR });
    expect(back.bars.at(-1)!.ts).toBe(D);

    const all = await svc.getNativeBars('stock:AAPL', '1D', D - 9 * DAY, D + 10 * DAY);
    const expected: number[] = [];
    for (let t = D - 9 * DAY; t < D + 10 * DAY; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) expected.push(t);
    expect(all.bars.map((b) => b.ts)).toEqual(expected);
    for (const [a, b] of await repos.coverage.list('stock:AAPL', '1D')) {
      expect(a % DAY).toBe(0);
      expect(b % DAY).toBe(0);
    }
  });
});
