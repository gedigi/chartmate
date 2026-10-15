import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nyParts } from '@chartmate/shared';
import { createDb } from '../../src/db/connect.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import { AppError, NotFoundError, ProviderError } from '../../src/errors.js';
import { RequestQueue } from '../../src/providers/queue.js';
import { FakeProvider } from '../helpers/fakeProvider.js';
import { MarketDataService, calendarFor, holdsSession } from '../../src/market/service.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const NOW = Date.UTC(2026, 10, 4, 18, 20); // Wed 2026-11-04 13:20 EST
const EDGE_1H = Date.UTC(2026, 10, 4, 16); // floor(NOW − 2h) on the 1h grid
const NEXT_1H = Date.UTC(2026, 10, 4, 19); // NOW ceiled to the 1h grid (fetch/coverage bounds are grid-aligned)
const H = (x: number) => Math.floor(x / HOUR) * HOUR;

describe('MarketDataService', () => {
  let h: ReturnType<typeof createDb>;
  let repos: Repos;
  let now: number;
  let stock: FakeProvider;
  let crypto: FakeProvider;
  let queues: { stock: RequestQueue; crypto: RequestQueue };
  let svc: MarketDataService;

  beforeEach(async () => {
    h = createDb('sqlite::memory:');
    await migrate(h.db);
    repos = createRepos(h.db);
    now = NOW;
    const clock = () => now;
    stock = new FakeProvider('stock', clock, {
      maxLookbackMs: { '1m': 29 * DAY, '1h': 729 * DAY },
      maxSpanPerRequestMs: { '1m': 7 * DAY },
    }, ['AAPL', 'BTCS', 'MSFT']);
    crypto = new FakeProvider('crypto', clock, undefined, ['BTC', 'ETH']);
    crypto.firstTs = null;
    queues = {
      stock: new RequestQueue({ concurrency: 2, minIntervalMs: 0, now: clock }),
      crypto: new RequestQueue({ concurrency: 4, minIntervalMs: 0, now: clock }),
    };
    svc = new MarketDataService({ repos, registry: { stock, crypto }, now: clock, queues });
  });
  afterEach(async () => {
    await h.close();
  });

  describe('getNativeBars caching', () => {
    it('first call fetches; identical second call only refetches the recent span', async () => {
      const from = NOW - 10 * DAY;
      const r1 = await svc.getNativeBars('crypto:BTC', '1h', from, NOW);
      expect(crypto.calls).toEqual([{ code: 'BTC', tf: '1h', from: H(from), to: NEXT_1H }]);
      expect(r1.stale).toBe(false);
      expect(r1.bars.length).toBe(240);
      // recentEdge is floored to the 1h grid: 18:20 − 2h → 16:00
      expect(await repos.coverage.list('crypto:BTC', '1h')).toEqual([[H(from), EDGE_1H]]);

      const r2 = await svc.getNativeBars('crypto:BTC', '1h', from, NOW);
      expect(crypto.calls.slice(1)).toEqual([{ code: 'BTC', tf: '1h', from: EDGE_1H, to: NEXT_1H }]);
      expect(r2.bars).toEqual(r1.bars);
    });

    it('a fully covered historical window (to ≤ recentEdge) makes no request', async () => {
      await svc.getNativeBars('crypto:BTC', '1h', NOW - 10 * DAY, NOW);
      crypto.calls = [];
      const r = await svc.getNativeBars('crypto:BTC', '1h', NOW - 5 * DAY, NOW - 3 * DAY);
      expect(crypto.calls).toEqual([]);
      expect(r.bars.length).toBe(48);
    });

    it('a window entirely inside the recent span requests only that span; never empty requests', async () => {
      await svc.getNativeBars('crypto:BTC', '1h', NOW - HOUR, NOW);
      expect(crypto.calls).toEqual([{ code: 'BTC', tf: '1h', from: H(NOW - HOUR), to: NEXT_1H }]);
      expect(await repos.coverage.list('crypto:BTC', '1h')).toEqual([]);
      for (const c of crypto.calls) expect(c.from).toBeLessThan(c.to);
    });

    it('fetches only the missing gap plus the recent span', async () => {
      await svc.getNativeBars('crypto:BTC', '1D', NOW - 20 * DAY, NOW - 10 * DAY);
      crypto.calls = [];
      await svc.getNativeBars('crypto:BTC', '1D', NOW - 30 * DAY, NOW);
      const edge = Date.UTC(2026, 10, 1); // 1D recent edge: now − 3d floored to UTC midnight
      const D0 = Date.UTC(2026, 10, 4); // NOW's UTC midnight: bounds snap to the daily grid
      expect(crypto.calls).toEqual([
        { code: 'BTC', tf: '1D', from: D0 - 30 * DAY, to: D0 - 20 * DAY },
        { code: 'BTC', tf: '1D', from: D0 - 9 * DAY, to: D0 + DAY },
      ]);
      expect(await repos.coverage.list('crypto:BTC', '1D')).toEqual([[D0 - 30 * DAY, edge]]);
    });

    it('splits gaps by maxSpanPerRequestMs and clamps `to` to now + tf', async () => {
      await svc.getNativeBars('stock:AAPL', '1m', NOW - 20 * DAY, NOW + 5 * DAY);
      expect(stock.calls.map((c) => [c.from, c.to])).toEqual([
        [NOW - 20 * DAY, NOW - 13 * DAY],
        [NOW - 13 * DAY, NOW - 6 * DAY],
        [NOW - 6 * DAY, NOW + MIN],
      ]);
    });

    it('concurrent identical getBars calls trigger one provider fetch per gap (dedupe)', async () => {
      crypto.delayMs = 5;
      const args = { symbol: 'crypto:BTC', tf: '1h' as const, session: 'eth' as const, from: NOW - 5 * DAY, to: NOW };
      const [a, b] = await Promise.all([svc.getBars(args), svc.getBars(args)]);
      expect(crypto.calls).toHaveLength(1);
      expect(a.bars).toEqual(b.bars);
      expect(a.bars.length).toBe(120);
    });
  });

  describe('staleness (Review Focus #3)', () => {
    it('retryable ProviderError after data is cached → cached bars, stale: true, no exception', async () => {
      const args = { symbol: 'crypto:BTC', tf: '1h' as const, session: 'eth' as const, from: NOW - 2 * DAY, to: NOW };
      const fresh = await svc.getBars(args);
      expect(fresh.stale).toBe(false);
      crypto.fail = new ProviderError('binance', 'HTTP 429', true, 429);
      const r = await svc.getBars(args);
      expect(r.stale).toBe(true);
      expect(r.bars).toEqual(fresh.bars);
      expect(queues.crypto.cooldownUntil).toBe(NOW + 30_000);

      // during the cooldown: no provider call, still cached + stale, cooldown not extended
      crypto.calls = [];
      now = NOW + 10_000;
      const r2 = await svc.getBars(args);
      expect(crypto.calls).toEqual([]);
      expect(r2.stale).toBe(true);
      expect(r2.bars).toEqual(fresh.bars);
      expect(queues.crypto.cooldownUntil).toBe(NOW + 30_000);
    });

    it('wider window with an uncached gap during an outage returns what is in the DB and does not mark the gap covered', async () => {
      await svc.getNativeBars('crypto:BTC', '1h', NOW - 2 * DAY, NOW);
      crypto.fail = new ProviderError('binance', 'down', false, 500);
      const r = await svc.getNativeBars('crypto:BTC', '1h', NOW - 4 * DAY, NOW);
      expect(r.stale).toBe(true);
      expect(r.bars.length).toBe(49); // the first call fetched from the grid-aligned 2d-ago 18:00 bar
      expect(queues.crypto.cooldownUntil).toBe(0); // non-retryable → no backoff
      expect(await repos.coverage.list('crypto:BTC', '1h')).toEqual([[H(NOW - 2 * DAY), EDGE_1H]]);
    });

    it('network failure (non-ProviderError) → stale, not thrown', async () => {
      crypto.fail = new TypeError('fetch failed');
      const r = await svc.getNativeBars('crypto:BTC', '1h', NOW - DAY, NOW);
      expect(r).toEqual({ bars: [], stale: true });
    });

    it('NotFoundError from provider → rejects with NotFoundError', async () => {
      stock.fail = new NotFoundError('no such symbol');
      await expect(svc.getBars({ symbol: 'stock:NOPE', tf: '1D', session: 'rth', from: NOW - 10 * DAY, to: NOW }))
        .rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('lookback limits (Review Focus #4)', () => {
    it('1m request from 60 days ago is clamped to the lookback, hasMoreBefore false, notice, no error', async () => {
      const r = await svc.getBars({ symbol: 'stock:AAPL', tf: '1m', session: 'eth', from: NOW - 60 * DAY, to: NOW - 27 * DAY });
      expect(stock.calls.length).toBeGreaterThan(0);
      for (const c of stock.calls) expect(c.from).toBeGreaterThanOrEqual(NOW - 29 * DAY);
      expect(r.bars.length).toBeGreaterThan(0);
      expect(r.bars[0]!.ts).toBeGreaterThanOrEqual(NOW - 29 * DAY);
      expect(r.hasMoreBefore).toBe(false);
      expect(r.earliestTs).toBe(NOW - 29 * DAY);
      expect(r.notices).toEqual(['Free data source limits 1m history to ~29 days.']);
      expect(r.stale).toBe(false);
    });

    it('window entirely beyond the lookback → no provider call, empty, hasMoreBefore false', async () => {
      const r = await svc.getBars({ symbol: 'stock:AAPL', tf: '1m', session: 'eth', from: NOW - 60 * DAY, to: NOW - 50 * DAY });
      expect(stock.calls).toEqual([]);
      expect(r.bars).toEqual([]);
      expect(r.hasMoreBefore).toBe(false);
      expect(r.notices).toHaveLength(1);
    });

    it('inside the lookback: hasMoreBefore true, no notice', async () => {
      const r = await svc.getBars({ symbol: 'stock:AAPL', tf: '1m', session: 'eth', from: NOW - 10 * DAY, to: NOW - 9 * DAY });
      expect(r.hasMoreBefore).toBe(true);
      expect(r.notices).toEqual([]);
    });
  });

  describe('sessions and resampling', () => {
    it('stock 4h RTH vs ETH across the 2026-11-01 DST change (Review Focus #1)', async () => {
      const from = Date.UTC(2026, 9, 29); // Thu Oct 29 (EDT)
      const to = Date.UTC(2026, 10, 4); // Wed Nov 4 (EST)
      const rth = await svc.getBars({ symbol: 'stock:AAPL', tf: '4h', session: 'rth', from, to });
      const eth = await svc.getBars({ symbol: 'stock:AAPL', tf: '4h', session: 'eth', from, to });

      expect(rth.bars.length).toBeGreaterThan(0);
      for (const b of rth.bars) {
        expect(b.session).toBe('regular');
        const p = nyParts(b.ts);
        expect([[9, 30], [13, 30]]).toContainEqual([p.hh, p.mm]);
      }
      const day = (y: number, m: number, d: number) => rth.bars.filter((b) => b.ts >= Date.UTC(y, m, d) && b.ts < Date.UTC(y, m, d + 1)).map((b) => b.ts);
      // EDT (UTC-4): 09:30 NY = 13:30Z
      expect(day(2026, 9, 30)).toEqual([Date.UTC(2026, 9, 30, 13, 30), Date.UTC(2026, 9, 30, 17, 30)]);
      // EST (UTC-5): 09:30 NY = 14:30Z
      expect(day(2026, 10, 2)).toEqual([Date.UTC(2026, 10, 2, 14, 30), Date.UTC(2026, 10, 2, 18, 30)]);
      // afternoon RTH bucket = 13:30, 14:30, 15:30 only (no post-market bar)
      const pm = rth.bars.find((b) => b.ts === Date.UTC(2026, 10, 2, 18, 30))!;
      expect(pm.volume).toBe(3);

      // ETH buckets anchored at 04:00 NY; the 08:00 bucket mixes pre + regular
      const ethDay = eth.bars.filter((b) => b.ts >= Date.UTC(2026, 9, 30) && b.ts < Date.UTC(2026, 9, 31));
      expect(ethDay.map((b) => b.ts)).toEqual([
        Date.UTC(2026, 9, 30, 8), Date.UTC(2026, 9, 30, 12), Date.UTC(2026, 9, 30, 16), Date.UTC(2026, 9, 30, 20),
      ]);
      expect(ethDay[0]!.session).toBe('pre');
      expect(ethDay[1]!.session).toBeUndefined();
      const ethNov2 = eth.bars.filter((b) => b.ts >= Date.UTC(2026, 10, 2) && b.ts < Date.UTC(2026, 10, 3));
      expect(ethNov2[0]!.ts).toBe(Date.UTC(2026, 10, 2, 9)); // 04:00 EST
    });

    it('1W is built from daily with Monday timestamps; 1M with 1st-of-month timestamps', async () => {
      const from = Date.UTC(2026, 6, 1);
      const to = Date.UTC(2026, 9, 1);
      const w = await svc.getBars({ symbol: 'crypto:BTC', tf: '1W', session: 'eth', from, to });
      expect(crypto.calls.every((c) => c.tf === '1D')).toBe(true);
      expect(w.bars.length).toBeGreaterThan(10);
      for (const b of w.bars) expect(new Date(b.ts).getUTCDay()).toBe(1);
      const full = w.bars[1]!;
      expect(full.volume).toBe(7);
      const daily = await svc.getNativeBars('crypto:BTC', '1D', full.ts, full.ts + 7 * DAY);
      expect(full.open).toBe(daily.bars[0]!.open);
      expect(full.close).toBe(daily.bars[6]!.close);

      const m = await svc.getBars({ symbol: 'stock:AAPL', tf: '1M', session: 'rth', from, to });
      expect(m.bars.map((b) => b.ts)).toEqual([Date.UTC(2026, 6, 1), Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)]);
      expect(m.bars[0]!.volume).toBe(23); // weekdays in July 2026
    });

    it('a resampled bucket ending after `to` is completed from natives beyond `to`', async () => {
      const r = await svc.getBars({ symbol: 'crypto:BTC', tf: '4h', session: 'eth', from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 1, 5) });
      expect(r.bars.map((b) => [b.ts, b.volume])).toEqual([[Date.UTC(2026, 9, 1), 4], [Date.UTC(2026, 9, 1, 4), 4]]);
    });
  });

  describe('getLatest', () => {
    it('returns the newest bar of a derived 2h timeframe', async () => {
      const r = await svc.getLatest('crypto:BTC', '2h', 'eth');
      expect(r.stale).toBe(false);
      expect(r.bar?.ts).toBe(Date.UTC(2026, 10, 4, 18));
      expect(r.bar?.volume).toBe(1); // only the 18:00 hourly bar exists so far
      for (const c of crypto.calls) expect(c.from).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 4, 16));
    });
    it('null when nothing exists', async () => {
      crypto.fail = new ProviderError('x', 'down', true);
      expect(await svc.getLatest('crypto:BTC', '1h', 'eth')).toEqual({ bar: null, stale: true });
    });
  });

  describe('symbols', () => {
    it('symbolInfo fetches via search + firstBarTs, persists, then serves from the repo', async () => {
      const info = await svc.symbolInfo('stock:AAPL');
      expect(info).toEqual(stock.info('AAPL'));
      expect((await repos.symbols.get('stock:AAPL'))?.firstTs).toBe(Date.UTC(2000, 0, 1));
      stock.searchCalls = [];
      expect(await svc.symbolInfo('stock:AAPL')).toEqual(info);
      expect(stock.searchCalls).toEqual([]);
    });
    it('symbolInfo: no exact match → NotFoundError; basket → 400', async () => {
      await expect(svc.symbolInfo('stock:AAP')).rejects.toBeInstanceOf(NotFoundError);
      await expect(svc.symbolInfo('basket:abc')).rejects.toMatchObject({ status: 400, code: 'invalid_symbol' });
      await expect(svc.getBars({ symbol: 'basket:abc', tf: '1D', session: 'rth', from: 0, to: 1 })).rejects.toBeInstanceOf(AppError);
    });
    it('symbolInfo refreshes rows older than 7 days; uses the stale row on failure', async () => {
      await repos.symbols.upsert({ id: 'stock:AAPL', name: 'Old', exchange: null, pricePrecision: 2, firstTs: null, updatedAt: NOW - 8 * DAY });
      stock.searchFail = new ProviderError('yahoo', 'down', true);
      expect((await svc.symbolInfo('stock:AAPL')).name).toBe('Old');
      stock.searchFail = null;
      now = NOW + HOUR;
      expect((await svc.symbolInfo('stock:AAPL')).name).toBe('AAPL Inc');
      expect((await repos.symbols.get('stock:AAPL'))?.updatedAt).toBe(NOW + HOUR);
    });
    it('a failed refresh of a stale row is retried no sooner than an hour later', async () => {
      await repos.symbols.upsert({ id: 'stock:AAPL', name: 'Old', exchange: null, pricePrecision: 2, firstTs: null, updatedAt: NOW - 8 * DAY });
      stock.searchFail = new ProviderError('yahoo', 'down', true);
      expect((await svc.symbolInfo('stock:AAPL')).name).toBe('Old');
      expect(stock.searchCalls).toHaveLength(1);
      now = NOW + HOUR - 1;
      expect((await svc.symbolInfo('stock:AAPL')).name).toBe('Old');
      await svc.earliest('stock:AAPL', '1D');
      expect(stock.searchCalls).toHaveLength(1);
      now = NOW + HOUR;
      expect((await svc.symbolInfo('stock:AAPL')).name).toBe('Old');
      expect(stock.searchCalls).toHaveLength(2);
    });
    it('earliest = max(firstTs, now − lookback)', async () => {
      expect(await svc.earliest('stock:AAPL', '1m')).toBe(NOW - 29 * DAY);
      expect(await svc.earliest('stock:AAPL', '1D')).toBe(Date.UTC(2000, 0, 1));
      expect(await svc.earliest('stock:AAPL', '4h')).toBe(NOW - 729 * DAY);
      expect(await svc.earliest('crypto:BTC', '1D')).toBeNull();
    });
    it('getBars without lookback/firstTs: hasMoreBefore = bars.length > 0', async () => {
      const r = await svc.getBars({ symbol: 'crypto:BTC', tf: '1D', session: 'eth', from: NOW - 5 * DAY, to: NOW });
      expect(r.earliestTs).toBeNull();
      expect(r.hasMoreBefore).toBe(true);
    });
    it('earliest/getBars survive a symbol lookup failure', async () => {
      stock.searchFail = new ProviderError('yahoo', 'down', true);
      const r = await svc.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: NOW - 5 * DAY, to: NOW });
      expect(r.earliestTs).toBeNull();
      expect(r.bars.length).toBeGreaterThan(0);
    });
  });

  describe('search and quotes', () => {
    it('merges stocks and crypto; crypto first on exact base match', async () => {
      expect((await svc.search('BTC')).map((s) => s.id)).toEqual(['crypto:BTC', 'stock:BTCS']);
      expect((await svc.search('A')).map((s) => s.id)).toEqual(['stock:AAPL']);
      expect((await svc.search('T')).map((s) => s.id)).toEqual(['stock:BTCS', 'stock:MSFT', 'crypto:BTC', 'crypto:ETH']);
    });
    it('one side failing returns the other; both failing throws ProviderError', async () => {
      stock.searchFail = new ProviderError('yahoo', 'down', true);
      expect((await svc.search('BTC')).map((s) => s.id)).toEqual(['crypto:BTC']);
      crypto.searchFail = new ProviderError('binance', 'down', true);
      await expect(svc.search('BTC')).rejects.toBeInstanceOf(ProviderError);
    });
    it('quotes are grouped by asset class; a failing class yields nothing; unknown ids absent', async () => {
      const q = await svc.quotes(['stock:AAPL', 'crypto:BTC', 'stock:ZZZ', 'basket:x', 'crypto:ETH']);
      expect(q.map((x) => x.id).sort()).toEqual(['crypto:BTC', 'crypto:ETH', 'stock:AAPL']);
      expect(stock.quoteCalls).toEqual([['AAPL', 'ZZZ']]);
      expect(crypto.quoteCalls).toEqual([['BTC', 'ETH']]);
      stock.fail = new ProviderError('yahoo', 'down', true);
      expect((await svc.quotes(['stock:AAPL', 'crypto:BTC'])).map((x) => x.id)).toEqual(['crypto:BTC']);
    });
  });

  describe('review fixes', () => {
    it('known symbol: provider NotFound for a pre-listing window → [] (no error), covered; later windows work', async () => {
      stock.noDataBefore = Date.UTC(2020, 0, 1);
      const early = await svc.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: Date.UTC(2015, 0, 1), to: Date.UTC(2016, 0, 1) });
      expect(early.bars).toEqual([]);
      expect(early.stale).toBe(false);
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([[Date.UTC(2015, 0, 1), Date.UTC(2016, 0, 1)]]);
      stock.calls = [];
      await svc.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: Date.UTC(2015, 0, 1), to: Date.UTC(2016, 0, 1) });
      expect(stock.calls).toEqual([]); // the empty window is cached
      const later = await svc.getBars({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', from: Date.UTC(2021, 0, 1), to: Date.UTC(2021, 1, 1) });
      expect(later.bars.length).toBe(21); // weekdays in Jan 2021 (fake has no holidays)
      expect(later.stale).toBe(false);
    });

    it('symbol known from cached bars: NotFound chunk is empty even if symbol lookup is down', async () => {
      await svc.getNativeBars('stock:MSFT', '1D', Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 10));
      stock.searchFail = new ProviderError('yahoo', 'down', true);
      stock.noDataBefore = Date.UTC(2021, 0, 1);
      const r = await svc.getNativeBars('stock:MSFT', '1D', Date.UTC(2020, 0, 1), Date.UTC(2020, 2, 1));
      expect(r).toEqual({ bars: [], stale: false });
    });

    it('NotFound chunk while symbol lookup is down and nothing cached → stale, not 404, not covered', async () => {
      stock.searchFail = new ProviderError('yahoo', 'down', true);
      stock.noDataBefore = Date.UTC(2021, 0, 1);
      const r = await svc.getNativeBars('stock:MSFT', '1D', Date.UTC(2020, 0, 1), Date.UTC(2020, 2, 1));
      expect(r).toEqual({ bars: [], stale: true });
      expect(await repos.coverage.list('stock:MSFT', '1D')).toEqual([]);
    });

    it('unknown symbol: provider NotFound still rejects with NotFoundError', async () => {
      stock.noDataBefore = Infinity;
      await expect(svc.getBars({ symbol: 'stock:NOPE', tf: '1D', session: 'rth', from: NOW - 10 * DAY, to: NOW }))
        .rejects.toBeInstanceOf(NotFoundError);
    });

    it('dedupe keys are stable when concurrent calls see clocks a few ms apart within one bar', async () => {
      crypto.delayMs = 5;
      const args = { symbol: 'crypto:BTC', tf: '1m' as const, session: 'eth' as const, from: NOW - HOUR, to: NOW + HOUR };
      const pa = svc.getBars(args);
      now = NOW + 7; // same 1m bar
      const pb = svc.getBars(args);
      now = NOW + 12;
      const pc = svc.getBars(args);
      const [a, b, c] = await Promise.all([pa, pb, pc]);
      expect(crypto.calls).toEqual([{ code: 'BTC', tf: '1m', from: NOW - HOUR, to: NOW + MIN }]);
      expect(a.bars).toEqual(b.bars);
      expect(b.bars).toEqual(c.bars);
    });

    it('failed firstBarTs lookup: row is stored but refreshed within the hour', async () => {
      stock.fail = new ProviderError('yahoo', 'down', true); // fake firstBarTs throws `fail`
      await svc.symbolInfo('stock:AAPL');
      const row = await repos.symbols.get('stock:AAPL');
      expect(row?.firstTs).toBeNull();
      expect(row!.updatedAt + 7 * DAY - NOW).toBe(HOUR); // expires one hour from now
      stock.fail = null;
      stock.searchCalls = [];
      now = NOW + 30 * MIN;
      await svc.symbolInfo('stock:AAPL');
      expect(stock.searchCalls).toEqual([]); // still fresh
      now = NOW + HOUR;
      await svc.symbolInfo('stock:AAPL');
      expect(stock.searchCalls).toEqual(['AAPL']);
      expect((await repos.symbols.get('stock:AAPL'))?.firstTs).toBe(Date.UTC(2000, 0, 1));
      expect((await repos.symbols.get('stock:AAPL'))?.updatedAt).toBe(NOW + HOUR);
    });

    it('a provider that legitimately reports no listing date keeps the full TTL', async () => {
      await svc.symbolInfo('crypto:BTC'); // crypto fake firstTs = null, no failure
      expect((await repos.symbols.get('crypto:BTC'))?.updatedAt).toBe(NOW);
    });

    it('unknown ids are negatively cached for 10 minutes (symbolInfo, earliest, getBars, getLatest)', async () => {
      await expect(svc.symbolInfo('stock:ZZZZ')).rejects.toBeInstanceOf(NotFoundError);
      expect(stock.searchCalls).toEqual(['ZZZZ']);
      await expect(svc.symbolInfo('stock:ZZZZ')).rejects.toBeInstanceOf(NotFoundError);
      expect(await svc.earliest('stock:ZZZZ', '1D')).toBeNull();
      await svc.getBars({ symbol: 'stock:ZZZZ', tf: '1D', session: 'rth', from: NOW - 5 * DAY, to: NOW });
      await svc.getLatest('stock:ZZZZ', '1h', 'rth');
      expect(stock.searchCalls).toEqual(['ZZZZ']);
      now = NOW + 10 * 60_000;
      await expect(svc.symbolInfo('stock:ZZZZ')).rejects.toBeInstanceOf(NotFoundError);
      expect(stock.searchCalls).toEqual(['ZZZZ', 'ZZZZ']);
    });

    it('the negative cache is capped at 1000 entries, evicting the oldest', async () => {
      for (let i = 0; i < 1005; i++) await expect(svc.symbolInfo(`stock:Z${i}`)).rejects.toBeInstanceOf(NotFoundError);
      const map = (svc as unknown as { unknownUntil: Map<string, number> }).unknownUntil;
      expect(map.size).toBe(1000);
      expect(map.has('stock:Z0')).toBe(false);
      expect(map.has('stock:Z1004')).toBe(true);
    });
  });

  describe('minor fixes (S6)', () => {
    it('symbolInfo skips the listing-date lookup when the search finds no match (queue-serialized case)', async () => {
      const clock = () => now;
      const one = new MarketDataService({
        repos, registry: { stock, crypto }, now: clock,
        queues: { stock: new RequestQueue({ concurrency: 1, minIntervalMs: 0, now: clock }), crypto: queues.crypto },
      });
      await expect(one.symbolInfo('stock:ZZZZ')).rejects.toBeInstanceOf(NotFoundError);
      expect(stock.firstCalls).toEqual([]);
    });

    it('symbolInfo runs the search and the listing-date lookup in parallel', async () => {
      let release!: () => void;
      stock.searchGate = new Promise<void>((r) => { release = r; });
      const p = svc.symbolInfo('stock:AAPL');
      await new Promise((r) => setTimeout(r, 5));
      expect(stock.firstCalls).toEqual(['AAPL']); // started while search is still pending
      release();
      expect((await p).id).toBe('stock:AAPL');
      expect((await repos.symbols.get('stock:AAPL'))?.firstTs).toBe(Date.UTC(2000, 0, 1));
    });

    it('symbolInfo ticker comes from the provider match (persisted for cached reads)', async () => {
      const orig = stock.info.bind(stock);
      stock.info = (t: string) => ({ ...orig(t), ticker: `${t}.X` });
      expect((await svc.symbolInfo('stock:AAPL')).ticker).toBe('AAPL.X');
      stock.searchCalls = [];
      expect((await svc.symbolInfo('stock:AAPL')).ticker).toBe('AAPL.X');
      expect(stock.searchCalls).toEqual([]);
    });

    it('a retryable failure triggers exactly one queue backoff', async () => {
      const q = queues.stock;
      let n = 0;
      const orig = q.backoff.bind(q);
      q.backoff = (ms: number) => { n++; orig(ms); };
      stock.fail = new ProviderError('yahoo', 'down', true);
      const r = await svc.getNativeBars('stock:AAPL', '1D', NOW - 20 * DAY, NOW - 10 * DAY);
      expect(r.stale).toBe(true);
      expect(n).toBe(1);
    });

    it('NotFound chunk ending within the last 7 days (after firstTs) is stale and NOT covered', async () => {
      await svc.symbolInfo('stock:AAPL'); // firstTs 2000-01-01
      stock.noDataBefore = NOW; // transient "no data" for anything ending before now
      const r = await svc.getNativeBars('stock:AAPL', '1D', NOW - 6 * DAY, NOW - 4 * DAY);
      expect(r).toEqual({ bars: [], stale: true });
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([]);
      stock.noDataBefore = -Infinity;
      stock.calls = [];
      const again = await svc.getNativeBars('stock:AAPL', '1D', NOW - 6 * DAY, NOW - 4 * DAY);
      expect(stock.calls).toHaveLength(1); // the hole is retried
      expect(again.bars.length).toBeGreaterThan(0);
    });

    it('NotFound for the recent tail only (above recentEdge): not stale, not covered (as before)', async () => {
      await svc.symbolInfo('stock:AAPL');
      stock.noDataBefore = NOW + 2 * DAY; // every request answers "no data"
      const r = await svc.getNativeBars('stock:AAPL', '1D', NOW - 2 * DAY, NOW);
      expect(r).toEqual({ bars: [], stale: false });
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([]);
    });

    it('NotFound chunk spanning recentEdge: only the part below it is judged (old part covered, tail ignored)', async () => {
      await svc.symbolInfo('stock:AAPL');
      stock.noDataBefore = NOW + 2 * DAY;
      const from = Math.floor((NOW - 30 * DAY) / DAY) * DAY;
      // one merged chunk [from, now+1d): below recentEdge it ends at NOW - 3d (recent: < 7 d) -> stale, uncovered
      const r = await svc.getNativeBars('stock:AAPL', '1D', from, NOW);
      expect(r.stale).toBe(true);
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([]);
    });

    it('NotFound chunk ending more than 7 days ago is covered (not stale)', async () => {
      await svc.symbolInfo('stock:AAPL');
      stock.noDataBefore = NOW;
      const from = Math.floor((NOW - 20 * DAY) / DAY) * DAY;
      const to = Math.floor((NOW - 8 * DAY) / DAY) * DAY;
      const r = await svc.getNativeBars('stock:AAPL', '1D', from, to);
      expect(r).toEqual({ bars: [], stale: false });
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([[from, to]]);
    });

    it('an empty successful chunk with a recent weekday session is not covered (asked again), not stale', async () => {
      await svc.symbolInfo('stock:AAPL');
      stock.listedFrom.AAPL = NOW + 10 * DAY; // the provider answers with no bars, no error
      const from = Math.floor((NOW - 6 * DAY) / DAY) * DAY;
      const to = Math.floor((NOW - 4 * DAY) / DAY) * DAY; // Thu + Fri
      const r = await svc.getNativeBars('stock:AAPL', '1D', from, to);
      expect(r).toEqual({ bars: [], stale: false });
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([]);
      delete stock.listedFrom.AAPL;
      stock.calls = [];
      const again = await svc.getNativeBars('stock:AAPL', '1D', from, to);
      expect(stock.calls).toHaveLength(1);
      expect(again.bars.length).toBe(2);
    });

    it('empty successful chunks are covered when older than 7 days, pre-listing, or holding no session', async () => {
      stock.firstTs = Math.floor((NOW - 2 * DAY) / DAY) * DAY;
      await svc.symbolInfo('stock:AAPL');
      stock.listedFrom.AAPL = NOW + 10 * DAY;
      const old: [number, number] = [Math.floor((NOW - 20 * DAY) / DAY) * DAY, Math.floor((NOW - 8 * DAY) / DAY) * DAY];
      await svc.getNativeBars('stock:AAPL', '1D', old[0], old[1]);
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([old]);
      const preListing: [number, number] = [Math.floor((NOW - 6 * DAY) / DAY) * DAY, Math.floor((NOW - 4 * DAY) / DAY) * DAY];
      await svc.getNativeBars('stock:AAPL', '1D', preListing[0], preListing[1]);
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([old, preListing]);
      // MSFT (no listing date in the window): a weekend is no session, so its emptiness is trusted.
      stock.firstTs = null;
      stock.listedFrom.MSFT = NOW + 10 * DAY;
      const sat = Date.UTC(2026, 9, 31); // Sat 2026-10-31
      await svc.getNativeBars('stock:MSFT', '1D', sat, sat + DAY); // recentEdge is Sun 11-01
      expect(await repos.coverage.list('stock:MSFT', '1D')).toEqual([[sat, sat + DAY]]);
    });

    it('NotFound chunk ending before the known listing date (pre-listing) is covered even if recent', async () => {
      stock.firstTs = Math.floor((NOW - 2 * DAY) / DAY) * DAY; // listed two days ago
      await svc.symbolInfo('stock:AAPL');
      stock.noDataBefore = NOW;
      const from = Math.floor((NOW - 6 * DAY) / DAY) * DAY;
      const to = Math.floor((NOW - 4 * DAY) / DAY) * DAY;
      const r = await svc.getNativeBars('stock:AAPL', '1D', from, to);
      expect(r).toEqual({ bars: [], stale: false });
      expect(await repos.coverage.list('stock:AAPL', '1D')).toEqual([[from, to]]);
    });
  });

  it('holdsSession: crypto always; stocks on weekdays (daily) or a weekday 04:00–20:00 NY (intraday)', () => {
    const sat = Date.UTC(2026, 9, 31);
    const mon = Date.UTC(2026, 10, 2);
    expect(holdsSession('crypto', '1h', sat, sat + HOUR)).toBe(true);
    expect(holdsSession('stock', '1D', sat, mon)).toBe(false);
    expect(holdsSession('stock', '1D', sat, mon + DAY)).toBe(true);
    expect(holdsSession('stock', '1h', mon + 2 * HOUR, mon + 8 * HOUR)).toBe(false); // Sun 21:00 – Mon 03:00 NY
    expect(holdsSession('stock', '1h', mon + 2 * HOUR, mon + 10 * HOUR)).toBe(true); // reaches Mon 04:00 NY
    expect(holdsSession('stock', '1m', mon, mon)).toBe(false);
  });

  it('calendarFor', () => {
    expect(calendarFor('crypto:BTC', 'rth')).toBe('utc');
    expect(calendarFor('stock:AAPL', 'rth')).toBe('nyse-rth');
    expect(calendarFor('stock:AAPL', 'eth')).toBe('nyse-eth');
  });
});
